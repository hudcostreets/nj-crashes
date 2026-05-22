import pandas as pd
from dataclasses import dataclass
from functools import cached_property
from os.path import exists
from utz import err

from nj_crashes.utils import TZ
from njsp.crash_log import feed_snapshot
from njsp.crashes import load
from njsp.fauqstats import FAUQStats
from njsp.paths import fauqstats_relpath
from njsp.rundate import Rundate


def get_all_days():
    all_days = pd.DataFrame([
        dict(Days=days, Text=(pd.to_datetime(f'{2022}') + pd.Timedelta(days=days-1)).strftime('%b %-d'))
        for days in range(1, 366)
    ]).set_index('Days')
    return all_days


def normalized_ytd_days(dt):
    """Combine 2/29 and 2/28, count YTD days as if in non-leap years."""
    days = int((dt - pd.to_datetime(f'{dt.year}').tz_localize(dt.tz)).days + 1)
    if dt.year % 4 == 0 and dt.month >= 3:
        days -= 1
    return days


def fill_all_days(df, rundate: Rundate):
    year = df.name
    all_days = get_all_days()
    df = df.set_index('Days').merge(
        all_days,
        left_index=True,
        right_index=True,
        how='right',
    )
    rundate_ytd_days = normalized_ytd_days(rundate.cur)
    if year == rundate.year:
        df = df[df.index < rundate_ytd_days]
    df['YTD Deaths'] = df['YTD Deaths'].ffill().fillna(0).astype(int)
    return df


def projected_roy_deaths(prv_ytd, prv_end, cur_ytd, cur_ytd_frac):
    prv_roy = prv_end - prv_ytd
    if prv_ytd == 0:
        # (p_roy + c_ytd - p_ytd) * (1-f)
        cur_roy_frac = 1 - cur_ytd_frac
        return (prv_roy + cur_ytd) * cur_roy_frac
    else:
        return prv_roy * (1 + cur_ytd_frac * (cur_ytd / prv_ytd - 1))


@dataclass
class Ytd:
    county: str = None
    type: str = None

    @cached_property
    def rundate(self) -> Rundate:
        return Rundate()

    @cached_property
    def crashes(self):
        crashes = load()
        if self.county:
            crashes = crashes[crashes.COUNTY == self.county]
        if self.type:
            crashes = crashes[crashes.TYPE == self.type]
        return crashes

    @cached_property
    def ytds(self):
        ytds = self.crashes[['dt', 'tk']].copy()
        ytds['Year'] = ytds.dt.dt.year
        ytds['Days'] = ytds.dt.apply(normalized_ytd_days)
        ytds = (
            ytds
            .groupby('Year')
            .apply(lambda df: (
                df.assign(**{
                    'YTD Deaths': df.tk.cumsum().astype(int)
                })
            ), include_groups=False)
            .reset_index()
        )
        ytds = (
            ytds[['Year', 'Days', 'YTD Deaths']]
            .groupby(['Year', 'Days'])
            .max()
            .reset_index()
        )

        ytds = ytds.groupby('Year').apply(fill_all_days, rundate=self.rundate, include_groups=False).reset_index()
        return ytds

    @property
    def prv_year(self):
        return self.cur_year - 1

    @property
    def cur_year(self):
        return self.rundate.year

    @cached_property
    def prv_feed_snapshot(self):
        """Previous year's fatal-crash feed as it stood ~365 days ago,
        reconstructed from `crash-log.parquet` — see `feed_snapshot`. Used to
        compare this year's YTD against last year's *equally-incomplete* YTD,
        cancelling NJSP reporting lag."""
        target = f'{self.prv_year}-{self.rundate.cur.strftime("%m-%d")}'
        return feed_snapshot(self.prv_year, target)

    @cached_property
    def prv_rundate(self):
        return self.prv_feed_snapshot.rundate

    @cached_property
    def prv_ytd_crashes(self):
        return self.prv_feed_snapshot.crashes

    @cached_property
    def prv_ytd_total(self):
        """Number of deaths NJSP had reported for the previous year as of ~365 days ago."""
        return int(self.prv_feed_snapshot.crashes.FATALITIES.sum())

    @cached_property
    def cur_ytd_fauqstats(self):
        path = fauqstats_relpath(self.cur_year)
        if not exists(path):
            # Current year file not yet published (e.g., at the start of a new year)
            err(f"FAUQStats file not found for {self.cur_year}, returning empty FAUQStats")
            # Create empty DataFrame with expected schema
            empty_crashes = pd.DataFrame({
                'CCODE': pd.Series([], dtype='object'),
                'CNAME': pd.Series([], dtype='object'),
                'MCODE': pd.Series([], dtype='object'),
                'MNAME': pd.Series([], dtype='object'),
                'HIGHWAY': pd.Series([], dtype='object'),
                'LOCATION': pd.Series([], dtype='object'),
                'FATALITIES': pd.Series([], dtype='float64'),
                'FATAL_D': pd.Series([], dtype='float64'),
                'FATAL_P': pd.Series([], dtype='float64'),
                'FATAL_T': pd.Series([], dtype='float64'),
                'FATAL_B': pd.Series([], dtype='float64'),
                'STREET': pd.Series([], dtype='object'),
                'INJURIES': pd.Series([], dtype='float64'),
                'dt': pd.Series([], dtype='datetime64[ns, US/Eastern]'),
            })
            empty_crashes.index.name = 'ACCID'
            return FAUQStats(
                year=self.cur_year,
                rundate=str(self.rundate.cur),
                crashes=empty_crashes,
                totals=pd.DataFrame([dict(year=self.cur_year, accidents=0, injuries=0, fatalities=0)])
            )
        return FAUQStats.load(path)

    @cached_property
    def prv_end_crashes(self):
        return FAUQStats.load(fauqstats_relpath(self.prv_year)).crashes

    @cached_property
    def cur_ytd_crashes(self):
        return self.cur_ytd_fauqstats.crashes

    @property
    def prv_rundate_dt(self):
        dt = pd.to_datetime(self.prv_rundate)
        return dt if dt.tz else dt.tz_localize(TZ)

    @property
    def cur_year_frac(self):
        rundate = self.rundate
        cur_year_dt = rundate.cur_year_dt
        return (rundate.cur - cur_year_dt) / (rundate.nxt_year_dt - cur_year_dt)

    @property
    def prv_year_frac(self):
        rundate = self.rundate
        prv_year_dt = rundate.prv_year_dt
        return (self.prv_rundate_dt - prv_year_dt) / (rundate.cur_year_dt - prv_year_dt)

    @cached_property
    def cur_ytd_deaths(self):
        ytds = self.ytds
        cur_ytds = ytds[ytds.Year == self.cur_year]
        return 0 if cur_ytds.empty else cur_ytds.iloc[-1]['YTD Deaths']

    @property
    def cur_roy_frac(self):
        return 1 - self.cur_year_frac

    @cached_property
    def prv_ytds(self):
        ytds = self.ytds
        return ytds[ytds.Year == self.prv_year]

    @property
    def prv_end_deaths(self):
        return self.prv_ytds.iloc[-1]['YTD Deaths']

    @cached_property
    def prv_ytd_deaths(self):
        """Adjust death count from previous year by relative ytd fraction of current year vs. previous."""
        return self.prv_ytd_total * self.cur_year_frac / self.prv_year_frac

    @cached_property
    def projected_roy_deaths(self):
        return projected_roy_deaths(self.prv_ytd_deaths, self.prv_end_deaths, self.cur_ytd_deaths, self.cur_year_frac)

    @cached_property
    def projected_year_total(self):
        return self.cur_ytd_deaths + self.projected_roy_deaths

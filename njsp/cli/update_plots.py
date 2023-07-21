#!/usr/bin/env python

import plotly.express as px
import plotly.graph_objects as go
from utz import *
from utz import plots
from utz.colors import colors_lengthen, swatches

from nj_crashes.colors import get_colors, gridcolor, px_colors
from nj_crashes.paths import PLOTS_DIR, RUNDATE_PATH, DB_URI
from nj_crashes.utils import normalized_ytd_days
from njsp.cli.base import command

save = partial(plots.save, bg='white')


@command
def update_plots():
    totals = read_sql_table("totals", DB_URI).set_index('year')
    crashes = read_sql_table("crashes", DB_URI)

    print(totals)
    print(crashes)

    with open(RUNDATE_PATH, 'r') as f:
        rundate = to_dt(json.load(f)['rundate'])

    rundate_ytd_days = normalized_ytd_days(rundate)
    rundate_str = rundate.strftime('%Y-%m-%d')
    cur_month = rundate.strftime('%Y-%m')
    cur_month_dt = to_dt(cur_month).tz_localize(rundate.tz)
    cur_year = cur_month_dt.year
    cur_year_dt = to_dt(f'{cur_year}').tz_localize(rundate.tz)
    nxt_year_dt = to_dt(f'{cur_year + 1}').tz_localize(rundate.tz)
    print(rundate)
    print(cur_month_dt)
    print(cur_year_dt)
    print(nxt_year_dt)

    # ## YTD Calculations
    all_days = pd.DataFrame([
        dict(Days=days, Text=(to_dt(f'{2022}') + pd.Timedelta(days=days-1)).strftime('%b %-d'))
        for days in range(1, 366)
    ]).set_index('Days')
    print(all_days)

    def fill_all_days(df):
        df = df.set_index('Days').merge(
            all_days,
            left_index=True,
            right_index=True,
            how='right',
        )
        years = df.Year.dropna().unique()
        if len(years) > 1:
            raise ValueError(f"Years: {years}")
        [year] = years
        if year == rundate.year:
            df = df[df.index < rundate_ytd_days]
        df = df.drop(columns='Year')
        df['YTD Deaths'] = df['YTD Deaths'].fillna(method='ffill').fillna(0).astype(int)
        return df

    ytds = crashes[['dt', 'FATALITIES']].copy()
    ytds['Year'] = ytds.dt.dt.year
    ytds['Days'] = ytds.dt.apply(normalized_ytd_days)
    ytds = (
        ytds
        .groupby('Year', group_keys=False)
        .apply(lambda df: (
            df.assign(**{
                'YTD Deaths': df.FATALITIES.cumsum().astype(int)
            })
        ))
    )
    ytds = (
        ytds[['Year', 'Days', 'YTD Deaths']]
        .groupby(['Year', 'Days'])
        .max()
        .reset_index()
    )

    ytds = ytds.groupby('Year').apply(fill_all_days).reset_index()
    print(ytds)

    cur_ytds = ytds[ytds.Year == rundate.year]
    cur_ytd_deaths = 0 if cur_ytds.empty else cur_ytds.iloc[-1]['YTD Deaths']

    prv_ytd = ytds[ytds.Year == rundate.year - 1]
    prv_end_deaths = prv_ytd.iloc[-1]['YTD Deaths']
    prv_ytd_deaths = prv_ytd[prv_ytd.Days == rundate_ytd_days].iloc[-1]['YTD Deaths']
    prv_roy_ratio = prv_end_deaths / prv_ytd_deaths

    projected_records_total = int(cur_ytd_deaths * prv_roy_ratio)
    prv_ytd_ratio = cur_ytd_deaths / prv_ytd_deaths
    pct_change = (prv_ytd_ratio - 1) * 100

    print(f'Current YTD Deaths ({rundate_str}): {cur_ytd_deaths}')
    print(f'Previous year YTD Deaths ({rundate_str}): {prv_ytd_deaths}')
    print(f'Projected {rundate.year} total: {projected_records_total}')
    print(f'{pct_change:.1f}% change')

    print(projected_records_total, cur_ytd_deaths, prv_ytd_deaths, prv_roy_ratio)

    rundate_year_frac = (rundate - cur_year_dt) / (nxt_year_dt - cur_year_dt)
    year_frac = (cur_month_dt - cur_year_dt) / (nxt_year_dt - cur_year_dt)
    print(rundate_year_frac, year_frac)

    # ### Color utilities
    years = totals.index.unique()
    colors = get_colors(len(years))
    black, red, year_colors = colors.black, colors.red, colors.year_colors
    print(colors)

    month_starts = [
        to_dt(f'{cur_year}-{m}').strftime('%b 1')
        for m in range(1, 13)
    ]
    print(month_starts)

    save(
        px.line(
            ytds,
            x='Text', y='YTD Deaths', color='Year',
            color_discrete_sequence=year_colors,
        ),
        xaxis=dict(
            tickmode='array',
            tickvals=month_starts,
            ticktext=month_starts,
        ),
        legend=dict(traceorder='reversed',),
        #bottom_legend=False,
        title='YTD Traffic Deaths',
        name='ytd-deaths',
        hoverx='x',
        bg='white',
        ygrid='#ccc',
        xgrid='#ccc',
        w=850,
        h=800,
    )

    # ### Group by year
    dt = crashes.dt.dt
    fatalities_per_year = crashes.FATALITIES.groupby(dt.year).sum().astype(int).rename('NJSP records')

    # #### NJSP reports a "total deaths" that is typically ≈5% higher than the crash records' total
    njsp_totals = totals.fatalities.rename('NJSP total')
    njsp_diff = (totals.fatalities - fatalities_per_year).rename('NJSP diff')
    njsp_totals = sxs(
        fatalities_per_year,
        njsp_totals,
        njsp_diff,
        round(njsp_diff / njsp_totals * 100, 1).apply(lambda pct: f'{"+" if pct >= 0 else "-"}{pct}%').rename('NJSP diff %'),
    )
    print(njsp_totals)

    # ### Group by month
    ym = crashes.dt.apply(lambda d: d.strftime('%Y-%m')).rename('ym')
    print(ym)

    fatalities_per_month = crashes[crashes.dt < cur_month].FATALITIES.groupby(ym).sum()
    print(fatalities_per_month)

    # ### Rolling avg
    rolling = fatalities_per_month.rolling(12).mean()
    print(rolling)

    mos = (
        sxs(
            dt.year.rename('year'),
            dt.month.rename('month'),
            crashes.FATALITIES,
        )
        .groupby(['year', 'month']).sum()
    )
    print(mos)

    pivoted = mos.reset_index().sort_values(['month', 'year'])
    pivoted = pivoted[pivoted.apply(lambda r: to_dt('%d-%02d' % (r.year, r.month)).tz_localize(cur_month_dt.tz) < cur_month_dt, axis=1)]
    print(pivoted)

    by_month = crashes.FATALITIES.groupby([dt.year, dt.month]).sum()
    print(by_month)

    # ### Break out victim "types"
    # Check victim "type" subtotals vs. total:
    fatal_totals = sxs(*[crashes[f'FATAL_{t}'].fillna(0) for t in 'DTPB']).sum(axis=1)
    sxs(crashes.dt, (crashes.FATALITIES - fatal_totals).rename('diff')).groupby(dt.year)['diff'].sum()

    # Cross-reference with annual totals, populate "unknown" subtotal:
    type_cols_map = {
        'FATAL_D': 'Drivers',
        'FATAL_T': 'Pedestrians',
        'FATAL_P': 'Passengers',
        'FATAL_B': 'Cyclists',
    }
    type_cols = list(type_cols_map.keys())

    print(type_cols)

    year_type_sums = (
        sxs(
            crashes.dt,
            crashes[type_cols].fillna(0)
        )
        .groupby(dt.year.rename('year'))
        [type_cols]
        .sum()
        .astype(int)
    )

    year_sums = year_type_sums.sum(axis=1).rename('sum')
    year_totals = totals.fatalities.rename('Total')
    missing = njsp_totals['NJSP diff'].rename('Missing')
    unknown = (year_totals - year_sums - missing).rename('FATAL_U')

    type_cols_map['FATAL_U'] = 'Unknown'
    type_cols = list(type_cols_map.keys())

    year_types = (
        sxs(
            year_type_sums,
            year_sums,
            year_totals,
            unknown,
            missing,
        )
        [ type_cols + [ 'Missing', 'Total', ] ]
        .rename(columns=type_cols_map)
    )
    value_cols = list(type_cols_map.values())
    print(year_types)

    total_errors = sxs(year_types.Total, njsp_totals['NJSP total'])[year_types.Total != njsp_totals['NJSP total']]
    print(total_errors)

    assert total_errors.empty, total_errors

    year_types['Projected'] = 0
    prv_year = cur_year - 1
    cur_total = year_types.loc[cur_year, 'Total']
    prv_total = year_types.loc[prv_year, 'Total']
    projected_total = prv_total * prv_ytd_ratio
    #projected_total = cur_total * prv_roy_ratio
    projected_remaining = int(projected_total - cur_total)
    year_types.loc[cur_year, 'Projected'] = projected_remaining
    year_types['Projected Total'] = year_types.Total + year_types.Projected
    print(year_types)

    total_2021 = year_types.loc[2021, 'Total']
    total_2022 = year_types.loc[2022, 'Total']
    projected_total_2023 = year_types.loc[2023, 'Projected Total']

    with open(f'{PLOTS_DIR}/projected_totals.json', 'w') as f:
        json.dump(year_types.dropna().to_dict('index'), f, indent=4,)

    # ### Fatalities per year (by type)
    ytc = colors_lengthen(px_colors, 9)

    # def avg(c1, c2):
    #     return (RGB.from_css(c1) + RGB.from_css(c2) / 2).css

    # idx = 1
    # unknown_color = '#2a2a2a'
    # unknown_color = avg(ytc[idx-1], ytc[idx])
    # ytc = ytc[:idx] + [unknown_color] + ytc[idx:]
    missing_color = '#666'
    ytc = [missing_color] + ytc
    print(' '.join(ytc))
    print(swatches(ytc))

    type_labels_map = [
        'Missing',
        'Unknown',
        'Drivers',
        'Passengers',
        'Cyclists',
        'Pedestrians',
        'Projected',
    ]
    fig = (
        px.bar(
            year_types[year_types.index < 2023][type_labels_map].drop(columns='Projected').replace(0, nan),
            barmode='stack',
            color_discrete_sequence=ytc,
        )
        .update_yaxes(gridcolor=gridcolor)
    )
    save(
        fig,
        title=f'NJ Traffic Deaths per Year (by victim type)<br><sup>2021 and 2022 were the deadliest years in the NJSP record, with {total_2021} and {total_2022} traffic fatalities, resp.',
        name='fatalities_per_year_by_type',
        hoverx=True,
        w=1600,
        h=800,
    )

    # ### Fatalities per month (by victim type)
    crash_type_cols = [ col for col in type_cols if col != 'FATAL_U' ]
    month_types = (
        sxs(
            crashes.dt,
            crashes[crash_type_cols].fillna(0)
        )
        [ dt.year >= 2020 ]
        .groupby([
            dt.year.rename('year'),
            dt.month.rename('month'),
        ])
        [crash_type_cols]
        .sum()
        .astype(int)
    )

    month_types = month_types.reset_index()
    month_types['dt'] = (
        month_types
        [['year', 'month']]
        .apply(lambda r: '%04d-%02d' % (r['year'], r['month']), axis=1)
    )
    month_types = month_types.set_index('dt').drop(columns=['year', 'month'])
    print(month_types)

    type_colors = colors_lengthen(px_colors, 7)

    fig = px.line(
        month_types.rename(columns=type_cols_map).loc[to_dt(month_types.index) < cur_month],
        labels={'variable': ''},
        color_discrete_sequence=type_colors,
    )
    fig.update_traces(line=dict(width=3))
    save(
        fig,
        title='NJ Traffic Deaths per Month (by victim type)',
        name='fatalities_per_month_by_type',
        hoverx=True,
        xgrid=gridcolor,
        xaxis=dict(
            tickformat="%b '%y",
        ),
        w=800,
    )

    # ### Fatalities per month
    fig = go.Figure()
    fig.add_trace(go.Bar(x=fatalities_per_month.index, y=fatalities_per_month.values, name='Fatalities', marker_color=red))
    fig.add_trace(go.Scatter(x=rolling.index, y=rolling.apply(partial(round, ndigits=1)), name='12mo avg', line={'width': 4, 'color': black, }))
    fig.update_yaxes(gridcolor=gridcolor)
    save(
        fig,
        title='NJ Traffic Deaths per Month',
        name='fatalities_per_month',
        hoverx=True,
        w=1200, h=600,
    )

    month_names = [ to_dt('2022-%02d' % i).strftime('%b') for i in range(1, 13) ]
    print(' '.join(month_names))

    fig = px.bar(
        x=pivoted.month,
        y=pivoted.FATALITIES,
        color=pivoted.year.astype(str),
        color_discrete_sequence=year_colors,
        labels=dict(color='', x='', y='',),
        barmode='group',
    ).update_yaxes(
        gridcolor=gridcolor,
    )
    save(
        fig,
        title='NJ Traffic Deaths, by Month',
        name='fatalities_by_month_bars',
        legend=dict(traceorder='reversed'),
        xaxis=dict(
            tickmode='array',
            tickvals=list(range(1, 13)),
            ticktext=month_names,
        ),
        hoverx=True,
        w=1200, h=700,
    )

    fig = px.line(
        x = pivoted.month,
        y = pivoted.FATALITIES,
        color = pivoted.year,
        color_discrete_sequence=year_colors,
        labels={ 'color': '', 'x': '', 'y': '' },
    ).update_yaxes(
        gridcolor=gridcolor,
    )
    save(
        fig,
        title='NJ Traffic Deaths by Month',
        name='fatalities_by_month_lines',
        xaxis=dict(
            tickmode='array',
            tickvals=list(range(1, 13)),
            ticktext=month_names,
        ),
        legend=dict(traceorder='reversed'),
        hoverx=True,
        w=1200, h=700,
    )

    return "Update NJSP plots"

"""Compare YTD fatalities vs. what NJSP had reported on the current date 1 and 2 years ago.

This removes some confounding related to crashes being reported on a delay.
"""
from utz import *
from nj_crashes.fauqstats import FAUQStats
from njsp.paths import fauqstats_relpath

repo = Repo()

def load_sha_date(year, *args):
    sha, dt_str = line('git', 'log', '-1', '--format=%h %ad', *args, '--', fauqstats_relpath(year), log=False).split(' ', 1)
    return sha, parse(dt_str).date()

sha0, date0 = load_sha_date(now().year)
year0 = date0.year
month = date0.month
day = date0.day

def load_mtd(year: int, sha: str | None = None) -> DF | Tuple[DF, str, date]:
    if not sha:
        sha, sha_date = load_sha_date(year, f'--before={year}-{month:02d}-{day:02d}')
        assert sha_date.month == month
        assert sha_date.day == day
        return_tpl = True
    else:
        assert sha == sha0
        return_tpl = False
    commit = repo.commit(sha)
    blobs = FAUQStats.blobs(commit)
    blob = blobs[year]
    stats = FAUQStats.load(blob, log=silent)
    crashes = stats.crashes
    dt = crashes.dt.dt
    mtd = crashes[(dt.month <= month) & (dt.day < day)]
    return (mtd, sha, sha_date) if return_tpl else mtd

year1 = year0 - 1
year2 = year0 - 2
df0 = load_mtd(year0, sha0)         # Current YTD crashes
df1, sha1, date1 = load_mtd(year1)  # Last year's YTD crashes, as they appeared on this date last year
df1_0 = load_mtd(year1, sha0)       # Current view of last year's crashes (includes any that were reported after a delay)
df2, sha2, date2 = load_mtd(year2)  # 2ya's YTD crashes, as they appeared on this date that year
df2_0 = load_mtd(year2, sha0)       # Current view of 2ya's crashes (includes any that were reported after a delay)

#print(f'Comparing {sha0} ({date0}) to {sha1} ({date1})')
cols = ['FATAL_D', 'FATAL_P', 'FATAL_T', 'FATAL_B']
def print_summary(df: DF, as_of: date, sha: str, year: int):
    sums = df[cols].sum().astype(int)
    type_str = ', '.join([f'{t}: {sums[f"FATAL_{t}"]:>2d}' for t in 'DPTB'])
    print(f"As of {as_of} (commit {sha}), {year} (until {month}/{day}) had {sums.sum()} deaths: {type_str}")
    return sums

print_summary(df0, date0, sha0, year0)
print_summary(df1, date1, sha1, year1)
print_summary(df1_0, date0, sha0, year1)
print_summary(df2, date2, sha2, year2)
print_summary(df2_0, date0, sha0, year2)

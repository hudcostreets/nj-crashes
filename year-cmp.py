"""Compare YTD fatalities vs. what NJSP had reported 1 year ago.

This removes some confounding related to crashes being reported on a delay.
"""
from utz import *
from nj_crashes.fauqstats import FAUQStats
from njsp.paths import fauqstats_relpath

repo = Repo()

def load_sha_date(year, *args):
    sha, dt_str = line('git', 'log', '-1', '--format=%h %ad', *args, '--', fauqstats_relpath(year), log=False).split(' ', 1)
    return sha, parse(dt_str).date()

sha1, date1 = load_sha_date(now().year)
year1 = date1.year
month = date1.month
day = date1.day
year0 = year1 - 1
sha0, date0 = load_sha_date(year0, f'--before={year0}-{month:02d}-{day:02d}')
assert date0.month == month
assert date0.day == day

def load_mtd(year: int, sha: str):
    commit = repo.commit(sha)
    blobs = FAUQStats.blobs(commit)
    blob = blobs[year]
    stats = FAUQStats.load(blob)
    crashes = stats.crashes
    dt = crashes.dt.dt
    mtd = crashes[(dt.month <= month) & (dt.day <= day)]
    return mtd

print(f'Comparing {sha0} ({date0}) to {sha1} ({date1})")')
df1 = load_mtd(year1, sha1)
df0 = load_mtd(year0, sha0)
df0_2 = load_mtd(year0, sha1)

cols = ['FATAL_D', 'FATAL_P', 'FATAL_T', 'FATAL_B']
def print_summary(df: DF, as_of: date, year: int):
    sums = df[cols].sum().astype(int)
    type_str = ', '.join([f'{t}: {sums[f"FATAL_{t}"]:>2d}' for t in 'DPTB'])
    print(f"As of {as_of}, {year} (until {month}/{day}) had {sums.sum()} deaths: {type_str}")
    return sums

print_summary(df1, date1, year1)
print_summary(df0, date0, year0)
print_summary(df0_2, date1, year0)

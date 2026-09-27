"""`njdot roads recover`: run `njdot.loc_recovery` on one county's crashes (prototype; see
specs/crash-location-recovery.md). Reads the published `road-runs.parquet` for entity ids, so its
output lines up with the current `roads/` outputs."""
import sys
from os.path import join

import duckdb
import numpy as np
import pandas as pd
from click import Choice, option

from nj_crashes.utils.log import err
from njdot.cc2mc2mn import cc2mc2mn
from njdot.loc_recovery import entity_at, learn_names, recover, recovery_context
from njdot.paths import AASHTO_SUPPLEMENTED_CRASHES, CRASHES_PQT, NG911_DIR, ROADS_DIR, ROADWAY_NETWORK
from njdot.road_net import ng_intervals, ng_segments, rn_features

from .roads import county_subset, roads

CRASH_COLS = [
    'year', 'cc', 'mc', 'sri', 'mp', 'road', 'cross_street', 'cross_street_distance', 'Unit Of Measurement',
    'Direction From Cross Street', 'road_system', 'ilat', 'ilon', 'olat', 'olon', 'severity', 'tk',
]
EVAL_MODES = {
    # Coded 2021+ crashes, names learned from ≤ 2020; SRI / MP / points blanked.
    'new': dict(years=(2021, 9999), learn=(0, 2020), keep_points=False, drop_cross=False),
    # Coded 2006-2016 crashes (police-entered strings), names learned from 2018+.
    'old': dict(years=(2006, 2016), learn=(2018, 9999), keep_points=False, drop_cross=False),
    # Coded 2017+ crashes with a police `olat` / `olon`, cross street blanked: `latlon_snap` alone.
    'll': dict(years=(2017, 9999), learn=(0, 2016), keep_points=True, drop_cross=True),
}


def load_county(cc: int, ng911_dir: str, network: str, runs_path: str) -> dict:
    """County `cc`'s `recover` inputs (`recovery_context`), entity ids from the published `runs_path`."""
    rn, cl, al = county_subset(pd.read_parquet(network), pd.read_parquet(join(ng911_dir, 'centerlines.parquet')), pd.read_parquet(join(ng911_dir, 'aliases.parquet')), cc)
    feats = rn_features(rn)
    seg = ng_segments(cl)
    iv = ng_intervals(seg, feats)
    err(f'  {len(cl):,} NG911 segments, {len(rn):,} NJDOT features, {len(iv):,} intervals')
    return recovery_context(seg, iv, pd.read_parquet(runs_path), feats, cl, al, cc2mc2mn)


def load_crashes(cc: int) -> pd.DataFrame:
    """Per-table crashes (≤ 2023, with `id`) + AASHTO 2024+ (no `id`) in county `cc`."""
    cols = ', '.join(f'"{c}"' for c in CRASH_COLS)
    return duckdb.sql(f"""
        SELECT "id", {cols}, 'dot' AS src FROM '{CRASHES_PQT}' WHERE cc = {cc}
        UNION ALL BY NAME
        SELECT NULL::BIGINT AS "id", {', '.join(f'"{c}"::VARCHAR AS "{c}"' if c in ('cross_street_distance', 'Unit Of Measurement', 'Direction From Cross Street') else ('NULL::INT AS road_system' if c == 'road_system' else f'"{c}"') for c in CRASH_COLS)}, 'aashto' AS src
        FROM '{AASHTO_SUPPLEMENTED_CRASHES}' WHERE cc = {cc} AND year >= 2024
    """).df()


def score(ev: pd.DataFrame, runs: pd.DataFrame) -> pd.DataFrame:
    """Blind re-location vs. NJDOT's coding, per `loc_source`: share, entity agreement / disagreement,
    and (placed crashes) distance to NJDOT's point (m) and MP error on the same SRI."""
    gt = entity_at(ev['sri'].astype('string'), ev['mp'], runs)
    ev = ev[gt.notna().to_numpy()].assign(gt=gt.dropna().astype(int).to_numpy())
    ok = (ev['r_entity'].astype('Int64') == ev['gt']).fillna(False).astype(bool)
    wrong = ev['r_entity'].notna() & ~ok
    lat0, lon0 = ev['ilat'].fillna(ev['olat']), ev['ilon'].fillna(ev['olon'])
    d = np.hypot((ev['r_lat'] - lat0) * 110_540, (ev['r_lon'] - lon0) * 111_320 * np.cos(np.radians(lat0)))
    dmp = (ev['r_mp'] - ev['mp']).abs().where(ev['r_sri'] == ev['sri'].astype('string'))
    g = pd.DataFrame({'src': ev['r_loc_source'].astype(str), 'ok': ok, 'wrong': wrong, 'd': d, 'dmp': dmp}).groupby('src')
    return pd.DataFrame({
        'n': g.size(), 'share': (g.size() / len(ev)).round(3), 'entity_ok': g['ok'].mean().round(3), 'entity_wrong': g['wrong'].mean().round(3),
        'd_med_m': g['d'].median().round(0), 'd_p90_m': g['d'].quantile(0.9).round(0), 'dmp_med': g['dmp'].median().round(3),
    })


@roads.command('recover')
@option('-C', '--county', 'cc', type=int, default=9, show_default=True, help='County code (9 = Hudson)')
@option('-e', '--eval', 'n_eval', type=int, default=0, help='Also blind-re-locate this many coded crashes and score them')
@option('-E', '--eval-out', help='Write the blind eval\'s per-crash results (crash columns + `r_*`) to this parquet')
@option('-g', '--ng911-dir', default=NG911_DIR, show_default=True, help='`njdot roads fetch-ng911` output dir')
@option('-m', '--eval-mode', type=Choice(list(EVAL_MODES)), default='new', show_default=True, help='Blind-eval sample (see `EVAL_MODES`)')
@option('-n', '--network', default=ROADWAY_NETWORK, show_default=True, help='`njdot roads fetch-network` output')
@option('-o', '--out', help='Write per-crash results (crash columns + `r_*`) to this parquet')
@option('-r', '--runs', 'runs_path', default=join(ROADS_DIR, 'road-runs.parquet'), show_default=True, help='`road-runs.parquet` (entity ids)')
def roads_recover(cc: int, n_eval: int, eval_out: str | None, ng911_dir: str, eval_mode: str, network: str, out: str | None, runs_path: str):
    """Recover SRI / MP / entity for a county's crashes from their road / cross-street strings."""
    err(f'Loading county {cc}...')
    ctx = load_county(cc, ng911_dir, network, runs_path)
    cr = load_crashes(cc)
    coded = cr[cr['sri'].fillna('').ne('') & cr['mp'].notna()]
    coded = coded.assign(entity=entity_at(coded['sri'].astype('string'), coded['mp'], ctx['runs']).to_numpy())
    learned = learn_names(coded)
    err(f'  {len(cr):,} crashes, {len(learned):,} learned names')
    res = recover(cr, learned=learned, **ctx)
    res = pd.concat([cr.reset_index(drop=True), res.add_prefix('r_').reset_index(drop=True)], axis=1)
    if out:
        res.to_parquet(out)
        err(f'Wrote {out}')
    road = res['road_system'].ne(9) | res['road_system'].isna()
    by_year = res[road].groupby('year').agg(
        n=('year', 'size'),
        on_entity_before=('r_entity', lambda e: float((e.notna() & res.loc[e.index, 'r_loc_source'].eq('sri_mp')).mean())),
        on_entity_after=('r_entity', lambda e: float(e.notna().mean())),
    ).round(3)
    print(by_year.to_string())
    print(pd.crosstab(res['year'], res['r_loc_source']).to_string())
    if n_eval:
        m = EVAL_MODES[eval_mode]
        lo, hi = m['years']
        gt = coded[coded['year'].between(lo, hi)]
        if m['keep_points']:
            gt = gt[gt['olat'].notna()]
        gt = gt.sample(n=min(len(gt), n_eval), random_state=0).drop(columns='entity')
        blind = gt.assign(sri=pd.NA, mp=np.nan, ilat=np.nan, ilon=np.nan)
        blind = blind.assign(cross_street=pd.NA) if m['drop_cross'] else blind.assign(olat=np.nan, olon=np.nan)
        llo, lhi = m['learn']
        o = recover(blind, learned=learn_names(coded[coded['year'].between(llo, lhi)]), **ctx)
        ev = pd.concat([gt.reset_index(drop=True), o.add_prefix('r_').reset_index(drop=True)], axis=1)
        if eval_out:
            ev.drop(columns=['r_cands']).to_parquet(eval_out)
            err(f'Wrote {eval_out}')
        print(f'Blind eval ({eval_mode}): {len(ev):,} coded crashes', file=sys.stderr)
        print(score(ev, ctx['runs']).to_string())

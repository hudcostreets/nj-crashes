"""Harmonize NJ municipality codes/names across NJDOT, NJSP, and NJGIN.

Reconciles three coding systems that disagree on (cc, mc) → name pairings:
- NJDOT crash data (codes 1-N per county; some name typos in 2023)
- NJSP fatal crash data (different mc codes than NJDOT for some munis)
- NJGIN canonical municipality boundaries (the ground truth we align to)

Pipeline:
1. Load NJDOT crashes; majority-vote `cc → cn` and `(cc, mc, year) → mn`.
2. Build `mn21` (most-recent-year mn per (cc, mc)) + manual fixes.
3. Load NJSP and NJGIN; normalize type suffixes.
4. Stem-match each to NJGIN; build `sp2gin` and `dot2gin` parquets.
5. Merge into a single `names` table with city-full-name preservation
   ("Atlantic City", "Jersey City", etc.) and save `cc2mc2mn.json`.

Outputs:
- njsp/data/muni_codes.parquet         (sp → gin mc map)
- njdot/data/muni_codes.parquet        (dot → gin mc map, year-aware)
- data/county-city-codes.parquet       (canonical short names)
- www/public/njdot/cc2mc2mn.json       (cc → {cn, mc2mn} dict)

Was originally `njdot/harmonize-muni-codes.ipynb`. Converted to .py per
`specs/per-capita-stats.md` since the notebook caused recurring rebase
conflicts and the planned cousub-GEOID extension would have required
rewriting it anyway.
"""
import json

import pandas as pd
from utz import Series, err, singleton, sxs

import njdot
import njsp
from nj_crashes import load_munis_geojson
from nj_crashes.paths import COUNTY_CITY_CODES_PQT
from nj_crashes.utils.reconcile import ambiguous_mappings, resolve_conflicts
from njdot import Data
from njdot.crashes import name_renames
from njdot.load import pk_astype, pk_renames
from njdot.paths import CC2MC2MN

SUFFIXES = ['Boro', 'City', 'Village', 'Twp', 'Town']

# Canonical cities with "City" preserved in short names (vs being stripped as a type suffix).
CITY_STEMS = ['Atlantic', 'Jersey', 'Ocean', 'Union']
CITIES = [f'{stem} City' for stem in CITY_STEMS]

# Spelling/formatting fixes + post-merger redirects applied to NJDOT names
# before alignment with NJGIN.
DOT_MN_FIXES = {
    # Spelling/formatting
    'Ho Ho Kus Boro': 'Ho-Ho-Kus Boro',
    'Mount Ephriam Boro': 'Mount Ephraim Boro',
    'South Orange Village Twp': 'South Orange Twp',
    'Avon-By-The-Sea Boro': 'Avon-by-the-Sea Boro',
    'Pt Pleasant Beach Boro': 'Point Pleasant Beach Boro',
    'Lower Alloways Crk Twp': 'Lower Alloways Creek Twp',
    'Sandvston Twp': 'Sandyston Twp',
    # Renames: Morris cc=14 mc=30 was "Passaic Twp" pre-2013 (renamed 1992
    # but NJDOT didn't pick it up until then).
    'Passaic Twp': 'Long Hill Twp',
    # Mergers — collapse pre-merger entities to post-merger names.
    'Princeton Twp': 'Princeton',  # 2013 Princeton Boro/Twp merger
    'Princeton Boro': 'Princeton',
    'Pine Valley Boro': 'Pine Hill Boro',  # 2022 Pine Valley dissolution
    'Pahaquarry Twp': 'Hardwick Twp',  # 1997 Pahaquarry dissolution (Warren cc=21)
}

# NJSP-side regex/literal replacements after suffix normalization.
SP_MN_FIXES = {
    'Easthampton Twp': 'Eastampton Twp',
    'Hohokus Boro': 'Ho-Ho-Kus Boro',
    'Ridgewood Twp': 'Ridgewood Village',
    'Ridgefield Park Twp': 'Ridgefield Park Village',
    'Parsippany-Troy Hil': 'Parsippany-Troy Hills',
    'Lower Alloways Cree': 'Lower Alloways Creek',
    'Orange City': 'Orange Twp',
    'Avon-By-The-Sea Boro': 'Avon-by-the-Sea Boro',
    'South Orange Village': 'South Orange Twp',
    'Point Pleasant Beac': 'Point Pleasant Beach',
}

# NJGIN-side fixes (the canonical Municipal_Boundaries_of_NJ.geojson uses
# slightly different conventions than DOT/SP).
GIN_MN_FIXES = {
    'South Orange Village Twp': 'South Orange Twp',
    'Boonton': 'Boonton Town',
    'City of Orange Twp': 'Orange Twp',
}


def load_dot_data():
    """Load NJDOT (cc, cn, mc, mn) value counts from yearly Accidents.pqt."""
    data = Data(types=['Accidents'], columns=['County Code', 'County Name', 'Municipality Code', 'Municipality Name'])
    c = data.df(index=False)
    c = c.value_counts(c.columns.tolist()).sort_index().rename('num').reset_index()
    c = c.rename(columns={
        k: v for k, v in {
            'Year': 'year',
            **pk_renames,
            **name_renames,
        }.items()
        if k in c
    }).astype(pk_astype)
    # Drop Port Authority (cc=99) — outside NJ jurisdiction; re-added manually downstream.
    c = c[c['cc'] < 99]
    c['cn'] = c['cn'].str.title()
    c['mn'] = c['mn'].str.title()
    c['mn'] = c['mn'].str.replace(' Township$', ' Twp', regex=True)
    c['mn'] = c['mn'].str.replace(' Borough$', ' Boro', regex=True)
    c = c[['year'] + [k for k in c if k != 'year']]
    return c


def resolve_cc2cn(c):
    cn_cols = ['cc', 'cn']
    cc2cn, conflicts = ambiguous_mappings(c, cn_cols)
    if len(conflicts) > 0:
        cc2cn = resolve_conflicts(c, key_cols=['cc'], value_col='cn', conflicts_df=conflicts, resolver='majority')
    cc2cn = cc2cn[cc2cn['cc'] > 0].set_index('cc')['cn']
    assert cc2cn.to_dict() == njdot.data.cc2cn
    return cc2cn


def resolve_mny(c):
    """Majority-vote (cc, mc, year) → mn; rewrite c with resolved mn."""
    mny_cols = ['cc', 'mc', 'year', 'mn']
    mny_uniqs, mny_conflicts = ambiguous_mappings(c, mny_cols)
    if len(mny_conflicts) > 0:
        mny_uniqs = resolve_conflicts(
            c, key_cols=['cc', 'mc', 'year'], value_col='mn', conflicts_df=mny_conflicts, resolver='majority',
        )
        c = c.drop(columns='mn').merge(mny_uniqs, on=['cc', 'mc', 'year'], how='left')
    return mny_uniqs, c


def build_mn(mny_uniqs, cc2cn, year_cutoff=None):
    """Most-recent-year mn per (cc, mc), with DOT_MN_FIXES applied.

    `year_cutoff`: if given, only consider years < cutoff (used to derive pre-2023
    historical mappings for `dot2gin`).
    """
    src = mny_uniqs[mny_uniqs['year'] < year_cutoff] if year_cutoff is not None else mny_uniqs
    mn = (
        src
        [['cc', 'mc', 'mn', 'year']]
        .groupby(['cc', 'mc'])
        .apply(lambda df: df.sort_values('year').iloc[-1].mn, include_groups=False)
        .rename('mn')
        .reset_index()
        .merge(cc2cn, left_on='cc', right_index=True, how='left', validate='m:1')
        [['cc', 'cn', 'mc', 'mn']]
    )
    for old, new in DOT_MN_FIXES.items():
        mn.loc[mn['mn'] == old, 'mn'] = new
    return mn


def load_sp_data():
    from njsp.cli.update_pqts import get_crashes_df

    renames = {
        'CCODE': 'cc',
        'MCODE': 'mc',
        'CNAME': 'cn',
        'MNAME': 'mn',
        'FATALITIES': 'tk',
        'INJURIES': 'ti',
        'FATAL_D': 'dk',
        'FATAL_P': 'ok',
        'FATAL_T': 'pk',
        'FATAL_B': 'bk',
        **{c: c.lower() for c in ['STREET', 'HIGHWAY', 'LOCATION']},
    }

    def parse_mc(r):
        assert r.mc[:2] == r.cc
        return r.mc[2:]

    sp = get_crashes_df()[0].rename(columns=renames)
    sp['mc'] = sp.apply(parse_mc, axis=1)
    sp = sp.astype({'cc': int, 'mc': int})
    sp = sp[['dt'] + list(renames.values())]
    sp['mn'] = sp.mn.replace(' Twsp?$', ' Twp', regex=True)
    # Expand truncated suffixes ("Bor" → "Boro", "Tw" → "Twp", etc.)
    for tpe in SUFFIXES:
        for idx in range(1, len(tpe)):
            sp['mn'] = sp.mn.replace(f' {tpe[:idx]}$', f' {tpe}', regex=True)
    for src, dst in SP_MN_FIXES.items():
        sp['mn'] = sp.mn.replace(src, dst, regex=False)
    return sp


def load_gin_data():
    mdf = load_munis_geojson().reset_index()
    mn = mdf.NAME.rename('mn')
    for src, dst in {'Borough': 'Boro', 'Township': 'Twp'}.items():
        mn = mn.replace(f' {src}$', f' {dst}', regex=True)
    for src, dst in GIN_MN_FIXES.items():
        mn = mn.replace(src, dst, regex=False)
    return sxs(mdf.cc, mdf.COUNTY.str.title().rename('cn'), mdf.mc, mn)


def split_stem_suffix(r):
    for suffix in SUFFIXES:
        if r.mn.endswith(f' {suffix}'):
            return Series(dict(stem=r.mn[:-(len(suffix) + 1)], type=suffix))
    return Series(dict(stem=r.mn, type=None))


def add_stems(df, id_name):
    df = df[['cc', 'cn', 'mc', 'mn']].drop_duplicates()
    df = sxs(df, df.apply(split_stem_suffix, axis=1)).sort_values(['cc', 'mc']).reset_index(drop=True)
    dupe_mask = df.duplicated(keep='last', subset=['cc', 'mc'])
    dupes = df[dupe_mask]
    if not dupes.empty:
        all_dupes = df[df.duplicated(keep=False, subset=['cc', 'mc'])]
        err(f"Dropping {len(dupes)} non-last duplicate (cc,mc) entries. All dupes:")
        err(str(all_dupes))
    df = df[~dupe_mask]
    assert df[df.duplicated(keep=False, subset=['cc', 'mc'])].empty
    df.index.name = id_name
    return df


def align(l, r, validate1='1:1'):
    """Align two stem-decomposed muni tables; first by exact (cn, mn), then by (cn, stem)."""
    on = ['cn', 'mn']
    common = ['cc', 'mc', 'type']
    cols = [*on, *common]
    ln, rn = l.index.name, r.index.name
    lcc, rcc = f'cc_{ln}', f'cc_{rn}'
    lmc, rmc = f'mc_{ln}', f'mc_{rn}'
    ltc, rtc = f'type_{ln}', f'type_{rn}'

    lr1 = (
        l.reset_index()[[ln] + cols]
        .merge(r.reset_index()[[rn] + cols], on=on, suffixes=[f'_{ln}', f'_{rn}'], validate=validate1)
    )
    assert (lr1[lcc] == lr1[rcc]).all()
    lt, rt = lr1[ltc], lr1[rtc]
    types_match = (lt == rt) | (lt.isna() & rt.isna())
    assert types_match.all(), lr1[~types_match]
    err(f"Found {len(lr1)} exact ({','.join(on)}) matches from {len(l)} {ln} and {len(r)} {rn} entries")

    m1 = sxs(lr1[lcc].rename('cc'), lr1[lmc], lr1[rmc], lr1[ltc].rename('type'))

    # Stem-fallback for non-exact (e.g. NJDOT "Belleville Town" vs NJGIN "Belleville Twp")
    l2 = l[~l.index.isin(lr1[ln])]
    r2 = r[~r.index.isin(lr1[rn])]
    l2_dupes = l2[l2.duplicated(keep=False, subset=['cn', 'stem'])]
    r2_dupes = r2[r2.duplicated(keep=False, subset=['cn', 'stem'])]
    assert l2_dupes.empty, f"{len(l2_dupes)} (cn,stem) dupes found:\n{l2_dupes}"
    assert r2_dupes.empty, f"{len(r2_dupes)} (cn,stem) dupes found:\n{r2_dupes}"

    on2 = ['cn', 'stem']
    cols2 = [*on2, *common]
    lr2 = (
        l2.reset_index()[[ln] + cols2]
        .merge(r2.reset_index()[[rn] + cols2], on=on2, suffixes=[f'_{ln}', f'_{rn}'], validate='1:1')
    )
    assert (lr2[lcc] == lr2[rcc]).all()
    err(f"Found {len(lr2)} ({','.join(on2)}) matches from {len(l2)} {ln} and {len(r2)} {rn} entries")

    l3 = l2[~l2.index.isin(lr2[ln])]
    r3 = r2[~r2.index.isin(lr2[rn])]
    assert l3.empty, f"Found {len(l3)} unaligned items from l:\n{l3}"
    err(f'{ln}: {len(l)} entries, {len(lr1)} exact matches, {len(lr2)} stem matches, {len(l3)} unmatched')
    err(f'{rn}: {len(r)} entries, {len(lr1)} exact matches, {len(lr2)} stem matches, {len(r3)} unmatched')

    cc = lr2[lcc].rename('cc')
    tcl, tcr = lr2[ltc], lr2[rtc]
    has_tcl, has_tcr = ~tcl.isna(), ~tcr.isna()
    m2 = sxs(cc, lr2[lmc], lr2[rmc])
    m2['type'] = tcr  # default to right `type`
    m2.loc[has_tcl & ~has_tcr, 'type'] = tcl  # fall back to left `type` if right is null

    m2t = m2.merge(r[['cc', 'mc', 'stem']], left_on=['cc', rmc], right_on=['cc', 'mc'], how='left').drop(columns='mc')
    type_conflicts = sxs(m2t.drop(columns='type'), tcl, tcr)[(tcl != tcr) & has_tcl & has_tcr]
    if not type_conflicts.empty:
        err(f"{len(type_conflicts)} conflicting types:")
        err(str(type_conflicts))

    m = pd.concat([m1, m2])
    m = m.merge(r[['cc', 'mc', 'stem']], left_on=['cc', rmc], right_on=['cc', 'mc'], how='left').drop(columns='mc')
    m['mn'] = m.apply(lambda r: r.stem + (f' {r["type"]}' if r["type"] else ''), axis=1)
    err(f"{(m[lmc] != m[rmc]).sum()} mc's don't match")
    return m


def build_dot2gin(mny_uniqs, cc2cn, df2):
    """Pre-2023 historical dot2gin alignment + 2023 Burlington overrides + Port Authority."""
    mn_historical = build_mn(mny_uniqs, cc2cn, year_cutoff=2023)
    df0_historical = add_stems(mn_historical, 'dot')
    m02_historical = align(df0_historical, df2, validate1='m:1')
    dot2gin = m02_historical[['cc', 'mc_dot', 'mc_gin']].copy()

    # Burlington 2023: Willingboro removed from mc=38 and inserted at mc=17, shifting everything.
    burlington_2023 = mny_uniqs[(mny_uniqs['cc'] == 3) & (mny_uniqs['year'] == 2023) & (mny_uniqs['mc'] >= 17)]
    overrides_2023 = []
    for _, row in burlington_2023.iterrows():
        mn_match = df2[(df2.cc == 3) & (df2.mn == row['mn'])]
        if not mn_match.empty:
            overrides_2023.append({'cc': 3, 'mc_dot': row['mc'], 'year': 2023, 'mc_gin': mn_match.mc.iloc[0]})

    # Port Authority synthetic codes (cc=99) from 2023+ when we started preserving PA crashes.
    pa_mappings = [
        {'cc': 99, 'mc_dot': 1, 'mc_gin': 9901, 'year': 2023},
        {'cc': 99, 'mc_dot': 2, 'mc_gin': 9902, 'year': 2023},
    ]
    overrides = pd.DataFrame(overrides_2023 + pa_mappings).astype({
        'cc': 'int8', 'mc_dot': 'int8', 'mc_gin': 'int16', 'year': 'Int16',
    })
    dot2gin = pd.concat([dot2gin, overrides], ignore_index=True)
    dot2gin = dot2gin.sort_values(['cc', 'mc_dot', 'year'], na_position='first').reset_index(drop=True)
    return dot2gin


def build_names(m12, m02, cc2cn, df2):
    """Combined gin-canonical short names with city full-name preservation."""
    m = (
        m12.merge(m02, on=['cc', 'mc_gin'], how='outer', suffixes=['_sp', '_dot'])
        .sort_values(['cc', 'mc_gin'])
        .astype({'mc_sp': 'Int8', 'mc_dot': 'Int8'})
    )
    assert ((m.stem_sp == m.stem_dot) | m.stem_sp.isna() | m.stem_dot.isna()).all()
    assert ((m.type_sp == m.type_dot) | m.type_sp.isna() | m.type_dot.isna()).all()

    m['stem'] = m['stem_sp']
    m.loc[m.stem.isna() & ~m.stem_dot.isna(), 'stem'] = m.stem_dot
    m['type'] = m['type_sp']
    m.loc[m.type.isna() & ~m.type_dot.isna(), 'type'] = m.type_dot
    m = m.drop(columns=[f'{c}_{t}' for c in ['stem', 'type', 'mn'] for t in ['dot', 'sp']])
    m['mn'] = m.apply(lambda r: r.stem + (f' {r["type"]}' if r["type"] else ''), axis=1)
    m = m.merge(cc2cn, left_on='cc', right_index=True, how='left', validate='m:1')
    m = m[['cc', 'cn', 'mc_gin', 'mc_dot', 'mc_sp', 'mn', 'stem', 'type']]

    # Short names: drop type suffix by default; preserve full for "Atlantic City"-style cities
    # and for stem-collisions ("Bordentown" + "Bordentown Twp").
    city_full_mask = df2.mn.isin(CITIES)
    cnn_dupe_mask = df2.duplicated(['cc', 'stem'], keep=False)
    full_name_mask = city_full_mask | cnn_dupe_mask
    names = df2.copy()
    names['name'] = names['stem']
    names.loc[full_name_mask & ~city_full_mask, 'name'] = names.loc[full_name_mask & ~city_full_mask].apply(
        lambda r: r.stem + (f' {r.type}' if r.type else ''), axis=1
    )
    names.loc[city_full_mask, 'name'] = names.loc[city_full_mask, 'mn']
    names = names.drop(columns='mn')
    return names


def write_cc2mc2mn(names):
    def county_obj(df):
        return dict(
            cn=singleton(df.cn.tolist(), dedupe=True),
            mc2mn=df.set_index('mc')['name'].to_dict(),
        )

    cc2mc2mn = (
        names.groupby('cc').apply(county_obj, include_groups=False).to_dict()
    )
    # Port Authority (cc=99) — outside NJ, manually appended (matches notebook output).
    cc2mc2mn[99] = {'cn': 'Port Authority', 'mc2mn': {9901: 'GWB', 9902: 'Lincoln Tunnel'}}
    with open(CC2MC2MN, 'w') as f:
        json.dump(cc2mc2mn, f, indent=2)


def main():
    err('loading NJDOT crash data...')
    c = load_dot_data()
    cc2cn = resolve_cc2cn(c)
    mny_uniqs, c = resolve_mny(c)
    mn21 = build_mn(mny_uniqs, cc2cn)

    err('loading NJSP crash data...')
    sp = load_sp_data()

    err('loading NJGIN muni boundaries...')
    gin = load_gin_data()

    df0 = add_stems(mn21, 'dot')
    df1 = add_stems(sp, 'sp')
    df2 = add_stems(gin, 'gin')

    err('aligning NJSP ↔ NJGIN...')
    m12 = align(df1, df2)
    sp2gin = m12[['cc', 'mc_sp', 'mc_gin']].sort_values(['cc', 'mc_gin']).reset_index(drop=True)
    sp2gin.to_parquet(njsp.paths.MC_PQT)
    err(f'wrote {njsp.paths.MC_PQT} ({len(sp2gin)} rows)')

    err('aligning NJDOT ↔ NJGIN (latest-year)...')
    m02 = align(df0, df2, validate1='m:1')

    err('building dot2gin (historical + 2023 overrides + PA)...')
    dot2gin = build_dot2gin(mny_uniqs, cc2cn, df2)
    dot2gin.to_parquet(njdot.paths.MC_PQT)
    err(f'wrote {njdot.paths.MC_PQT} ({len(dot2gin)} rows)')

    err('building canonical names + cc2mc2mn JSON...')
    names = build_names(m12, m02, cc2cn, df2)
    names.to_parquet(COUNTY_CITY_CODES_PQT)
    err(f'wrote {COUNTY_CITY_CODES_PQT} ({len(names)} rows)')

    write_cc2mc2mn(names)
    err(f'wrote {CC2MC2MN}')


if __name__ == '__main__':
    main()

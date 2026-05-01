"""Match Census `cousub` GEOIDs to NJGIN canonical (cc, mc) muni codes.

Output: `census/data/nj_cousub_codes.parquet` with columns
`(cc, mc, cousub_geoid, cousub_name)`. Used by `census/build.py` to attach
`cousub_geoid` to each per-vintage population row, then aggregate to the
`(cc, mc)` grain.

Strategy: load the 2023 ACS 5-yr cousub list (564 NJ munis after dropping
the 5 "not defined" placeholders), normalize Census suffixes to NJGIN
conventions ("borough"→"Boro", "township"→"Twp", a few literal fixes for
the City-of-Orange / South-Orange-Village quirks), then run the same
two-stage `(cn, mn)` → `(cn, stem)` align that NJDOT and NJSP go through.

NJGIN drops the "City" suffix for some munis (Newark, Asbury Park, …) but
keeps it for the canonical "Atlantic City"/"Jersey City"/"Ocean City"/
"Union City" four. The stem fallback reconciles either convention.

Pre-merger geoids (Princeton Boro/Twp pre-2013, Pine Valley pre-2022) are
not handled here; `census/build.py` folds them into the post-merger code
during its per-vintage assembly via a small merger map.
"""
import json
from os.path import join

import pandas as pd
from utz import err

from census import RAW_DIR, DATA_DIR
from njdot.harmonize_muni_codes import GIN_MN_FIXES, add_stems, align, load_gin_data

OUT_PQT = join(DATA_DIR, 'nj_cousub_codes.parquet')

# NJ counties, alphabetical: NJDOT cc = (FIPS + 1) / 2.
NJ_FIPS_TO_CC = {f'{2 * cc - 1:03d}': cc for cc in range(1, 22)}

# Census uses lowercase type suffixes ("borough", "township", "city", "town",
# "village"); convert to NJGIN's title-case shorthand without title-casing the
# rest of the name (which would mangle "Avon-by-the-Sea" / "Ho-Ho-Kus" etc.).
SUFFIX_REPLACEMENTS = [
    (' borough', ' Boro'),
    (' township', ' Twp'),
    (' village', ' Village'),
    (' town', ' Town'),
    (' city', ' City'),
]

# Census-specific name fixes, applied after suffix replacement.
CENSUS_MN_FIXES = {
    # Munis whose canonical name already ends in "City" (e.g. "Atlantic City")
    # get a redundant " City" tacked on by the Census type-suffix convention.
    'Atlantic City City': 'Atlantic City',
    'Corbin City City': 'Corbin City',
    'Egg Harbor City City': 'Egg Harbor City',
    'Gloucester City City': 'Gloucester City',
    'Jersey City City': 'Jersey City',
    'Margate City City': 'Margate City',
    'Ocean City City': 'Ocean City',
    'Sea Isle City City': 'Sea Isle City',
    'Union City City': 'Union City',
    'Ventnor City City': 'Ventnor City',
    # Census uses " and " where NJGIN uses "-".
    'Peapack and Gladstone Boro': 'Peapack-Gladstone Boro',
    # Match NJGIN's GIN_MN_FIXES.
    'City of Orange Twp': 'Orange Twp',
    'South Orange Village Twp': 'South Orange Twp',
}


def load_cousub_2023():
    """Load 2023 ACS 5-yr cousub list, normalized to NJGIN-style names."""
    raw = json.load(open(join(RAW_DIR, 'acs5_2023_cousub.json')))
    rows = []
    for r in raw[1:]:
        name_full, _pop, _state, fips_county, cousub_fips = r
        if 'not defined' in name_full:
            continue
        muni_part, county_part, _ = name_full.split(', ')
        cn = county_part.removesuffix(' County')
        mn = muni_part
        for src, dst in SUFFIX_REPLACEMENTS:
            if mn.endswith(src):
                mn = mn[:-len(src)] + dst
                break
        mn = CENSUS_MN_FIXES.get(mn, mn)
        rows.append({
            'cc': NJ_FIPS_TO_CC[fips_county],
            'cn': cn,
            'mn': mn,
            'cousub_geoid': f'34{fips_county}{cousub_fips}',
            'cousub_fips': int(cousub_fips),
        })
    df = pd.DataFrame(rows)
    err(f'loaded {len(df)} NJ cousubs from 2023 ACS 5-yr')
    return df


def harmonize():
    cen = load_cousub_2023()
    # Use cousub_fips as the unique-per-(cc) `mc` so add_stems is happy.
    cen_for_align = cen.rename(columns={'cousub_fips': 'mc'})[['cc', 'cn', 'mc', 'mn']]
    df_cen = add_stems(cen_for_align, 'cen')
    df_gin = add_stems(load_gin_data(), 'gin')
    m = align(df_cen, df_gin)
    # `mc_cen` is the cousub_fips; `mc_gin` is NJGIN's canonical mc.
    out = (
        m[['cc', 'mc_cen', 'mc_gin']]
        .merge(cen[['cousub_fips', 'cousub_geoid', 'mn']], left_on='mc_cen', right_on='cousub_fips', how='left', validate='1:1')
        .rename(columns={'mc_gin': 'mc', 'mn': 'cousub_name'})
        [['cc', 'mc', 'cousub_geoid', 'cousub_name']]
        .astype({'cc': 'int8', 'mc': 'int16', 'cousub_geoid': 'string', 'cousub_name': 'string'})
        .sort_values(['cc', 'mc'])
        .reset_index(drop=True)
    )
    return out


def main():
    out = harmonize()
    out.to_parquet(OUT_PQT)
    err(f'wrote {OUT_PQT} ({len(out)} rows)')


if __name__ == '__main__':
    main()

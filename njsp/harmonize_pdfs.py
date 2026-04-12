"""Harmonize XML crash records with PDF per-crash listings.

NJSP publishes two per-crash sources:

- FAUQStats*.xml (daily feed): has `tk` (total killed) and, from 2020 on,
  per-type breakdowns `dk`/`ok`/`pk`/`bk`.
- Annual PDF reports (per-crash "Fatal Crashes by County..." section): has
  per-type breakdowns for every year 2001-2024.

The join happens in three passes, to handle cases where the two sources
disagree on the `(cc, mc)` assignment of the same physical crash:

1. Exact `(date, cc, mc)` match with equal row count and `tk` sum.
2. Same `(date, cc)`, different mc (e.g. XML has Neptune City, PDF has
   Neptune Twp) where row count and tk sum still align within the county.
3. Cross-county: PDF rows whose `municipality` text didn't muni-match at
   parse time (because the PDF put the crash under the wrong county header)
   are matched back to their XML counterpart by date + muni-name + tk.

Unmatched rows are flagged `type_source='unresolved'` and listed in the
returned residuals report.
"""
import json
import re
from os.path import join
import pandas as pd

from nj_crashes.paths import PUBLIC_DIR, WWW_DIR

PER_CRASH_CSV = join(WWW_DIR, 'njsp', 'data', 'annual-reports', 'per_crash_from_pdfs.csv')
CC2MC2MN_JSON = join(PUBLIC_DIR, 'njdot', 'cc2mc2mn.json')


def _load_name_to_locs():
    with open(CC2MC2MN_JSON) as f:
        cc2mc2mn = json.load(f)
    name_to_locs: dict[str, list[tuple[int, int]]] = {}
    for cc_str, info in cc2mc2mn.items():
        cc = int(cc_str)
        for mc_str, mn in info.get('mc2mn', {}).items():
            mc = int(mc_str)
            name_to_locs.setdefault(mn.upper(), []).append((cc, mc))
            stem = mn.upper().rsplit(' ', 1)[0] if ' ' in mn else mn.upper()
            name_to_locs.setdefault(stem, []).append((cc, mc))
    return name_to_locs


def load_pdf_crashes() -> pd.DataFrame:
    df = pd.read_csv(PER_CRASH_CSV)
    df['date'] = pd.to_datetime(df['date']).dt.date
    df['cc'] = df['cc'].astype('Int16')
    df['mc'] = df['mc'].astype('Int16')
    for c in ('driver', 'passenger', 'cyclist', 'pedestrian'):
        df[c] = df[c].astype('Int32')
    df['tk_pdf'] = df[['driver', 'passenger', 'cyclist', 'pedestrian']].sum(axis=1)
    return df


def _normalize_muni_name(name: str) -> str:
    s = re.sub(r'\(cid:\d+\)', '', name or '').strip().upper()
    s = re.sub(r'[_\s]+TWS?P?$', '', s)
    s = re.sub(r'[_\s]+CITY$', '', s)
    s = re.sub(r'[_\s]+BORO(?:UGH)?$', '', s)
    s = re.sub(r'[_\s]+TOWN$', '', s)
    s = re.sub(r'[_\s]+VILLAGE$', '', s)
    return s.strip()


def harmonize(xml: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (harmonized XML DataFrame, residuals report).

    `xml` must have columns cc, mc, dt, tk, dk, ok, pk, bk. The returned
    DataFrame has dk/ok/pk/bk backfilled where possible plus a new
    `type_source` column ('xml', 'pdf', or 'unresolved').
    """
    out = xml.copy()
    out['date'] = pd.to_datetime(out['dt']).dt.date
    out['type_source'] = pd.Series(pd.NA, index=out.index, dtype='string')
    has_types = out[['dk', 'ok', 'pk', 'bk']].notna().all(axis=1)
    out.loc[has_types, 'type_source'] = 'xml'

    pdf = load_pdf_crashes()
    # Restrict PDF to years we can help with (XML typeless rows).
    typeless_years = sorted(out.loc[~has_types, 'dt'].dt.year.unique())
    if typeless_years:
        pdf_window = pdf[pdf['year'].isin(typeless_years)].copy()
    else:
        pdf_window = pdf.iloc[0:0].copy()

    filled = {'dk': {}, 'ok': {}, 'pk': {}, 'bk': {}}
    # Indices already-claimed on each side.
    claimed_xml_idx: set = set()
    claimed_pdf_idx: set = set()
    residuals: list[dict] = []

    # ---- Pass 1: exact (date, cc, mc) match ----
    xml_typeless = out.loc[~has_types].copy()
    for key, xg in xml_typeless.groupby(['date', 'cc', 'mc'], sort=False):
        pg = pdf_window[
            (pdf_window['date'] == key[0])
            & (pdf_window['cc'] == key[1])
            & (pdf_window['mc'] == key[2])
        ]
        if len(pg) and len(pg) == len(xg) and pg['tk_pdf'].sum() == xg['tk'].sum():
            _match_group(xg, pg, filled, claimed_xml_idx, claimed_pdf_idx)

    # ---- Pass 2: same (date, cc), different mc ----
    xml_remaining = xml_typeless.loc[~xml_typeless.index.isin(claimed_xml_idx)]
    pdf_remaining = pdf_window.loc[~pdf_window.index.isin(claimed_pdf_idx)]
    # Only consider PDF rows that have an mc (we'll do cross-county in pass 3)
    pdf_pass2 = pdf_remaining[pdf_remaining['mc'].notna()]
    for key, xg in xml_remaining.groupby(['date', 'cc'], sort=False):
        pg = pdf_pass2[(pdf_pass2['date'] == key[0]) & (pdf_pass2['cc'] == key[1])]
        pg = pg.loc[~pg.index.isin(claimed_pdf_idx)]
        if len(pg) == len(xg) and len(pg) > 0 and pg['tk_pdf'].sum() == xg['tk'].sum():
            _match_group(xg, pg, filled, claimed_xml_idx, claimed_pdf_idx)

    # ---- Pass 3: cross-county via muni name ----
    xml_remaining = xml_typeless.loc[~xml_typeless.index.isin(claimed_xml_idx)]
    pdf_nanmc = pdf_window.loc[~pdf_window.index.isin(claimed_pdf_idx)]
    pdf_nanmc = pdf_nanmc[pdf_nanmc['mc'].isna()]
    name_to_locs = _load_name_to_locs()
    for pidx, pr in pdf_nanmc.iterrows():
        stem = _normalize_muni_name(pr['municipality'])
        if stem not in name_to_locs:
            continue
        for cc, mc in name_to_locs[stem]:
            xg = xml_remaining[
                (xml_remaining['date'] == pr['date'])
                & (xml_remaining['cc'] == cc)
                & (xml_remaining['mc'] == mc)
            ]
            xg = xg.loc[~xg.index.isin(claimed_xml_idx)]
            if len(xg) == 1 and xg.iloc[0]['tk'] == pr['tk_pdf']:
                xidx = xg.index[0]
                filled['dk'][xidx] = pr['driver']
                filled['ok'][xidx] = pr['passenger']
                filled['pk'][xidx] = pr['pedestrian']
                filled['bk'][xidx] = pr['cyclist']
                claimed_xml_idx.add(xidx)
                claimed_pdf_idx.add(pidx)
                break

    # ---- Pass 4: same-date pairing (muni disagreement between sources) ----
    # Picks up pre-rename muni names (e.g. "Washington Twp" -> "Robbinsville"
    # in Mercer cc=11 mc=12), OCR truncations, and typos that Pass 3 missed.
    xml_remaining = xml_typeless.loc[~xml_typeless.index.isin(claimed_xml_idx)]
    pdf_remaining = pdf_window.loc[~pdf_window.index.isin(claimed_pdf_idx)]
    for date, xg in xml_remaining.groupby('date', sort=False):
        pg = pdf_remaining[pdf_remaining['date'] == date]
        pg = pg.loc[~pg.index.isin(claimed_pdf_idx)]
        if len(xg) == len(pg) and len(pg) > 0 and xg['tk'].sum() == pg['tk_pdf'].sum():
            _match_group(xg, pg, filled, claimed_xml_idx, claimed_pdf_idx)

    # ---- Report residuals ----
    xml_unresolved = xml_typeless.loc[~xml_typeless.index.isin(claimed_xml_idx)]
    for _, r in xml_unresolved.iterrows():
        residuals.append({
            'kind': 'xml_only',
            'date': r['date'],
            'cc': int(r['cc']),
            'mc': int(r['mc']),
            'tk': int(r['tk']),
            'location': r.get('location'),
        })
    pdf_unresolved = pdf_window.loc[~pdf_window.index.isin(claimed_pdf_idx)]
    for _, r in pdf_unresolved.iterrows():
        residuals.append({
            'kind': 'pdf_only',
            'date': r['date'],
            'cc': None if pd.isna(r['cc']) else int(r['cc']),
            'mc': None if pd.isna(r['mc']) else int(r['mc']),
            'tk': int(r['tk_pdf']),
            'municipality': r['municipality'],
        })

    # Apply fills.
    for col in ('dk', 'ok', 'pk', 'bk'):
        if filled[col]:
            out.loc[list(filled[col]), col] = pd.Series(filled[col])
    if claimed_xml_idx:
        out.loc[list(claimed_xml_idx), 'type_source'] = 'pdf'
    still_na = out[['dk', 'ok', 'pk', 'bk']].isna().any(axis=1)
    out.loc[still_na, 'type_source'] = 'unresolved'

    out = out.drop(columns=['date'])
    return out, pd.DataFrame(residuals)


def _match_group(xg, pg, filled, claimed_xml_idx, claimed_pdf_idx):
    """Pair up rows in two groups of equal length and equal tk sum."""
    xg_sorted = xg.sort_values('tk', ascending=False)
    pg_sorted = pg.sort_values('tk_pdf', ascending=False)
    for (xidx, xrow), (pidx, prow) in zip(xg_sorted.iterrows(), pg_sorted.iterrows()):
        if xrow['tk'] != prow['tk_pdf']:
            return  # abort — tk values disagree when sorted
        filled['dk'][xidx] = prow['driver']
        filled['ok'][xidx] = prow['passenger']
        filled['pk'][xidx] = prow['pedestrian']
        filled['bk'][xidx] = prow['cyclist']
        claimed_xml_idx.add(xidx)
        claimed_pdf_idx.add(pidx)

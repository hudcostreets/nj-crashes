"""CLI: export NJSP↔NJDOT match-review data to JSON for the frontend UI."""
import json
from pathlib import Path

import click
import pandas as pd

from .base import command

PASS_DESCRIPTIONS = {
    0: "Manual override (from `njsp_njdot_manual_matches.csv`)",
    1: "Exact `(date, cc, mc)` with equal row count + `tk` sum",
    2: "Same `(date, cc)`, different `mc` — route+mp agreement",
    3: "Same `date`, cross-county — route+mp agreement",
    4: "Date ±1 day — route+mp agreement",
    5: "Same `(date, cc, tk)`, time-of-day within ±3 hours",
    6: "Same `(date, cc, tk, pk)` — pedestrians-killed decomposition",
    7: "Route+mp agree, `tk` disagrees (≤ 2 apart)",
    8: "Same `(date, cc)`, street-name fuzzy match, `tk` within 2",
}


def _jsonable(val):
    """Coerce pandas/numpy values to JSON-safe primitives."""
    if val is None:
        return None
    if isinstance(val, float) and pd.isna(val):
        return None
    if isinstance(val, (pd.Timestamp,)):
        return val.strftime('%Y-%m-%d')
    if hasattr(val, 'isoformat'):
        return val.isoformat() if hasattr(val, 'year') else None
    try:
        if pd.isna(val):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(val, 'item'):
        return val.item()
    return val


def _row_dict(row, cols):
    return {c: _jsonable(row.get(c)) for c in cols}


@command
@click.option('-o', '--out', 'out_path', default='www/public/match-review.json', help="Output JSON path")
def export_match_review(out_path):
    """Export match + candidates + manual-matches as JSON for /match-review UI."""
    njsp = pd.read_parquet('njsp/data/crashes.parquet')
    njdot = pd.read_parquet('njdot/data/crashes.parquet')
    matches = pd.read_parquet('njsp/data/njsp_njdot_match.parquet')
    candidates = pd.read_csv('njsp/data/njsp_njdot_candidates.csv')
    manual = pd.read_csv('njsp/data/njsp_njdot_manual_matches.csv')

    njsp = njsp.reset_index().rename(columns={'id': 'njsp_id'})
    njsp['date'] = njsp['dt'].dt.strftime('%Y-%m-%d')
    njsp_cols = ['njsp_id', 'date', 'cc', 'mc', 'tk', 'highway', 'location', 'street']
    njsp_view = njsp[njsp_cols].set_index('njsp_id')

    njdot_fatal = njdot[njdot['severity'] == 'f'].copy()
    njdot_fatal['date'] = njdot_fatal['dt'].dt.strftime('%Y-%m-%d')
    njdot_cols = ['year', 'cc', 'mc', 'case', 'date', 'tk', 'route', 'mp', 'road', 'cross_street']
    njdot_view = njdot_fatal.set_index(['year', 'cc', 'mc', 'case'])[
        [c for c in njdot_cols if c not in ('year', 'cc', 'mc', 'case')]
    ]

    pairs_by_pass: dict[int, list[dict]] = {}
    for _, m in matches.iterrows():
        p = int(m['pass'])
        njsp_id = int(m['njsp_id'])
        pk = (int(m['year']), int(m['cc']), int(m['mc']), str(m['case']))
        s_row = njsp_view.loc[njsp_id] if njsp_id in njsp_view.index else None
        d_row = njdot_view.loc[pk] if pk in njdot_view.index else None
        pair = {
            'njsp_id': njsp_id,
            'pass': p,
            'njsp': {
                'date': _jsonable(s_row['date']) if s_row is not None else None,
                'cc': _jsonable(s_row['cc']) if s_row is not None else None,
                'mc': _jsonable(s_row['mc']) if s_row is not None else None,
                'tk': _jsonable(m['tk_njsp']),
                'highway': _jsonable(s_row['highway']) if s_row is not None else None,
                'location': _jsonable(s_row['location']) if s_row is not None else None,
                'street': _jsonable(s_row['street']) if s_row is not None else None,
            },
            'njdot': {
                'year': pk[0],
                'cc': pk[1],
                'mc': pk[2],
                'case': pk[3],
                'date': _jsonable(d_row['date']) if d_row is not None else None,
                'tk': _jsonable(m['tk_njdot']),
                'route': _jsonable(d_row['route']) if d_row is not None else None,
                'mp': _jsonable(d_row['mp']) if d_row is not None else None,
                'road': _jsonable(d_row['road']) if d_row is not None else None,
                'cross_street': _jsonable(d_row['cross_street']) if d_row is not None else None,
            },
        }
        pairs_by_pass.setdefault(p, []).append(pair)

    passes = []
    for p in sorted(pairs_by_pass.keys()):
        passes.append({
            'pass': p,
            'description': PASS_DESCRIPTIONS.get(p, f'Pass {p}'),
            'count': len(pairs_by_pass[p]),
            'pairs': pairs_by_pass[p],
        })

    cand_cols = list(candidates.columns)
    cand_list = [{c: _jsonable(v) for c, v in row.items()} for _, row in candidates.iterrows()]

    manual_list = [{c: _jsonable(v) for c, v in row.items()} for _, row in manual.iterrows()]

    njsp_scope = njsp[njsp['dt'].dt.year.between(2008, 2023)]
    njdot_scope = njdot_fatal[njdot_fatal['year'].between(2008, 2023)]
    matched_njsp_ids = set(int(x) for x in matches['njsp_id'].tolist())
    matched_njdot_keys = set(
        (int(r['year']), int(r['cc']), int(r['mc']), str(r['case']))
        for _, r in matches.iterrows()
    )
    njdot_scope_keys = set(
        (int(r['year']), int(r['cc']), int(r['mc']), str(r['case']))
        for _, r in njdot_scope.iterrows()
    )

    summary = {
        'njsp_total': int(len(njsp_scope)),
        'njdot_total': int(len(njdot_scope)),
        'matched': int(len(matches)),
        'njsp_residual': int(len(njsp_scope) - len(matched_njsp_ids & set(int(x) for x in njsp_scope['njsp_id']))),
        'njdot_residual': int(len(njdot_scope_keys - matched_njdot_keys)),
        'years': [2008, 2023],
    }

    payload = {
        'summary': summary,
        'passes': passes,
        'candidates': {
            'columns': cand_cols,
            'rows': cand_list,
        },
        'manual': manual_list,
    }

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w') as f:
        json.dump(payload, f, separators=(',', ':'))
    return f"Exported match review: {summary['matched']} matches, {len(cand_list)} candidates → {out_path}"

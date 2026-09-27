"""Paged ArcGIS FeatureServer queries → DataFrames (NJDOT Roadway Network, NJOGIS NG9-1-1 centerlines).

Queries are POSTed (long `IN (…)` clauses break GET), paged by `resultOffset` in `OBJECTID` order,
and retried. Geometry comes back as per-feature `paths`; `explode_paths` turns those into one row
per path with `x` / `y` (lon / lat, EPSG:4326) and, for M-aware layers, `m` list columns.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from time import sleep

import pandas as pd
import requests

from nj_crashes.utils.log import err

RETRIES = 5
THREADS = 8
TIMEOUT = 180


def post(url: str, params: dict) -> dict:
    """POST `params` to `url` (`f=json`), retrying transport errors and ArcGIS `error` bodies."""
    last = None
    for attempt in range(RETRIES):
        try:
            r = requests.post(url, data={'f': 'json', **params}, timeout=TIMEOUT)
            r.raise_for_status()
            j = r.json()
            if 'error' in j:
                raise RuntimeError(f'ArcGIS error: {j["error"]}')
            return j
        except (requests.RequestException, RuntimeError, ValueError) as e:
            last = e
            err(f'  retry {attempt + 1}/{RETRIES} ({url}): {str(e)[:200]}')
            sleep(2 ** attempt)
    raise RuntimeError(f'{url}: failed after {RETRIES} attempts: {last}')


def layer_info(url: str) -> dict:
    """The layer's JSON description (`fields`, `editingInfo`, `maxRecordCount`, …)."""
    return post(url, {})


def edit_dates(info: dict) -> dict[str, str]:
    """`editingInfo` epoch-ms timestamps → ISO-8601 UTC strings (`dataLastEditDate`, …)."""
    out = {}
    for k, v in sorted((info.get('editingInfo') or {}).items()):
        if isinstance(v, (int, float)):
            out[k] = datetime.fromtimestamp(v / 1000, tz=timezone.utc).isoformat()
    return out


def coded_domains(info: dict) -> dict[str, dict[str, str]]:
    """`{field: {code: name}}` for the layer's coded-value domains."""
    return {
        f['name']: {str(cv['code']): cv['name'] for cv in f['domain']['codedValues']}
        for f in info['fields']
        if (f.get('domain') or {}).get('type') == 'codedValue'
    }


def query(
    url: str,
    where: str = '1=1',
    out_fields: list[str] | None = None,
    geometry: bool = False,
    return_m: bool = False,
    bbox: tuple[float, float, float, float] | None = None,
    page: int | None = None,
) -> list[dict]:
    """All features matching `where` (and intersecting `bbox`, lon/lat), as ArcGIS feature dicts."""
    base = {'where': where}
    if bbox:
        w, s, e, n = bbox
        base |= {
            'geometry': f'{w},{s},{e},{n}', 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326,
            'spatialRel': 'esriSpatialRelIntersects',
        }
    cnt = post(f'{url}/query', base | {'returnCountOnly': 'true'})['count']
    page = page or layer_info(url).get('maxRecordCount', 1000)
    err(f'{url}: {cnt:,} features (where={where[:80]!r}{f", bbox={bbox}" if bbox else ""})')
    params = base | {
        'outFields': ','.join(out_fields) if out_fields else '*',
        'returnGeometry': str(geometry).lower(),
        'orderByFields': 'OBJECTID',
        'resultRecordCount': page,
    }
    if geometry:
        params |= {'outSR': 4326, 'geometryPrecision': 7}
    if return_m:
        params['returnM'] = 'true'

    def one(offset: int) -> list[dict]:
        return post(f'{url}/query', params | {'resultOffset': offset})['features']

    with ThreadPoolExecutor(THREADS) as ex:
        feats = [f for fs in ex.map(one, range(0, cnt, page)) for f in fs]
    if len(feats) != cnt:
        raise RuntimeError(f'{url}: expected {cnt} features, got {len(feats)} (source edited mid-fetch?)')
    return feats


def explode_paths(feats: list[dict], m: bool = False) -> pd.DataFrame:
    """One row per feature *path*: the feature's attributes + `part` (path index), `x`, `y` (and
    `m`) lists. Features without geometry get no rows."""
    rows = []
    for f in feats:
        attrs = f['attributes']
        for part, path in enumerate((f.get('geometry') or {}).get('paths') or []):
            row = {**attrs, 'part': part, 'x': [v[0] for v in path], 'y': [v[1] for v in path]}
            if m:
                row['m'] = [v[2] if len(v) > 2 else None for v in path]
            rows.append(row)
    return pd.DataFrame(rows)

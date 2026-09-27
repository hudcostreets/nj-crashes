"""Fetch the road-network sources behind `njdot roads build` (specs/road-data-v3.md):

- **NJDOT Roadway Network** (`RN_URL`): NJDOT's LRS, one polyline per SRI (piece), M-aware (the
  milepost on every vertex). Geometry + SRI/MP + the official `SLD_NAME`.
- **NJOGIS Road Centerlines of NJ (NG9-1-1)** (`NG_URL` layer 0) + its **Road Name Alias** table
  (layer 1): per-segment local street names (`PRIMENAME`), route shields, county/muni, and an
  `SRI` tag; the alias table adds e.g. "Kennedy Boulevard" / "County Route 501" to
  "J F Kennedy Boulevard". No milepost: `njdot.road_net` projects segments onto the NJDOT lines.

Each output parquet carries the source URL and its `editingInfo` dates (`dataLastEditDate`, …) in
the file's key-value metadata (`src_url`, `src_dataLastEditDate`, …), so its vintage is known.
"""
import json

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from nj_crashes.utils.log import err
from njdot.arcgis import coded_domains, edit_dates, explode_paths, layer_info, query

RN_URL = 'https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/NJDOT_Roadway_Network/FeatureServer/0'
NG_URL = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer'

RN_FIELDS = [
    'OBJECTID', 'SRI', 'MP_START', 'MP_END', 'DIRECTION', 'SLD_NAME', 'PARENT_SRI', 'PARENT_MP_START',
    'PARENT_MP_END', 'ACTIVE', 'ROUTE_SUBTYPE', 'ROAD_NUM',
]
NG_FIELDS = [
    'OBJECTID', 'RCL_NGUID', 'STNAMETYPE', 'PRIMENAME', 'LST_PNAME', 'SHLD_TYPE', 'SHLDSUBTYP', 'SHLD_NUM',
    'COUNTY_L', 'COUNTY_R', 'INCMUNI_L', 'INCMUNI_R', 'ROADCLASS', 'JURISDICTN', 'STATUSTYP', 'SRI',
]
ALIAS_FIELDS = [
    'OBJECTID', 'RCL_NGUID', 'ANAME_TYP', 'ANAME_RANK', 'AST_PNAME', 'ALST_PNAME', 'SHLD_TYPE', 'SHLDSUBTYP',
    'SHLD_NUM',
]
# NJ's county codes (`cc`) are the counties in alphabetical order.
NJ_COUNTIES = [
    'Atlantic', 'Bergen', 'Burlington', 'Camden', 'Cape May', 'Cumberland', 'Essex', 'Gloucester', 'Hudson',
    'Hunterdon', 'Mercer', 'Middlesex', 'Monmouth', 'Morris', 'Ocean', 'Passaic', 'Salem', 'Somerset', 'Sussex',
    'Union', 'Warren',
]
CC = {name: i + 1 for i, name in enumerate(NJ_COUNTIES)}
# Dev subsets: Hudson County's bbox, and NG911's GNIS code for it.
HUDSON_BBOX = (-74.17, 40.64, -73.98, 40.83)
HUDSON_GNIS = '882278'
ALIAS_ID_CHUNK = 200


def src_meta(url: str, info: dict, **extra) -> dict[str, str]:
    meta = {'src_url': url} | {f'src_{k}': v for k, v in edit_dates(info).items()}
    # Subset filters only (a statewide pull records none).
    return meta | {f'src_{k}': str(v) for k, v in extra.items() if v is not None and v != '1=1'}


def write_parquet(df: pd.DataFrame, path: str, meta: dict[str, str]):
    """Write `df` (zstd) with `meta` merged into the parquet key-value metadata."""
    table = pa.Table.from_pandas(df, preserve_index=False)
    table = table.replace_schema_metadata({**(table.schema.metadata or {}), **{k.encode(): v.encode() for k, v in meta.items()}})
    pq.write_table(table, path, compression='zstd', row_group_size=50_000)
    err(f'  {path}: {len(df):,} rows; {json.dumps(meta)}')


def read_meta(path: str) -> dict[str, str]:
    """The `src_*` key-value metadata written by `write_parquet`."""
    md = pq.read_schema(path).metadata or {}
    return {k.decode(): v.decode() for k, v in md.items() if k.startswith(b'src_')}


def fetch_network(where: str = '1=1', bbox: tuple | None = None) -> tuple[pd.DataFrame, dict[str, str]]:
    """NJDOT Roadway Network lines: one row per feature path, `x`/`y`/`m` vertex lists, sorted
    `(SRI, MP_START, OBJECTID, part)`."""
    info = layer_info(RN_URL)
    feats = query(RN_URL, where=where, out_fields=RN_FIELDS, geometry=True, return_m=True, bbox=bbox)
    df = explode_paths(feats, m=True)
    df = df.sort_values(['SRI', 'MP_START', 'OBJECTID', 'part'], kind='stable').reset_index(drop=True)
    return df, src_meta(RN_URL, info, where=where, bbox=bbox)


def decode_places(df: pd.DataFrame, domains: dict[str, dict[str, str]]) -> pd.DataFrame:
    """NG911 GNIS county / muni codes → names: `county_{l,r}` ("Hudson"), `cc_{l,r}` (NJ county
    code; null out of state), `muni_{l,r}` ("Jersey City")."""
    for side in ('L', 'R'):
        s = side.lower()
        county = df[f'COUNTY_{side}'].map(domains.get(f'COUNTY_{side}', {})).str.replace(r' County$', '', regex=True)
        df[f'county_{s}'] = county.astype('string')
        df[f'cc_{s}'] = county.map(CC).astype('Int8')
        # Muni domain names are "County, Muni".
        muni = df[f'INCMUNI_{side}'].map(domains.get(f'INCMUNI_{side}', {}))
        df[f'muni_{s}'] = muni.str.split(', ', n=1).str[-1].astype('string')
    return df


def fetch_ng911(where: str = '1=1', bbox: tuple | None = None) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, str], dict[str, str]]:
    """NG9-1-1 centerlines (one row per path, `x`/`y` lists, decoded county/muni), and the alias
    rows for those segments (all of them, for a statewide pull). Each with its source metadata."""
    cl_url, al_url = f'{NG_URL}/0', f'{NG_URL}/1'
    cl_info, al_info = layer_info(cl_url), layer_info(al_url)
    feats = query(cl_url, where=where, out_fields=NG_FIELDS, geometry=True, bbox=bbox)
    cl = decode_places(explode_paths(feats), coded_domains(cl_info))
    cl = cl.sort_values(['RCL_NGUID', 'OBJECTID', 'part'], kind='stable').reset_index(drop=True)
    if where == '1=1' and bbox is None:
        al = pd.DataFrame([f['attributes'] for f in query(al_url, out_fields=ALIAS_FIELDS)])
    else:
        ids = sorted(cl['RCL_NGUID'].dropna().unique())
        rows = []
        for i in range(0, len(ids), ALIAS_ID_CHUNK):
            clause = 'RCL_NGUID IN ({})'.format(','.join(f"'{x}'" for x in ids[i:i + ALIAS_ID_CHUNK]))
            rows += [f['attributes'] for f in query(al_url, where=clause, out_fields=ALIAS_FIELDS)]
        al = pd.DataFrame(rows, columns=ALIAS_FIELDS)
    al = al.sort_values(['RCL_NGUID', 'ANAME_RANK', 'OBJECTID'], kind='stable').reset_index(drop=True)
    return cl, al, src_meta(cl_url, cl_info, where=where, bbox=bbox), src_meta(al_url, al_info)

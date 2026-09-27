"""Project raw crashes onto the map's column set, with effective lat/lon.

`_build_base` is what every map-facing export starts from: it resolves each
crash's coordinates (interpolated milepost position when available, else the
original geocode, NJ-bbox-guarded), records which source won in `geocode_src`,
drops the ungeocoded, and narrows dtypes.

Map-facing callers (`njdot export_map_v2`, `njdot compute cells raw`) also pass
the recovered-points sidecar (`CRASH_RECOVERED_POINTS`, see "Recovered points"
below), which adds / moves / removes the points `njdot roads build`'s location
recovery decided on. `roads build` itself calls `_build_base` without it: its
recovery must see only NJDOT's points (specs/crash-location-recovery.md §
"Map / cells integration").

Extracted from `njdot/cli/export_map_data.py` — the v1 map export
(`by-year/`, `by-year-county/`, `hex-r{N}/`), whose own outputs stopped being
fetched long ago and whose H3 aggregation went away with
`specs/h3-removal.md` Phase 3. This helper was the only part with live
callers: `njdot export_map_v2` and `njdot compute cells raw`.
"""
from os.path import exists

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from nj_crashes.utils.log import err
from njdot.paths import CRASH_RECOVERED_POINTS

SEVERITY_ORDER = ["f", "i", "p"]

# Columns we ship to the map (small schema; keep narrow ints where possible).
MAP_COLS = [
    "dt", "cc", "mc", "case",
    "tk", "ti", "pk", "pi", "tv",
    "severity", "road", "cross_street", "route", "mp", "sri",
    "lat", "lon", "geocode_src",
]

# `geocode_src` values, in precedence order (see `_build_base`):
# - `interpolated`: NJDOT's `ilat` / `ilon` (from its SRI / MP; incl. the NJSP geocode backfill);
# - `original`: the police-reported `olat` / `olon`, inside NJ;
# - `corrected`: recovery's point in place of an NJDOT one judged wrong (overrides both above);
# - `recovered`: recovery's point for a crash with neither (fills only).
GEOCODE_SRCS = ("interpolated", "original", "corrected", "recovered")


def effective_points(df: pd.DataFrame) -> pd.DataFrame:
    """Each crash's map point before any recovery: `lat` / `lon` (float32; NaN where none) and
    `geocode_src` (`interpolated` / `original` / `none`), indexed like `df`. Needs `ilat`, `ilon`,
    `olat`, `olon`."""
    # Prefer interpolated (ilat/ilon), fall back to original (olat/olon)
    ilat = df["ilat"]
    ilon = df["ilon"]
    olat = df["olat"].where(_in_nj_bbox(df["olat"], df["olon"]))
    olon = df["olon"].where(_in_nj_bbox(df["olat"], df["olon"]))

    lat = ilat.fillna(olat)
    lon = ilon.fillna(olon)

    src = np.full(len(df), "none", dtype=object)
    src[ilat.notna().values] = "interpolated"
    needs_o = ilat.isna().values & olat.notna().values
    src[needs_o] = "original"
    return pd.DataFrame({
        "lat": lat.astype("float32"),
        "lon": lon.astype("float32"),
        "geocode_src": src,
    }, index=df.index)


def _build_base(
    df: pd.DataFrame,
    keep_severities: set[str],
    recovered: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Project to map columns, compute effective lat/lon + provenance.

    `recovered` (`read_recovered_points`; needs `df` to carry `id` and `RECOVERED_KEY`): per
    crash, NJDOT's point (`interpolated`, else `original`) stands unless the sidecar says it's
    wrong — `corrected` moves it to recovery's point, `dropped` removes it; a crash without one
    takes recovery's (`recovered`). A `recovered` row for a crash that has an NJDOT point leaves it
    (NJDOT's wins; only possible when the sidecar was built from other inputs)."""
    if keep_severities:
        df = df[df["severity"].isin(keep_severities)].copy()
    else:
        df = df.copy()

    pts = effective_points(df)
    if recovered is not None:
        pts = apply_recovered_points(pts, match_recovered_points(df, recovered))
    df["lat"] = pts["lat"]
    df["lon"] = pts["lon"]
    df["geocode_src"] = pts["geocode_src"]

    keep = df[df["lat"].notna() & df["lon"].notna()].copy()

    # Narrow types
    keep["cc"] = keep["cc"].astype("Int8")
    keep["mc"] = keep["mc"].astype("Int16")
    for c in ("tk", "ti", "pk", "pi", "tv"):
        keep[c] = keep[c].fillna(0).astype("int16")
    # Route is often numeric but we store as str for dictionary-encoding
    keep["route"] = keep["route"].astype("string")
    keep["sri"] = keep["sri"].astype("string")
    # Road is the human-readable label ("ROUTE 9", "CALDERON AVENUE", etc.).
    # Cross_street is its perpendicular at the crash location ("CR 630").
    keep["road"] = keep["road"].fillna("").astype("string").str.strip()
    keep["cross_street"] = keep["cross_street"].fillna("").astype("string").str.strip()
    keep["mp"] = keep["mp"].astype("float32")
    keep["severity"] = keep["severity"].astype("string")
    keep["case"] = keep["case"].astype("string")
    keep["geocode_src"] = keep["geocode_src"].astype("string")
    # Date as epoch minutes (int32 fits years 1970..6000ish). Source is
    # datetime64[us] in the parquet — microseconds to minutes divides by 60e6.
    keep["dt"] = (keep["dt"].astype("datetime64[ns]").astype("int64") // 60_000_000_000).astype("int32")
    return keep[MAP_COLS]


def _in_nj_bbox(lat, lon) -> pd.Series:
    """True for coords inside a generous NJ bounding box, excluding 0/NaN."""
    lat_ok = lat.between(38.9, 41.4)
    lon_ok = lon.between(-75.7, -73.9)
    return lat_ok & lon_ok


# ---------------------------------------------------------------------------------------------
# Recovered points: `njdot roads build` → `CRASH_RECOVERED_POINTS` → `_build_base`.
#
# One row per crash whose map point recovery changes (`kind`):
# - `recovered`: no NJDOT point; recovery placed it (`intersection` / `route_xs` / `sri_calib`).
# - `corrected`: NJDOT's point was judged wrong (computed from an SRI / MP the build replaced:
#   a 2001–02 county route coded to a state route's SRI, a curated `recode` rule; or a coded
#   crash towns from its muni whose NJDOT point is out of town too) and recovery has another:
#   re-located, the SRI / MP's point on today's network (recodes), or the police point.
# - `dropped`: NJDOT's point was judged wrong and nothing replaces it.
#
# Crashes are keyed by `id` (the canonical crash key) where they have one. AASHTO rows (2023+)
# have none, and `(year, cc, mc, case)` isn't unique among them (~1.6k duplicate keys: the same
# crash reported twice, with / without a point), so they're keyed by `RECOVERED_KEY`; a key whose
# crashes' outcomes differ is left out (its crashes keep NJDOT's points).
# ---------------------------------------------------------------------------------------------
RECOVERED_KINDS = ("recovered", "corrected", "dropped")
RECOVERED_KEY = ["year", "cc", "mc", "case", "dt", "road", "cross_street"]
RECOVERED_COLS = ["id", *RECOVERED_KEY, "kind", "loc_source", "lat", "lon"]
RECOVERED_DTYPES = {
    "id": "Int64", "year": "int16", "cc": "Int8", "mc": "Int16", "case": "string",
    "dt": "datetime64[us]", "road": "string", "cross_street": "string",
    "kind": "string", "loc_source": "string", "lat": "float32", "lon": "float32",
}


def _key_frame(df: pd.DataFrame) -> pd.DataFrame:
    """`RECOVERED_KEY` of `df`, normalized so the roads build's frame and the map exports' (read
    with other column sets) compare equal: ints (NA → -1), strings (NA → ""), `dt` as int64 ns."""
    k = pd.DataFrame(index=df.index)
    for c in ("year", "cc", "mc"):
        k[c] = pd.to_numeric(df[c], errors="coerce").fillna(-1).astype("int64")
    for c in ("case", "road", "cross_street"):
        k[c] = df[c].astype("string").fillna("").astype(str)
    k["dt"] = pd.to_datetime(df["dt"]).astype("datetime64[ns]").astype("int64")
    return k


def recovered_points(
    keys: pd.DataFrame,
    before: pd.DataFrame,
    after: pd.DataFrame,
    loc_source: pd.Series,
) -> pd.DataFrame:
    """The sidecar (`RECOVERED_COLS`) from every crash's `keys` (`id` + `RECOVERED_KEY`), its map
    point `before` recovery (`effective_points`' `lat` / `lon`) and `after` (NaN where none), and
    `loc_source`; all indexed alike. Rows: crashes whose point changes (`RECOVERED_KINDS`), sorted
    `(id, *RECOVERED_KEY)` (AASHTO's null ids last)."""
    has0 = before["lat"].notna() & before["lon"].notna()
    has1 = after["lat"].notna() & after["lon"].notna()
    same = has0 & has1 & before["lat"].eq(after["lat"]) & before["lon"].eq(after["lon"])
    kind = pd.Series(
        np.select([~has0 & has1, has0 & has1 & ~same, has0 & ~has1], list(RECOVERED_KINDS), ""),
        index=keys.index,
    )
    df = keys[["id", *RECOVERED_KEY]].assign(
        kind=kind,
        loc_source=loc_source.astype("string"),
        lat=after["lat"].where(has1).astype("float32"),
        lon=after["lon"].where(has1).astype("float32"),
    )
    no_id = df["id"].isna()
    if no_id.any():
        # A key several AASHTO crashes share: in the sidecar only if they all come out the same
        # (then once); otherwise none are.
        a = df[no_id]
        k = _key_frame(a)
        outcome = a[["kind", "lat", "lon"]].astype({"kind": str})
        grp = k.assign(_o=pd.util.hash_pandas_object(outcome, index=False).to_numpy())
        n_out = grp.groupby(RECOVERED_KEY)["_o"].transform("nunique")
        ambiguous = a.index[(n_out > 1).to_numpy()]
        dup = a.index[k.duplicated().to_numpy()]
        n_amb = int(a.loc[ambiguous, "kind"].ne("").sum())
        if n_amb:
            err(f"  recovered points: {n_amb:,} AASHTO crashes left out (a shared key, different outcomes)")
        df = df.drop(index=ambiguous.union(dup))
    df = df[df["kind"].ne("")]
    has_id = df["id"].notna()
    for c in ("dt", "road", "cross_street"):
        # Only AASHTO rows' key needs them.
        df[c] = df[c].where(~has_id)
    df = df.astype(RECOVERED_DTYPES)
    return df.sort_values(["id", *RECOVERED_KEY], na_position="last", kind="stable").reset_index(drop=True)[RECOVERED_COLS]


def write_recovered_points(df: pd.DataFrame, path: str):
    """Write the sidecar (zstd; no pandas / arrow schema metadata, so the bytes depend only on the
    rows)."""
    table = pa.Table.from_pandas(df[RECOVERED_COLS].astype(RECOVERED_DTYPES), preserve_index=False).replace_schema_metadata(None)
    pq.write_table(table, path, compression="zstd", store_schema=False, row_group_size=1 << 20)


def read_recovered_points(path: str = CRASH_RECOVERED_POINTS) -> pd.DataFrame | None:
    """The sidecar at `path` (`RECOVERED_DTYPES`), or None if there is none (then the map draws
    NJDOT's points only)."""
    if not exists(path):
        err(f"  (no recovered points at {path}; NJDOT points only)")
        return None
    df = pd.read_parquet(path).astype(RECOVERED_DTYPES)
    err(f"  recovered points: {len(df):,} from {path} ({', '.join(f'{k} {v:,}' for k, v in df['kind'].value_counts().items())})")
    return df


def match_recovered_points(df: pd.DataFrame, pts: pd.DataFrame) -> pd.DataFrame:
    """`pts` (the sidecar) rows matched to `df`'s crashes: `kind`, `lat`, `lon`, indexed by the
    matched subset of `df.index`. `df` rows with an `id` match on it, the others (AASHTO) on
    `RECOVERED_KEY`; the sidecar must be unique on both."""
    by_id = pts[pts["id"].notna()]
    no_id = pts[pts["id"].isna()]
    n_dup = int(by_id["id"].duplicated().sum())
    assert n_dup == 0, f"recovered points: {n_dup} duplicate ids"
    cols = ["kind", "lat", "lon"]
    df_id = pd.to_numeric(df["id"], errors="coerce") if "id" in df else pd.Series(np.nan, index=df.index)
    has_id = df_id.notna()
    left = pd.DataFrame({"id": df_id[has_id].astype("int64").to_numpy(), "_row": df.index[has_id]})
    m1 = left.merge(by_id[["id", *cols]].astype({"id": "int64"}), on="id", how="inner")
    parts = [m1.set_index("_row")[cols]]
    if len(no_id):
        pk = _key_frame(no_id)
        n_dup = int(pk.duplicated().sum())
        assert n_dup == 0, f"recovered points: {n_dup} duplicate AASHTO keys"
        right = pk.assign(**{c: no_id[c].to_numpy() for c in cols})
        left = _key_frame(df[~has_id]).rename_axis("_row").reset_index()
        m2 = left.merge(right, on=RECOVERED_KEY, how="inner")
        parts.append(m2.set_index("_row")[cols])
    out = pd.concat(parts)
    out.index.name = None
    return out.sort_index()


def apply_recovered_points(pts: pd.DataFrame, m: pd.DataFrame) -> pd.DataFrame:
    """`effective_points` output `pts` with matched sidecar rows `m` (`match_recovered_points`)
    applied, by `_build_base`'s precedence."""
    pts = pts.copy()
    has = pts["lat"].notna() & pts["lon"].notna()
    kind = m["kind"]
    fill = m.index[(kind.eq("recovered") & ~has.reindex(m.index)).to_numpy()]
    move = m.index[kind.eq("corrected").to_numpy()]
    drop = m.index[kind.eq("dropped").to_numpy()]
    n_kept = int(kind.eq("recovered").sum()) - len(fill)
    for ix, src in ((fill, "recovered"), (move, "corrected")):
        pts.loc[ix, "lat"] = m.loc[ix, "lat"].astype("float32")
        pts.loc[ix, "lon"] = m.loc[ix, "lon"].astype("float32")
        pts.loc[ix, "geocode_src"] = src
    pts.loc[drop, ["lat", "lon"]] = np.nan
    pts.loc[drop, "geocode_src"] = "none"
    err(f"  recovered points applied: {len(fill):,} recovered, {len(move):,} corrected, {len(drop):,} dropped"
        + (f" ({n_kept:,} `recovered` rows kept NJDOT's point)" if n_kept else ""))
    return pts

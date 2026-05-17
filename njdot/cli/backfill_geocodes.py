"""Backfill missing lat/lon for fatal crashes via NJSP `LOCATION` parsing.

Many NJDOT fatal crashes (esp. pre-2014) carry no `olat/olon` and no
`sri/mp`, so the existing `Crashes.mp_lls()` interpolation has nothing
to work from. But NJSP's `crash-log.parquet` carries an unstructured
`LOCATION` string with embedded MP info (e.g., "Newark Ave E MP .74"),
and `njsp_njdot_match.parquet` links the two crash datasets.

This stage:
1. Joins NJDOT rows missing all of (olat, olon, sri, mp, ilat, ilon)
   against the NJSP match.
2. Parses MP from each matched NJSP `LOCATION`.
3. Resolves the corresponding SRI from `STREET` / `HIGHWAY` + `CCODE`,
   then picks the MP-table row whose `MP` is closest.
4. Writes a sidecar `crashes_geocode_backfill.parquet` with columns
   `(year, cc, mc, case, sri, mp, ilat, ilon, geocode_source)`.

`load_crashes_with_aashto` (or its downstream consumers) merges this
sidecar to fill the gap. The original `crashes.parquet` is left
untouched — provenance stays clean.

Spec: `specs/backfill-fatal-geocodes.md`.
"""
import re
import sys
from functools import partial

import click
import pandas as pd

from .base import njdot
from njdot.paths import CRASHES_GEOCODE_BACKFILL, CRASHES_PQT, DOT_DATA
from nj_crashes.paths import ROOT_DIR

err = partial(print, file=sys.stderr)

DEFAULT_CRASHES = CRASHES_PQT
DEFAULT_MATCH = f"{ROOT_DIR}/njsp/data/njsp_njdot_match.parquet"
DEFAULT_CRASH_LOG = f"{ROOT_DIR}/njsp/data/crash-log.parquet"
DEFAULT_MP = f"{DOT_DATA}/nj_mp_tenths.parquet"
DEFAULT_OUT = CRASHES_GEOCODE_BACKFILL

_MP_RE = re.compile(r"\bMP\s+(\.?\d+(?:\.\d+)?)")

# Highway-style LOCATION prefixes → SRI prefix (3-digit zero-padded
# route number gets inserted in the underscored slot). Matched against
# the literal text before the route number in `LOCATION`.
#
# Examples:
#   "State Highway 440 S MP 25.8"     → 00000440__
#   "Interstate 95 S MP 110.7"        → 00000095__
#   "State/Interstate Authority 95 ...": 00000095__
#   "US 1 N MP ..."                   → 00000001__
#   "County 681 W MP .1 ..."          → CC000681__ (CC = county code)
_HWY_PREFIX_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^State Highway\b", re.I), "state"),
    (re.compile(r"^NJ\b", re.I), "state"),
    (re.compile(r"^State/Interstate Authority\b", re.I), "state"),
    (re.compile(r"^Interstate\b", re.I), "state"),
    (re.compile(r"^I[-\s]?\d", re.I), "state"),
    (re.compile(r"^US\b", re.I), "state"),
    (re.compile(r"^County\b", re.I), "county"),
    (re.compile(r"^CR\b", re.I), "county"),
    (re.compile(r"^Route\b", re.I), "state"),
]
_GSP_RE = re.compile(r"^(GSP|Garden State Parkway)\b", re.I)
_NJTP_RE = re.compile(r"^(NJTP|N\.?J\.?\s*Turnpike|New Jersey Turnpike)\b", re.I)

# Route number after the prefix word. Captures up to the first non-digit
# (e.g., "440" in "State Highway 440 S MP 25.8", "1" in "US 1 N MP 56.1").
_ROUTE_NUM_RE = re.compile(r"(?:^|\s)(\d+)(?=[\s,]|$)")

# GSP & NJTP SRIs (looked up from the MP table once at startup).
_FIXED_SRI = {
    # filled in by `_build_fixed_sri_map` at startup
}


def _build_fixed_sri_map(mp: pd.DataFrame) -> dict[str, str]:
    """Resolve GSP / NJTP / well-known facility SRIs once. The MP table
    has these as exact SLD_NAME matches."""
    out: dict[str, str] = {}
    for key, name in [("GSP", "GARDEN STATE PARKWAY"), ("NJTP", "I-95, N.J. TURNPIKE")]:
        cand = mp[mp["SLD_NAME"].str.upper() == name]
        if len(cand) > 0:
            out[key] = cand["SRI"].iloc[0]
    return out


def _parse_mp(location: str | None) -> float | None:
    if not isinstance(location, str):
        return None
    m = _MP_RE.search(location)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _highway_sri(prefix_kind: str, route_num: int, ccode: int) -> str:
    """Build SRI from (prefix kind, route number, county code).

    State / interstate / US routes: `00000XXX__` (XXX = 3-digit route).
    County routes: `CC000XXX__` (CC = 2-digit county code)."""
    rt = f"{route_num:03d}"
    if prefix_kind == "county":
        return f"{ccode:02d}000{rt}__"
    return f"00000{rt}__"


def _resolve_hwy_sri(location: str, ccode: int, fixed: dict[str, str]) -> str | None:
    """Try to resolve a `LOCATION` like 'State Highway 440 S MP ...' into
    an SRI. Returns None if the prefix doesn't match a known kind or no
    route number follows it."""
    if not isinstance(location, str):
        return None
    if _GSP_RE.match(location):
        return fixed.get("GSP")
    if _NJTP_RE.match(location):
        return fixed.get("NJTP")
    for pat, kind in _HWY_PREFIX_PATTERNS:
        if pat.match(location):
            # Find the route number anywhere in the prefix portion (before MP).
            mp_idx = location.upper().find(" MP ")
            head = location[:mp_idx] if mp_idx >= 0 else location
            m = _ROUTE_NUM_RE.search(head)
            if m:
                try:
                    return _highway_sri(kind, int(m.group(1)), ccode)
                except ValueError:
                    return None
            return None
    return None


def _resolve_street_sri(street: str | None, ccode: int, mp_val: float, mp_df: pd.DataFrame) -> str | None:
    """Resolve a street-style `LOCATION` like 'Newark Ave E MP .74' via
    SLD_NAME match within the county, picking the SRI whose MP-row is
    closest to the parsed `mp_val`."""
    if not isinstance(street, str):
        return None
    upper = street.upper().strip()
    if not upper:
        return None
    cc_prefix = f"{ccode:02d}"
    cand = mp_df[(mp_df["SLD_NAME"].str.upper() == upper) & mp_df["SRI"].str.startswith(cc_prefix)]
    if len(cand) == 0:
        return None
    # Each SRI is a distinct segment; pick the one with a row closest to mp_val.
    by_sri = cand.groupby("SRI")["MP"].apply(lambda s: (s - mp_val).abs().min())
    return by_sri.idxmin()


def _lookup_latlon(sri: str, mp_val: float, mp_df: pd.DataFrame) -> tuple[float, float] | None:
    """Find the MP-table row matching `(sri, mp_val)` (closest MP); return
    (lat, lon) or None if no rows for that SRI."""
    rows = mp_df[mp_df["SRI"] == sri]
    if len(rows) == 0:
        return None
    closest = rows.iloc[(rows["MP"] - mp_val).abs().argsort().iloc[0]]
    return float(closest["lat"]), float(closest["lon"])


@njdot.command("backfill_geocodes")
@click.option("--crashes-path", default=DEFAULT_CRASHES, show_default=True)
@click.option("--match-path", default=DEFAULT_MATCH, show_default=True)
@click.option("--crash-log-path", default=DEFAULT_CRASH_LOG, show_default=True)
@click.option("--mp-path", default=DEFAULT_MP, show_default=True)
@click.option("-o", "--output", default=DEFAULT_OUT, show_default=True)
def backfill_geocodes(crashes_path: str, match_path: str, crash_log_path: str, mp_path: str, output: str):
    err(f"Loading {crashes_path}")
    crashes = pd.read_parquet(crashes_path, columns=["year", "cc", "mc", "case", "tk", "severity", "sri", "mp", "olat", "olon", "ilat", "ilon"])

    # Target: fatal crashes (tk > 0 OR severity == 'f') with no usable geocode.
    is_fatal = (crashes["tk"].fillna(0) > 0) | (crashes["severity"] == "f")
    no_geo = crashes["olat"].isna() & crashes["ilat"].isna()
    no_sri = crashes["sri"].isna() | crashes["mp"].isna()
    targets = crashes[is_fatal & no_geo & no_sri].copy()
    err(f"  {len(targets):,} fatals need backfill (of {is_fatal.sum():,} total fatals)")

    err(f"Loading match table {match_path}")
    match = pd.read_parquet(match_path)[["njsp_id", "year", "cc", "mc", "case"]]

    err(f"Loading NJSP crash log {crash_log_path}")
    log = pd.read_parquet(crash_log_path)
    log = log.reset_index()  # multi-index (accid, sha) → cols
    log = log.rename(columns={"accid": "njsp_id"})
    # Multiple `sha` rows per accid — pick the most recent rundate.
    log = log.sort_values("rundate").drop_duplicates("njsp_id", keep="last")

    err(f"Loading MP table {mp_path}")
    mp_df = pd.read_parquet(mp_path).dropna(subset=["lat", "lon"]).reset_index(drop=True)
    fixed = _build_fixed_sri_map(mp_df)
    err(f"  fixed SRIs: {fixed}")

    # Join targets → match → NJSP log
    merged = targets.merge(match, on=["year", "cc", "mc", "case"], how="inner")
    err(f"  {len(merged):,} backfill candidates have NJSP match")
    merged = merged.merge(log[["njsp_id", "CCODE", "STREET", "HIGHWAY", "LOCATION"]], on="njsp_id", how="left")
    has_loc = merged["LOCATION"].notna()
    err(f"  {has_loc.sum():,} also have NJSP LOCATION")

    out_rows = []
    n_mp_parse_fail = 0
    n_sri_resolve_fail = 0
    n_latlon_fail = 0
    for _, row in merged[has_loc].iterrows():
        mp_val = _parse_mp(row["LOCATION"])
        if mp_val is None:
            n_mp_parse_fail += 1
            continue
        try:
            ccode = int(row["CCODE"])
        except (TypeError, ValueError):
            continue
        sri = _resolve_hwy_sri(row["LOCATION"], ccode, fixed) or _resolve_street_sri(row["STREET"], ccode, mp_val, mp_df)
        if not sri:
            n_sri_resolve_fail += 1
            continue
        latlon = _lookup_latlon(sri, mp_val, mp_df)
        if not latlon:
            n_latlon_fail += 1
            continue
        out_rows.append({
            "year": int(row["year"]),
            "cc": int(row["cc"]),
            "mc": int(row["mc"]),
            "case": row["case"],
            "sri": sri,
            "mp": mp_val,
            "ilat": latlon[0],
            "ilon": latlon[1],
            "geocode_source": "njsp_mp",
        })

    out = pd.DataFrame(out_rows)
    err(f"\nBackfill summary:")
    err(f"  MP-parse fail:    {n_mp_parse_fail:,}")
    err(f"  SRI-resolve fail: {n_sri_resolve_fail:,}")
    err(f"  lat/lon fail:     {n_latlon_fail:,}")
    err(f"  recovered:        {len(out):,} / {has_loc.sum():,} ({100*len(out)/max(has_loc.sum(),1):.1f}%)")

    out.to_parquet(output, index=False)
    from os import stat
    err(f"\nWrote {output} ({len(out):,} rows, {stat(output).st_size/1024:.1f} KB)")
    if len(out):
        err("Sample:")
        err(out.head(5).to_string())

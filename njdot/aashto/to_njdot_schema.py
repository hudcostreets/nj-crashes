#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow", "tqdm"]
# ///
"""Convert AASHTO-schema `crashes.parquet` (output of `normalize.py`)
to the NJDOT-schema used by `njdot/data/crashes.parquet` (2001-2023).

Both schemas hold one row per crash; the AASHTO format uses verbose
human-readable column names and Numetric-defined enumerations, while
the NJDOT format uses terse short names matching the fixed-width
`.txt` file conventions.

Outputs `njdot/data/aashto_combined_crashes.parquet` — a NJDOT-schema
concat of 2024+2025 (or whichever years are present). `agg.py` and
`export_map_data.py` can union this with the existing
`crashes.parquet` to produce 2001–2025 FE artifacts.

Mapping decisions:
  - cc/mc derived from County name + Municipality name via
    `www/public/njdot/cc2mc2mn.json` (matches strict equality first,
    then strips trailing suffix words like `City`/`Twp`/`Boro`).
  - Crashes whose (County, Municipality) can't be looked up are
    *kept* with cc/mc = NaN (FE plots use NaN-aware groupby; map
    points are dropped at the geocode-filter stage).
  - severity inferred from `Total Killed` / `Total Injured`:
      Total Killed > 0           → 'f'
      Total Injured > 0          → 'i'
      else                       → 'p'
  - dt parsed from `Date & Time of Crash` (ISO 8601).
  - cc0/mc0 set equal to cc/mc since AASHTO doesn't expose
    pre-geocoding values.
"""
import json
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd
from tqdm import tqdm

err = partial(print, file=sys.stderr)

CC2MC2MN_PATH = Path("www/public/njdot/cc2mc2mn.json")
SUFFIXES = ("Boro", "City", "Village", "Twp", "Town")

# Aliases for known typos / spelling variants in AASHTO. Mirrors the
# `SHORT_NAME_ALIASES` in `njdot/harmonize_muni_codes.py` but keyed
# at the `(county, municipality)` granularity since AASHTO uses
# different surface forms than the per-table data.
AASHTO_NAME_ALIASES = {
    # (aashto_county, aashto_muni): (canonical_county, canonical_muni)
    ("Bergen", "ElmWood Park Boro"): ("Bergen", "Elmwood Park"),
    ("Camden", "Mount Ephriam Boro"): ("Camden", "Mount Ephraim"),
    ("Bergen", "Ho Ho Kus Boro"): ("Bergen", "Ho-Ho-Kus"),
    ("Ocean", "Pt Pleasant Beach Boro"): ("Ocean", "Point Pleasant Beach"),
    ("Salem", "Lower Alloways Crk Twp"): ("Salem", "Lower Alloways Creek"),
    ("Sussex", "Sandvston Twp"): ("Sussex", "Sandyston"),
    ("Monmouth", "Avon-By-The-Sea Boro"): ("Monmouth", "Avon-by-the-Sea"),
    ("Essex", "South Orange Village Twp"): ("Essex", "South Orange"),
    ("Passaic", "ElmWood Park Boro"): ("Passaic", "Elmwood Park"),
    # Cross-county misclassifications upstream — preserve county AASHTO
    # reported (the user/dashboard may want to know these are flagged)
    # rather than silently re-attribute. Map to None to drop:
    ("Bergen", "Bayonne City"): None,        # Bayonne is in Hudson
    ("Bergen", "Weehawken Twp"): None,       # Weehawken is in Hudson
    ("Union", "Wall Twp"): None,             # Wall is in Monmouth
    ("Middlesex", "Bridgewater Twp"): None,  # Bridgewater is in Somerset
    ("Passaic", "Bloomsbury Boro"): None,    # Bloomsbury is in Hunterdon
}


def load_cc2mc2mn() -> dict:
    """Build (county_name, muni_name) → (cc, mc) lookup from cc2mc2mn.json."""
    with open(CC2MC2MN_PATH) as f:
        cc2mc2mn = json.load(f)
    out = {}
    for cc_str, info in cc2mc2mn.items():
        cn = info["cn"]
        for mc_str, mn in info["mc2mn"].items():
            out[(cn, mn)] = (int(cc_str), int(mc_str))
    return out


def lookup_cc_mc(lookup: dict, county, muni):
    """Try to resolve (cc, mc) for an AASHTO (County, Municipality) pair.
    Returns (cc, mc) or (None, None). Accepts None / pd.NA / NaN."""
    if county is None or muni is None or not isinstance(county, str) or not isinstance(muni, str):
        return (None, None)
    if (county, muni) in AASHTO_NAME_ALIASES:
        v = AASHTO_NAME_ALIASES[(county, muni)]
        if v is None:
            return (None, None)
        county, muni = v
    if (county, muni) in lookup:
        return lookup[(county, muni)]
    for suf in SUFFIXES:
        if muni.endswith(" " + suf):
            stem = muni[:-(len(suf) + 1)]
            if (county, stem) in lookup:
                return lookup[(county, stem)]
    return (None, None)


def infer_severity(tk: int, ti: int) -> str:
    if tk > 0:
        return "f"
    if ti > 0:
        return "i"
    return "p"


def to_int(v, default=0) -> int:
    if v is None or pd.isna(v):
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_njdot_schema(df: pd.DataFrame, year: int, lookup: dict) -> pd.DataFrame:
    """Map an AASHTO crashes DataFrame to NJDOT schema.

    Returns a DataFrame with columns aligned to `njdot/data/crashes.parquet`.
    Some columns will be entirely null (no AASHTO equivalent); FE
    consumers handle null gracefully."""
    out = pd.DataFrame(index=df.index)

    # PK columns
    out["year"] = pd.Series(year, index=df.index, dtype="int32")
    cc_mc = df.apply(lambda r: lookup_cc_mc(lookup, r["County"], r["Municipality"]), axis=1)
    out["cc"] = cc_mc.apply(lambda x: x[0]).astype("Int8")
    out["mc"] = cc_mc.apply(lambda x: x[1]).astype("Int16")
    out["case"] = df["Case Number"].astype("string")

    # Datetime — AASHTO has both `Date & Time of Crash` and `Date of Crash`
    # `Date & Time of Crash` is ISO 8601 e.g. "2024-02-04T12:20:00.000"
    out["dt"] = pd.to_datetime(df["Date & Time of Crash"], errors="coerce")

    # Severity — derive from Total Killed / Total Injured
    tk = df["Total Killed"].apply(to_int)
    ti = df["Total Injured"].apply(to_int)
    pk = df["Total Pedestrians Killed"].apply(to_int)
    pi = df["Total Injured Pedestrians"].apply(to_int)
    tv = df["Total Vehicles"].apply(to_int)
    out["severity"] = pd.Series([infer_severity(t, i) for t, i in zip(tk, ti)], index=df.index, dtype="string")
    out["tk"] = tk.astype("int8")
    out["ti"] = ti.astype("int8")
    out["pk"] = pk.astype("int8")
    out["pi"] = pi.astype("int8")
    out["tv"] = tv.astype("int8")

    # Lat/lon — AASHTO has separate Latitude/Longitude columns + Geopoint string
    out["olat"] = pd.to_numeric(df["Latitude"], errors="coerce").astype("float32")
    out["olon"] = pd.to_numeric(df["Longitude"], errors="coerce").astype("float32")
    # AASHTO doesn't do its own geocoding interpolation — leave ilat/ilon null.
    out["ilat"] = pd.Series([pd.NA] * len(df), index=df.index, dtype="Float32")
    out["ilon"] = pd.Series([pd.NA] * len(df), index=df.index, dtype="Float32")

    # cc0/mc0 — AASHTO doesn't expose pre-geocoding values, copy cc/mc.
    out["cc0"] = out["cc"]
    out["mc0"] = out["mc"]

    # Road / segment columns where the mapping is clear
    out["road"] = df["Street Name"].astype("string")
    out["cross_street"] = df["Intersect Street Name"].astype("string")
    out["route"] = df["Route Number"].astype("string")
    out["Route Suffix"] = df["Route Suffix"].astype("string")
    out["sri"] = df["SRI"].astype("string")
    out["mp"] = pd.to_numeric(df["Milepost"], errors="coerce").astype("float32")
    out["road_system"] = df["Road System"].astype("string")
    out["road_character"] = df["Road Character - Grade"].astype("string")
    out["road_surface"] = df["Road Surface Type"].astype("string")
    out["surface_condition"] = df["Surface Condition"].astype("string")
    out["light_condition"] = df["Light Condition"].astype("string")
    out["env_condition"] = df["Weather Condition"].astype("string")
    out["horizontal_alignment"] = df["Road Horizontal Alignment"].astype("string")
    out["road_grade"] = df["Road Character - Grade"].astype("string")
    out["first_harmful_event"] = df["First Harmful Event"].astype("string")

    # Booleans (AASHTO uses "Yes"/"No" strings)
    out["alcohol"] = (df["Alcohol Involved"] == "Yes").astype("bool")
    out["hazmat"] = (df["Hazmat Involved"] == "Yes").astype("bool")
    out["Intersection"] = df["At Intersection"].astype("string")
    out["Is Ramp"] = df["Ramp"].astype("string")
    out["ramp_route"] = df["Ramp Route Number"].astype("string")

    # Crash type — AASHTO uses descriptive strings like "Same Direction (Rear End)";
    # the existing schema uses int codes. Leave as string for now (FE can decide).
    out["crash_type"] = df["Crash Type"].astype("string")

    # Provenance / station
    out["station"] = df["State Police Station"].astype("string")
    out["pdc"] = df["County"].astype("string")
    out["pdn"] = df["Municipality"].astype("string")

    # Cols that exist in NJDOT schema with no AASHTO equivalent — leave NA.
    for col in ("mc_dot", "speed_limit", "speed_limit_cross", "ttcz",
                "cross_street_distance", "Unit Of Measurement",
                "Direction From Cross Street", "Ramp To/From Route Direction",
                "cell_phone", "Other Property Damage", "Reporting Badge No.",
                "occ", "omc", "reason", "icc", "imc", "road_direction",
                "road_divided"):
        out[col] = pd.NA

    return out


@click.command()
@click.option("-y", "--years", default="2024,2025", help="Comma-separated years to process")
@click.option("-i", "--in-dir", type=click.Path(path_type=Path), default=Path("njdot/data"))
@click.option("-o", "--out", type=click.Path(path_type=Path), default=Path("njdot/data/aashto_combined_crashes.parquet"))
def main(years: str, in_dir: Path, out: Path):
    lookup = load_cc2mc2mn()
    err(f"Loaded cc2mc2mn lookup: {len(lookup):,} (cn, mn) pairs")

    year_list = [int(y) for y in years.split(",")]
    parts = []
    for y in year_list:
        path = in_dir / str(y) / "crashes.parquet"
        if not path.exists():
            err(f"  skip {y}: {path} not present")
            continue
        df = pd.read_parquet(path)
        err(f"  {y}: {len(df):,} crashes loaded")
        out_df = to_njdot_schema(df, y, lookup)
        n_unmatched = out_df["cc"].isna().sum()
        err(f"        unmatched (cc, mc) lookups: {n_unmatched:,} ({n_unmatched/len(df)*100:.2f}%)")
        n_no_dt = out_df["dt"].isna().sum()
        if n_no_dt:
            err(f"        bad/missing dt: {n_no_dt:,} ({n_no_dt/len(df)*100:.2f}%)")
        parts.append(out_df)

    if not parts:
        err("No years to process.")
        return

    combined = pd.concat(parts, ignore_index=True)
    err(f"\nCombined: {len(combined):,} crashes across {len(parts)} years")
    out.parent.mkdir(parents=True, exist_ok=True)
    combined.to_parquet(out, index=False)
    err(f"Wrote {out}")


if __name__ == "__main__":
    main()

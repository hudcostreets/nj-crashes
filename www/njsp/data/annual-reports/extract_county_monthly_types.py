#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["pdfplumber", "click"]
# ///
"""Extract per-crash victim types from NJSP annual report PDFs, aggregate by county+month.

Parses the "Fatal Crashes by County, Municipality, Date, Time and Location" section.
Each crash row has a "Persons Killed" field like "1 DRIVER", "1 PEDESTRIAN, 1 PASSENGER".
Aggregates to county+month+type (and optionally county+muni+month+type) for backfilling monthly.csv.
"""
import csv
import json
import re
import sys
from collections import defaultdict
from glob import glob
from pathlib import Path

import click
import pdfplumber

REPORT_DIR = Path(__file__).parent

# NJ counties (for detecting county headers)
COUNTIES = [
    'ATLANTIC', 'BERGEN', 'BURLINGTON', 'CAMDEN', 'CAPE MAY',
    'CUMBERLAND', 'ESSEX', 'GLOUCESTER', 'HUDSON', 'HUNTERDON',
    'MERCER', 'MIDDLESEX', 'MONMOUTH', 'MORRIS', 'OCEAN',
    'PASSAIC', 'SALEM', 'SOMERSET', 'SUSSEX', 'UNION', 'WARREN',
]

# Canonical county names (title case)
COUNTY_NAMES = {c: c.title() for c in COUNTIES}
COUNTY_NAMES['CAPE MAY'] = 'Cape May'

# Victim type patterns in "Persons Killed" column
# Cyclist is spelled three ways across years:
#   2001:     PEDALCYCLE (no space)
#   2002–05:  BICYCLIST
#   2006+:    PEDAL CYCLIST / PEDALCYCLIST
TYPE_PATTERNS = [
    (re.compile(r'(\d+)\s*DRIVER', re.IGNORECASE), 'driver'),
    (re.compile(r'(\d+)\s*PASSENGER', re.IGNORECASE), 'passenger'),
    (re.compile(r'(\d+)\s*(?:PEDAL\s*(?:CYCLIST|CYCLE)|BICYCLIST)', re.IGNORECASE), 'cyclist'),
    (re.compile(r'(\d+)\s*PEDESTRIAN', re.IGNORECASE), 'pedestrian'),
]

err = lambda *a, **kw: print(*a, **kw, file=sys.stderr)


def parse_persons_killed(text: str) -> dict[str, int]:
    """Parse "Persons Killed" text into type counts."""
    counts = {'driver': 0, 'passenger': 0, 'cyclist': 0, 'pedestrian': 0}
    for pattern, typ in TYPE_PATTERNS:
        for m in pattern.finditer(text):
            counts[typ] += int(m.group(1))
    return counts


def extract_crashes_from_pdf(pdf_path: str) -> list[dict]:
    """Extract per-crash records from the county listing section of a PDF."""
    fname = Path(pdf_path).name
    m = re.search(r'(\d{4})', fname)
    if not m:
        raise ValueError(f"Cannot extract year from filename: {fname}")
    year = int(m.group(1))

    crashes = []
    current_county = None
    in_county_section = False

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ''
            upper = text.upper()

            # Detect start of county crash listing section
            # Must also have a county header on same page (not just TOC reference)
            # 2001–2005 use "FATAL ACCIDENTS BY COUNTY"; 2006+ use "FATAL CRASHES BY COUNTY"
            if (
                ('FATAL CRASHES BY COUNTY' in upper or 'FATAL ACCIDENTS BY COUNTY' in upper)
                and any(f'{c} COUNTY' in upper for c in COUNTIES)
            ):
                in_county_section = True

            # Detect end (map page or end of report)
            if in_county_section and 'MAP' in upper and 'FATALITIES BY COUNTY' in upper:
                break

            if not in_county_section:
                continue

            lines = text.split('\n')
            for line in lines:
                stripped = line.strip()
                upper_line = stripped.upper()

                # Skip headers/legend/garbled lines
                if not stripped or upper_line.startswith('MUNICIPALITY') or upper_line.startswith('DATE'):
                    continue
                if 'LEGEND' in upper_line or upper_line.startswith('FATAL CRASHES'):
                    continue
                # Skip garbled legend lines (lots of dots/spaces from PDF font issues)
                if upper_line.count('.') > 10:
                    continue

                # Check for county header (e.g. "ATLANTIC COUNTY", "PASSAICCOUNTY")
                county_match = re.match(r'^([A-Z\s]+?)\s*COUNTY\s*$', upper_line)
                if county_match:
                    cname = county_match.group(1).strip()
                    if cname in COUNTIES:
                        current_county = cname
                        continue

                if not current_county:
                    continue

                # Try to parse a crash row
                # Format: Municipality  Date  Day  Time  Road  MP  Persons Killed
                # Date format: MM/DD/YYYY
                date_match = re.search(r'(\d{2}/\d{2}/\d{4})', stripped)
                if not date_match:
                    continue

                date_str = date_match.group(1)
                try:
                    month_num = int(date_str.split('/')[0])
                except (ValueError, IndexError):
                    continue

                # Everything after MP (number) is "Persons Killed"
                # PEDAL catches PEDALCYCLE (2001) & PEDALCYCLIST (2006+); BICYC catches BICYCLIST (2002–05).
                persons_killed = ''
                for typ_word in ['DRIVER', 'PASSENGER', 'PEDESTRIAN', 'PEDAL', 'BICYC', 'UNKNOWN']:
                    idx = upper_line.find(typ_word)
                    if idx >= 0:
                        search_start = max(0, idx - 5)
                        persons_killed = stripped[search_start:]
                        break

                if not persons_killed:
                    end_match = re.search(r'\d+\s*(?:DRIVER|PASSENGER|PEDESTRIAN|PEDAL(?:CYCLE|CYCLIST)|BICYCLIST|UNKNOWN)', upper_line)
                    if end_match:
                        persons_killed = stripped[end_match.start():]

                if not persons_killed:
                    continue

                counts = parse_persons_killed(persons_killed)
                total = sum(counts.values())
                if total == 0:
                    # "UNKNOWN" type — still a fatality but no type
                    unknown_match = re.search(r'(\d+)\s*UNKNOWN', persons_killed, re.IGNORECASE)
                    if unknown_match:
                        total = int(unknown_match.group(1))

                # Extract municipality (text before date)
                muni = stripped[:date_match.start()].strip()

                crashes.append({
                    'year': year,
                    'county': COUNTY_NAMES.get(current_county, current_county.title()),
                    'month': month_num,
                    'municipality': muni,
                    'date': date_str,
                    'persons_killed': persons_killed.strip(),
                    **counts,
                })

    return crashes


def aggregate_county_monthly(crashes: list[dict]) -> list[dict]:
    """Aggregate per-crash records to county+month type totals."""
    key_to_counts = defaultdict(lambda: {'driver': 0, 'passenger': 0, 'cyclist': 0, 'pedestrian': 0, 'fatalities': 0})
    for c in crashes:
        key = (c['year'], c['county'], c['month'])
        agg = key_to_counts[key]
        agg['driver'] += c['driver']
        agg['passenger'] += c['passenger']
        agg['cyclist'] += c['cyclist']
        agg['pedestrian'] += c['pedestrian']
        agg['fatalities'] += c['driver'] + c['passenger'] + c['cyclist'] + c['pedestrian']

    rows = []
    for (year, county, month), counts in sorted(key_to_counts.items()):
        rows.append({
            'year': year,
            'county': county,
            'month': month,
            **counts,
        })
    return rows


# --- Municipality name matching ---

# PDF suffix variations -> canonical suffix
_SUFFIX_NORM = {
    'TWSP': 'Twp', 'TWP': 'Twp', 'TOWNSHIP': 'Twp', 'TWS': 'Twp', 'TW': 'Twp',
    'BORO': 'Boro', 'BOROUGH': 'Boro', 'BOR': 'Boro', 'BO': 'Boro',
    'CITY': 'City', 'CIT': 'City',
    'TOWN': 'Town', 'TO': 'Town',
    'VILLAGE': 'Village', 'VILLAG': 'Village',
}

# Sorted longest-first so we match "TWSP" before "TWS" before "TW"
_SUFFIX_KEYS = sorted(_SUFFIX_NORM.keys(), key=len, reverse=True)


# Manual fixes for names that can't be resolved by normalization alone
_MUNI_FIXES = {
    # Spelling variations
    ('BURLINGTON', 'EASTHAMPTON TWSP'): 'Eastampton Twp',
    ('BURLINGTON', 'EASTHAMPTON TWSP(cid:3)'): 'Eastampton Twp',
    # Cross-county (crash investigated by different troop than location county)
    ('UNION', 'PILESGROVE TWSP'): None,  # Salem county, skip
    ('UNION', 'PENNSVILLE TWSP'): None,  # Salem county, skip
    ('UNION', 'CARNEYS POINT TWSP'): None,  # Salem county, skip
    ('MONMOUTH', 'CLIFTON CITY'): None,  # Passaic county, skip
    ('MONMOUTH', 'PATERSON CITY'): None,  # Passaic county, skip
    ('MONMOUTH', 'PASSAIC CITY'): None,  # Passaic county, skip
    ('MONMOUTH', 'WAYNE TWSP'): None,  # Passaic county, skip
    ('MONMOUTH', 'RINGWOOD BORO'): None,  # Passaic county, skip
    # Ho-Ho-Kus hyphenation
    ('BERGEN', 'HOHOKUS BORO'): 'Ho-Ho-Kus Boro',
    # Ambiguous "Washington" (multiple NJ munis named Washington)
    ('MERCER', 'WASHINGTON TWP'): 'Washington Twp',
    ('WARREN', 'WASHINGTONBORO'): 'Washington Boro',
    # Truncated
    ('OCEAN', 'POINT PLEASANT BEAC'): 'Point Pleasant Beach Boro',
    # Spelling error in PDF
    ('MORRIS', 'EAST HONOVER TWSP'): 'East Hanover Twp',
    # Cross-county
    ('MONMOUTH', 'WEST MILFORD TWSP'): None,  # Passaic county, skip
    # Concatenated multi-word names
    ('UNION', 'ROSELLEPARKBORO'): 'Roselle Park Boro',
}


def _normalize_pdf_muni(raw: str) -> tuple[str, str]:
    """Normalize a PDF municipality name. Returns (full_normalized, stem)."""
    # Strip (cid:*) artifacts
    n = re.sub(r'\(cid:\d+\)', '', raw).strip().title()
    # Fix concatenated names: try splitting before known suffixes
    # Handle multi-word stems like "West Milford" by trying all suffix positions
    for suf in ['City', 'Twsp', 'Twp', 'Boro', 'Bor', 'Town', 'Village']:
        if n.endswith(suf) and len(n) > len(suf) and n[-len(suf) - 1] != ' ':
            n = n[:-len(suf)] + ' ' + suf
            break
    # Also handle "Tomsriver" -> "Toms River" style (no suffix, just concatenated words)
    # This is handled by prefix matching below
    # Normalize suffix
    for pdf_suf in _SUFFIX_KEYS:
        ps = pdf_suf.title()
        if n.endswith(f' {ps}'):
            stem = n[:-(len(ps) + 1)]
            canon = _SUFFIX_NORM[pdf_suf]
            return f'{stem} {canon}', stem
    # Handle truncated names (ending mid-word) — just return as stem
    return n, n


def _prefix_match(name: str, name2mc: dict[str, int], min_chars: int = 5) -> int | None:
    """Match a (possibly truncated) name against known munis by longest prefix."""
    n = name.lower().rstrip()
    # Strip spaces for concatenated-name matching (e.g. "westmilford" matches "west milford")
    n_nospace = n.replace(' ', '').replace('-', '')
    candidates = []
    for known, mc in name2mc.items():
        k = known.lower()
        k_nospace = k.replace(' ', '').replace('-', '')
        # Exact prefix match
        if k.startswith(n) and len(n) >= min_chars:
            candidates.append((mc, known))
        elif n.startswith(k) and len(k) >= min_chars:
            candidates.append((mc, known))
        # Space-stripped prefix match (handles concatenated names)
        elif k_nospace.startswith(n_nospace) and len(n_nospace) >= min_chars:
            candidates.append((mc, known))
        elif n_nospace.startswith(k_nospace) and len(k_nospace) >= min_chars:
            candidates.append((mc, known))
    if len(candidates) == 1:
        return candidates[0][0]
    # If multiple candidates, try to disambiguate by length (prefer closest match)
    if len(candidates) > 1:
        # Sort by how close the lengths are
        candidates.sort(key=lambda x: abs(len(x[1]) - len(name)))
        # If the best is much closer than the second, use it
        if len(candidates[0][1]) - len(name) < len(candidates[1][1]) - len(name):
            return candidates[0][0]
    return None


def _load_muni_lookup() -> dict[str, dict[str, int]]:
    """Load cc2mc2mn.json and build per-county lookup: normalized_name -> mc."""
    cc2mc2mn_path = REPORT_DIR.parent.parent / 'njdot' / 'cc2mc2mn.json'
    if not cc2mc2mn_path.exists():
        cc2mc2mn_path = Path('www/public/njdot/cc2mc2mn.json')
    with open(cc2mc2mn_path) as f:
        cc2mc2mn = json.load(f)

    # county_name_upper -> { normalized_muni_name: mc, stem: mc }
    lookup: dict[str, dict[str, int]] = {}
    cn2cc: dict[str, int] = {}
    for cc_str, info in cc2mc2mn.items():
        cn = info.get('cn', '')
        if not cn:
            continue
        cn2cc[cn.upper()] = int(cc_str)
        mc2mn = info.get('mc2mn', {})
        name2mc: dict[str, int] = {}
        for mc_str, mn in mc2mn.items():
            mc = int(mc_str)
            name2mc[mn] = mc
            # Also index by stem (strip suffix)
            for suf in ['Twp', 'Boro', 'City', 'Town', 'Village']:
                if mn.endswith(f' {suf}'):
                    name2mc[mn[:-(len(suf) + 1)]] = mc
                    break
            else:
                name2mc[mn] = mc
        lookup[cn.upper()] = name2mc
    return lookup


def resolve_muni_codes(crashes: list[dict]) -> list[dict]:
    """Add cc/mc fields to crash records by matching municipality names."""
    lookup = _load_muni_lookup()

    # Load CN2CC
    cc2mc2mn_path = REPORT_DIR.parent.parent / 'njdot' / 'cc2mc2mn.json'
    if not cc2mc2mn_path.exists():
        cc2mc2mn_path = Path('www/public/njdot/cc2mc2mn.json')
    with open(cc2mc2mn_path) as f:
        cc2mc2mn = json.load(f)
    cn2cc = {info['cn'].upper(): int(cc_str) for cc_str, info in cc2mc2mn.items() if info.get('cn')}

    matched = unmatched = 0
    for c in crashes:
        county_upper = c['county'].upper()
        cc = cn2cc.get(county_upper)
        if not cc:
            c['cc'] = None
            c['mc'] = None
            unmatched += 1
            continue

        name2mc = lookup.get(county_upper, {})

        # Check manual fixes first
        raw_muni = re.sub(r'\(cid:\d+\)', '', c['municipality']).strip().upper()
        fix_key = (county_upper, raw_muni)
        if fix_key in _MUNI_FIXES:
            fix_val = _MUNI_FIXES[fix_key]
            if fix_val is None:
                # Cross-county crash — skip (can't assign to a muni in this county)
                c['cc'] = cc
                c['mc'] = None
                unmatched += 1
                continue
            mc = name2mc.get(fix_val) or name2mc.get(fix_val.split()[0])
        else:
            norm, stem = _normalize_pdf_muni(c['municipality'])
            mc = name2mc.get(norm) or name2mc.get(stem) or _prefix_match(stem, name2mc)

        c['cc'] = cc
        c['mc'] = mc
        if mc:
            matched += 1
        else:
            unmatched += 1

    err(f"  Muni matching: {matched} matched, {unmatched} unmatched ({unmatched*100/(matched+unmatched):.1f}%)")
    return crashes


def aggregate_muni_monthly(crashes: list[dict]) -> list[dict]:
    """Aggregate per-crash records to county+muni+month type totals (only matched munis)."""
    key_to_counts = defaultdict(lambda: {'driver': 0, 'passenger': 0, 'cyclist': 0, 'pedestrian': 0, 'fatalities': 0})
    for c in crashes:
        if not c.get('mc'):
            continue
        key = (c['year'], c['county'], c['cc'], c['mc'], c['month'])
        agg = key_to_counts[key]
        for t in ['driver', 'passenger', 'cyclist', 'pedestrian']:
            agg[t] += c[t]
        agg['fatalities'] += c['driver'] + c['passenger'] + c['cyclist'] + c['pedestrian']

    rows = []
    for (year, county, cc, mc, month), counts in sorted(key_to_counts.items()):
        rows.append({
            'year': year, 'county': county, 'cc': cc, 'mc': mc, 'month': month,
            **counts,
        })
    return rows


@click.command()
@click.option('-o', '--output', default=None, help='Output CSV path (default: stdout)')
@click.option('-r', '--raw', is_flag=True, help='Output raw per-crash records instead of aggregated')
@click.option('-m', '--muni', is_flag=True, help='Aggregate at municipality level (includes cc/mc)')
@click.option('-v', '--verbose', is_flag=True, help='Print progress to stderr')
@click.option('-y', '--year', 'years', multiple=True, type=int, help='Only process specific year(s)')
def main(output, raw, muni, verbose, years):
    """Extract county-level monthly victim type data from NJSP annual report PDFs."""
    pdfs = sorted(
        glob(str(REPORT_DIR / '*_fatal_crash*.pdf'))
        + glob(str(REPORT_DIR / 'fatalacc_*.pdf'))
        + glob(str(REPORT_DIR / 'fatalcrash_*.pdf'))
    )
    if not pdfs:
        err("No PDF files found matching *_fatal_crash*.pdf")
        sys.exit(1)

    all_crashes = []
    for pdf_path in pdfs:
        fname = Path(pdf_path).name
        m = re.search(r'(\d{4})', fname)
        if not m:
            continue
        yr = int(m.group(1))
        if years and yr not in years:
            continue
        # Note: 2020+ also available from NJSP feed, but we extract for validation


        if verbose:
            err(f"Processing {fname}...")
        crashes = extract_crashes_from_pdf(pdf_path)
        all_crashes.extend(crashes)
        if verbose:
            total = sum(c['driver'] + c['passenger'] + c['cyclist'] + c['pedestrian'] for c in crashes)
            err(f"  {yr}: {len(crashes)} crashes, {total} typed fatalities")

    if muni or raw:
        resolve_muni_codes(all_crashes)

    if raw:
        fieldnames = ['year', 'county', 'cc', 'mc', 'month', 'municipality', 'date', 'persons_killed', 'driver', 'passenger', 'cyclist', 'pedestrian']
        rows = all_crashes
    elif muni:
        fieldnames = ['year', 'county', 'cc', 'mc', 'month', 'driver', 'passenger', 'cyclist', 'pedestrian', 'fatalities']
        rows = aggregate_muni_monthly(all_crashes)
    else:
        fieldnames = ['year', 'county', 'month', 'driver', 'passenger', 'cyclist', 'pedestrian', 'fatalities']
        rows = aggregate_county_monthly(all_crashes)

    f = open(output, 'w', newline='') if output else sys.stdout
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    if output:
        f.close()
        err(f"Wrote {len(rows)} rows to {output}")
    else:
        err(f"{len(rows)} rows")


if __name__ == '__main__':
    main()

#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["pdfplumber", "click"]
# ///
"""Extract per-crash victim types from NJSP annual report PDFs, aggregate by county+month.

Parses the "Fatal Crashes by County, Municipality, Date, Time and Location" section.
Each crash row has a "Persons Killed" field like "1 DRIVER", "1 PEDESTRIAN, 1 PASSENGER".
Aggregates to county+month+type for backfilling monthly.csv.
"""
import csv
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
TYPE_PATTERNS = [
    (re.compile(r'(\d+)\s*DRIVER', re.IGNORECASE), 'driver'),
    (re.compile(r'(\d+)\s*PASSENGER', re.IGNORECASE), 'passenger'),
    (re.compile(r'(\d+)\s*PEDAL\s*CYCLIST', re.IGNORECASE), 'cyclist'),
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
            if 'FATAL CRASHES BY COUNTY' in upper and any(f'{c} COUNTY' in upper for c in COUNTIES):
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
                # Look for the victim type keywords
                persons_killed = ''
                for typ_word in ['DRIVER', 'PASSENGER', 'PEDESTRIAN', 'PEDALCYCLIST', 'UNKNOWN']:
                    idx = upper_line.find(typ_word)
                    if idx >= 0:
                        # Find the start of the "Persons Killed" part (look back for the count)
                        # Search backwards from the first type word for a digit
                        search_start = max(0, idx - 5)
                        persons_killed = stripped[search_start:]
                        break

                if not persons_killed:
                    # Some rows might have just a number + type at the end
                    # Try matching the end of line
                    end_match = re.search(r'\d+\s+(?:DRIVER|PASSENGER|PEDESTRIAN|PEDALCYCLIST|UNKNOWN)', upper_line)
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


@click.command()
@click.option('-o', '--output', default=None, help='Output CSV path (default: stdout)')
@click.option('-r', '--raw', is_flag=True, help='Output raw per-crash records instead of aggregated')
@click.option('-v', '--verbose', is_flag=True, help='Print progress to stderr')
@click.option('-y', '--year', 'years', multiple=True, type=int, help='Only process specific year(s)')
def main(output, raw, verbose, years):
    """Extract county-level monthly victim type data from NJSP annual report PDFs."""
    pdfs = sorted(glob(str(REPORT_DIR / '*_fatal_crash*.pdf')))
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

    if raw:
        fieldnames = ['year', 'county', 'month', 'municipality', 'date', 'persons_killed', 'driver', 'passenger', 'cyclist', 'pedestrian']
        rows = all_crashes
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

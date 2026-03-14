#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["pdf2image", "pytesseract", "click"]
# ///
"""OCR-based extraction for PDFs with broken font encoding (e.g. 2014).

Uses pdf2image + tesseract to OCR pages, then applies the same parsing
logic as extract_county_monthly_types.py. Slower but handles broken fonts.

Usage:
    ./extract_county_monthly_types_ocr.py -y 2014 -v
"""
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

import click
from pdf2image import convert_from_path
import pytesseract

REPORT_DIR = Path(__file__).parent

COUNTIES = [
    'ATLANTIC', 'BERGEN', 'BURLINGTON', 'CAMDEN', 'CAPE MAY',
    'CUMBERLAND', 'ESSEX', 'GLOUCESTER', 'HUDSON', 'HUNTERDON',
    'MERCER', 'MIDDLESEX', 'MONMOUTH', 'MORRIS', 'OCEAN',
    'PASSAIC', 'SALEM', 'SOMERSET', 'SUSSEX', 'UNION', 'WARREN',
]
COUNTY_NAMES = {c: c.title() for c in COUNTIES}
COUNTY_NAMES['CAPE MAY'] = 'Cape May'

TYPE_PATTERNS = [
    (re.compile(r'(\d+)\s*DRIVER', re.IGNORECASE), 'driver'),
    (re.compile(r'(\d+)\s*PASSENGER', re.IGNORECASE), 'passenger'),
    (re.compile(r'(\d+)\s*PEDAL\s*CYCLIST', re.IGNORECASE), 'cyclist'),
    (re.compile(r'(\d+)\s*PEDESTRIAN', re.IGNORECASE), 'pedestrian'),
]

err = lambda *a, **kw: print(*a, **kw, file=sys.stderr)


def parse_persons_killed(text: str) -> dict[str, int]:
    counts = {'driver': 0, 'passenger': 0, 'cyclist': 0, 'pedestrian': 0}
    for pattern, typ in TYPE_PATTERNS:
        for m in pattern.finditer(text):
            counts[typ] += int(m.group(1))
    return counts


def extract_crashes_ocr(pdf_path: str) -> list[dict]:
    fname = Path(pdf_path).name
    m = re.search(r'(\d{4})', fname)
    if not m:
        raise ValueError(f"Cannot extract year from filename: {fname}")
    year = int(m.group(1))

    err(f"  Converting PDF to images (300 DPI)...")
    images = convert_from_path(pdf_path, dpi=300)

    crashes = []
    current_county = None
    in_county_section = False

    for page_num, img in enumerate(images, 1):
        text = pytesseract.image_to_string(img)
        upper = text.upper()

        if 'FATAL CRASHES BY COUNTY' in upper and any(f'{c} COUNTY' in upper for c in COUNTIES):
            in_county_section = True

        if in_county_section and 'MAP' in upper and 'FATALITIES BY COUNTY' in upper:
            break

        if not in_county_section:
            continue

        for line in text.split('\n'):
            stripped = line.strip()
            upper_line = stripped.upper()

            if not stripped or upper_line.startswith('MUNICIPALITY') or upper_line.startswith('DATE'):
                continue
            if 'LEGEND' in upper_line or upper_line.startswith('FATAL CRASHES'):
                continue
            if upper_line.count('.') > 10:
                continue

            county_match = re.match(r'^([A-Z\s]+?)\s+COUNTY\s*$', upper_line)
            if county_match:
                cname = county_match.group(1).strip()
                if cname in COUNTIES:
                    current_county = cname
                    continue

            if not current_county:
                continue

            date_match = re.search(r'(\d{2}/\d{2}/\d{4})', stripped)
            if not date_match:
                continue

            date_str = date_match.group(1)
            try:
                month_num = int(date_str.split('/')[0])
            except (ValueError, IndexError):
                continue

            persons_killed = ''
            for typ_word in ['DRIVER', 'PASSENGER', 'PEDESTRIAN', 'PEDALCYCLIST', 'UNKNOWN']:
                idx = upper_line.find(typ_word)
                if idx >= 0:
                    search_start = max(0, idx - 5)
                    persons_killed = stripped[search_start:]
                    break

            if not persons_killed:
                end_match = re.search(r'\d+\s*(?:DRIVER|PASSENGER|PEDESTRIAN|PEDALCYCLIST|UNKNOWN)', upper_line)
                if end_match:
                    persons_killed = stripped[end_match.start():]

            if not persons_killed:
                continue

            counts = parse_persons_killed(persons_killed)
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
    key_to_counts = defaultdict(lambda: {'driver': 0, 'passenger': 0, 'cyclist': 0, 'pedestrian': 0, 'fatalities': 0})
    for c in crashes:
        key = (c['year'], c['county'], c['month'])
        agg = key_to_counts[key]
        for t in ['driver', 'passenger', 'cyclist', 'pedestrian']:
            agg[t] += c[t]
        agg['fatalities'] += sum(c[t] for t in ['driver', 'passenger', 'cyclist', 'pedestrian'])

    rows = []
    for (year, county, month), counts in sorted(key_to_counts.items()):
        rows.append({'year': year, 'county': county, 'month': month, **counts})
    return rows


@click.command()
@click.option('-o', '--output', default=None, help='Output CSV path')
@click.option('-r', '--raw', is_flag=True, help='Output raw per-crash records')
@click.option('-v', '--verbose', is_flag=True, help='Print progress to stderr')
@click.option('-y', '--year', 'years', multiple=True, type=int, help='Only process specific year(s)')
def main(output, raw, verbose, years):
    """OCR-extract county-level monthly victim type data from NJSP annual report PDFs."""
    from glob import glob
    pdfs = sorted(glob(str(REPORT_DIR / '*_fatal_crash*.pdf')))

    all_crashes = []
    for pdf_path in pdfs:
        fname = Path(pdf_path).name
        m = re.search(r'(\d{4})', fname)
        if not m:
            continue
        yr = int(m.group(1))
        if years and yr not in years:
            continue
        if yr >= 2020:
            continue

        err(f"Processing {fname} (OCR)...")
        crashes = extract_crashes_ocr(pdf_path)
        all_crashes.extend(crashes)
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


if __name__ == '__main__':
    main()

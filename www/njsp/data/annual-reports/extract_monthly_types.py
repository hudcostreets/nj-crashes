#!/usr/bin/env python
"""Extract 'Victim Classification by Month' tables from NJSP annual crash report PDFs.

The PDFs have a font/encoding issue where two-digit numbers XY get a '0' inserted
between digits (→ X0Y), and single-digit numbers get a leading '0'. The Totals column
is always correct, so we use it for validation after applying the correction.
"""
import csv
import re
import sys
from glob import glob
from pathlib import Path

import pdfplumber

MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]

REPORT_DIR = Path(__file__).parent


def fix_corrupted_number(raw: str) -> int:
    """Fix PDF digit corruption: X0Y → XY, 0X → X."""
    n = int(raw)
    s = str(n)
    if len(s) == 3 and s[1] == '0':
        # X0Y → XY (e.g., 304 → 34, 104 → 14, 200 → 20)
        return int(s[0] + s[2])
    if len(s) == 2 and s[0] == '0':
        # 0X → X
        return int(s[1])
    return n


def extract_victim_table(pdf_path: str) -> list[dict]:
    """Extract the monthly victim classification table from a single PDF."""
    fname = Path(pdf_path).name
    m = re.search(r'(\d{4})', fname)
    if not m:
        raise ValueError(f"Cannot extract year from filename: {fname}")
    year = int(m.group(1))

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ''
            upper = text.upper()
            # 2008-2022: "VICTIM CLASSIFICATION BY MONTH", 2023+: "FATALITY CLASSIFICATION BY MONTH"
            if 'CLASSIFICATION BY MONTH' not in upper:
                continue

            # Extract only section A (before section B starts)
            lines = text.split('\n')
            rows = []
            in_section_a = False
            for line in lines:
                upper_line = line.upper()
                if 'CLASSIFICATION BY MONTH' in upper_line:
                    in_section_a = True
                    continue
                if in_section_a and ('CRASHES AND FATALITIES' in upper_line or 'CLASSIFICATION BY COUNTY' in upper_line):
                    break  # Section B or C — stop

                if not in_section_a:
                    continue

                parts = line.split()
                if not parts or parts[0] not in MONTHS:
                    continue

                month_name = parts[0]
                nums = parts[1:]

                # Section A has exactly 5 numbers: Driver, Passenger, Pedalcyclist, Pedestrian, Totals
                if len(nums) != 5:
                    continue

                driver = fix_corrupted_number(nums[0])
                passenger = fix_corrupted_number(nums[1])
                cyclist = fix_corrupted_number(nums[2])
                pedestrian = fix_corrupted_number(nums[3])
                total = int(nums[4])

                computed = driver + passenger + cyclist + pedestrian
                if computed != total:
                    print(
                        f"  MISMATCH {year} {month_name}: "
                        f"d={driver} p={passenger} c={cyclist} ped={pedestrian} "
                        f"sum={computed} != total={total} (raw: {nums})",
                        file=sys.stderr,
                    )

                rows.append({
                    'year': year,
                    'month': MONTHS.index(month_name) + 1,
                    'driver': driver,
                    'passenger': passenger,
                    'cyclist': cyclist,
                    'pedestrian': pedestrian,
                })

            if len(rows) == 12:
                return rows

            if rows:
                print(f"WARNING: {fname}: found {len(rows)} months (expected 12)", file=sys.stderr)
                return rows

    # Fallback: try looking across all pages for the table
    print(f"WARNING: {fname}: no victim table found on expected page, trying all pages...", file=sys.stderr)
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ''
            if any(m in text for m in MONTHS[:3]):  # January, February, March
                # Check if it has the right structure
                lines = text.split('\n')
                for line in lines:
                    parts = line.split()
                    if parts and parts[0] == 'January' and len(parts) == 6:
                        print(f"  Found candidate on page {i+1}: {line}", file=sys.stderr)
    return []


def main():
    pdfs = sorted(glob(str(REPORT_DIR / '*.pdf')))
    all_rows = []
    for pdf_path in pdfs:
        print(f"Processing {Path(pdf_path).name}...", file=sys.stderr)
        rows = extract_victim_table(pdf_path)
        all_rows.extend(rows)
        if rows:
            total = sum(r['driver'] + r['passenger'] + r['cyclist'] + r['pedestrian'] for r in rows)
            print(f"  {rows[0]['year']}: {total} total fatalities", file=sys.stderr)

    out_path = REPORT_DIR / 'monthly_types_from_pdfs.csv'
    with open(out_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['year', 'month', 'driver', 'passenger', 'cyclist', 'pedestrian'])
        writer.writeheader()
        writer.writerows(all_rows)
    print(f"\nWrote {len(all_rows)} rows to {out_path}", file=sys.stderr)


if __name__ == '__main__':
    main()

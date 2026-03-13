#!/usr/bin/env python
"""Cross-validate PDF-extracted monthly type data against crashes.parquet (FAUQStats XMLs).

Checks:
1. Per-year total fatalities: PDF vs parquet
2. Per-month type breakdown: PDF vs parquet (2020+ where parquet has type data)
3. Per-year type totals: PDF vs parquet (2020+)
"""
import sys
from pathlib import Path

import pandas as pd
from utz import err

REPORT_DIR = Path(__file__).parent
PROJECT_ROOT = REPORT_DIR.parents[3]  # www/njsp/data/annual-reports → project root
CRASHES_PQT = PROJECT_ROOT / 'njsp' / 'data' / 'crashes.parquet'
PDF_CSV = REPORT_DIR / 'monthly_types_from_pdfs.csv'


def main():
    err(f"Loading {CRASHES_PQT}...")
    crashes = pd.read_parquet(CRASHES_PQT)
    crashes['year'] = crashes['dt'].dt.year
    crashes['month'] = crashes['dt'].dt.month
    crashes['fatalities'] = crashes['tk'].fillna(0).astype(int)
    crashes['driver'] = crashes['dk'].fillna(0).astype(int)
    crashes['passenger'] = crashes['ok'].fillna(0).astype(int)
    crashes['pedestrian'] = crashes['pk'].fillna(0).astype(int)
    crashes['cyclist'] = crashes['bk'].fillna(0).astype(int)

    err(f"Loading {PDF_CSV}...")
    pdf = pd.read_csv(PDF_CSV)

    pdf_years = sorted(pdf['year'].unique())
    pqt_years = sorted(crashes['year'].unique())

    errors = 0
    warnings = 0

    # --- Check 1: Annual fatality totals (PDF vs parquet) ---
    err("\n=== Annual Fatality Totals: PDF vs Parquet ===")
    pqt_yearly = crashes.groupby('year')['fatalities'].sum()
    pdf_yearly = pdf.groupby('year')[['driver', 'passenger', 'cyclist', 'pedestrian']].sum().sum(axis=1)

    for year in pdf_years:
        pdf_total = int(pdf_yearly.get(year, 0))
        pqt_total = int(pqt_yearly.get(year, 0))
        match = "✓" if pdf_total == pqt_total else "✗"
        if pdf_total != pqt_total:
            diff = pdf_total - pqt_total
            err(f"  {year}: PDF={pdf_total:>4}  PQT={pqt_total:>4}  diff={diff:+d}  {match}")
            warnings += 1
        else:
            err(f"  {year}: PDF={pdf_total:>4}  PQT={pqt_total:>4}  {match}")

    # --- Check 2: Monthly type breakdown (2020+ where parquet has dk/ok/pk/bk) ---
    err("\n=== Monthly Type Breakdown: PDF vs Parquet (2020+) ===")
    pqt_monthly = (
        crashes[crashes['year'] >= 2020]
        .groupby(['year', 'month'])[['driver', 'passenger', 'pedestrian', 'cyclist']]
        .sum()
        .reset_index()
    )

    pdf_recent = pdf[pdf['year'] >= 2020].copy()
    merged = pdf_recent.merge(
        pqt_monthly,
        on=['year', 'month'],
        suffixes=('_pdf', '_pqt'),
    )

    type_cols = ['driver', 'passenger', 'pedestrian', 'cyclist']
    mismatches = []
    for _, row in merged.iterrows():
        for col in type_cols:
            pdf_val = int(row[f'{col}_pdf'])
            pqt_val = int(row[f'{col}_pqt'])
            if pdf_val != pqt_val:
                mismatches.append({
                    'year': int(row['year']),
                    'month': int(row['month']),
                    'type': col,
                    'pdf': pdf_val,
                    'pqt': pqt_val,
                    'diff': pdf_val - pqt_val,
                })

    if mismatches:
        err(f"  Found {len(mismatches)} cell mismatches:")
        for m in mismatches[:20]:
            err(f"    {m['year']}-{m['month']:02d} {m['type']:>10}: PDF={m['pdf']:>3} PQT={m['pqt']:>3} diff={m['diff']:+d}")
        if len(mismatches) > 20:
            err(f"    ... and {len(mismatches) - 20} more")
        errors += len(mismatches)
    else:
        err("  All monthly type values match ✓")

    # --- Check 3: Annual type totals (2020+) ---
    err("\n=== Annual Type Totals: PDF vs Parquet (2020+) ===")
    pqt_yearly_types = (
        crashes[crashes['year'] >= 2020]
        .groupby('year')[['driver', 'passenger', 'pedestrian', 'cyclist']]
        .sum()
    )
    pdf_yearly_types = pdf[pdf['year'] >= 2020].groupby('year')[type_cols].sum()

    for year in sorted(pdf_yearly_types.index):
        if year not in pqt_yearly_types.index:
            err(f"  {year}: not in parquet (skip)")
            continue
        row_pdf = pdf_yearly_types.loc[year]
        row_pqt = pqt_yearly_types.loc[year]
        diffs = {c: int(row_pdf[c] - row_pqt[c]) for c in type_cols if row_pdf[c] != row_pqt[c]}
        if diffs:
            err(f"  {year}: DIFFS {diffs}")
            err(f"    PDF: d={int(row_pdf['driver'])} p={int(row_pdf['passenger'])} ped={int(row_pdf['pedestrian'])} c={int(row_pdf['cyclist'])}")
            err(f"    PQT: d={int(row_pqt['driver'])} p={int(row_pqt['passenger'])} ped={int(row_pqt['pedestrian'])} c={int(row_pqt['cyclist'])}")
        else:
            pdf_sum = int(row_pdf.sum())
            err(f"  {year}: all types match ✓ (total={pdf_sum})")

    # --- Check 4: Pre-2020 parquet should have zero types ---
    err("\n=== Pre-2020 Parquet Type Data Check ===")
    pre2020_types = crashes[crashes['year'] < 2020][type_cols].sum()
    total_pre2020_types = int(pre2020_types.sum())
    if total_pre2020_types == 0:
        err(f"  Parquet has no type data pre-2020 (as expected) ✓")
    else:
        err(f"  WARNING: Parquet has {total_pre2020_types} type entries pre-2020!")
        err(f"    {pre2020_types.to_dict()}")

    # --- Summary ---
    err(f"\n{'='*50}")
    if errors == 0 and warnings == 0:
        err("All checks passed ✓")
    else:
        if warnings:
            err(f"{warnings} annual total mismatches (may be due to revisions)")
        if errors:
            err(f"{errors} monthly type cell mismatches")

    return errors


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "click",
#     "pandas",
#     "pyarrow",
# ]
# ///
"""
QC script for victim type × condition matrix.

Compares DOT-provided totals (tk0, ti0, pk0, pi0) with computed values (tk, ti, pk, pi).
Outputs summary statistics and detailed mismatch reports.
"""

import json
from pathlib import Path

import click
import pandas as pd


# Victim type × condition matrix columns
VICTIM_TYPES = ['d', 'o', 'p', 'b', 'u']  # driver, passenger, pedestrian, bicyclist, unknown
CONDITIONS = ['f', 's', 'm', 'p', 'n']     # fatal, serious, minor, possible, none
VTC_COLS = [f'{vt}{c}' for vt in VICTIM_TYPES for c in CONDITIONS]


@click.command()
@click.option('-i', '--input', 'input_path', default='njdot/data/crashes.parquet', help='Input crashes parquet')
@click.option('-o', '--output-dir', default='njdot/qc', help='Output directory for QC reports')
def main(input_path: str, output_dir: str):
    """QC validation of victim type × condition counts."""
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {input_path}...")
    # Load both DOT-provided (*0) and computed values
    columns = ['year', 'cc', 'mc', 'case', 'tk0', 'ti0', 'pk0', 'pi0', 'tk', 'ti', 'pk', 'pi'] + VTC_COLS
    df = pd.read_parquet(input_path, columns=columns)
    print(f"  {len(df):,} crashes loaded")

    # Summary statistics
    summary = {
        'total_crashes': len(df),
        'years': sorted(df['year'].unique().tolist()),
    }

    # Compare DOT vs computed for each metric
    metrics = [
        ('tk', 'tk0', 'Total Killed'),
        ('ti', 'ti0', 'Total Injured'),
        ('pk', 'pk0', 'Pedestrians Killed'),
        ('pi', 'pi0', 'Pedestrians Injured'),
    ]

    print("\n=== DOT vs Computed Comparison ===")
    mismatches_all = []
    for computed, dot, label in metrics:
        dot_sum = df[dot].sum()
        computed_sum = df[computed].sum()
        matches = (df[computed] == df[dot]).sum()
        mismatches = len(df) - matches

        print(f"\n{label} ({computed}):")
        print(f"  DOT total:      {dot_sum:,}")
        print(f"  Computed total: {computed_sum:,}")
        print(f"  Difference:     {computed_sum - dot_sum:+,}")
        print(f"  Matching rows:  {matches:,} ({100*matches/len(df):.2f}%)")
        print(f"  Mismatches:     {mismatches:,}")

        summary[f'{computed}_dot_sum'] = int(dot_sum)
        summary[f'{computed}_computed_sum'] = int(computed_sum)
        summary[f'{computed}_diff'] = int(computed_sum - dot_sum)
        summary[f'{computed}_matches'] = int(matches)
        summary[f'{computed}_mismatches'] = int(mismatches)

        # Track mismatch details
        if mismatches > 0:
            mismatch_df = df[df[computed] != df[dot]][['year', 'cc', 'mc', 'case', dot, computed]].copy()
            mismatch_df['metric'] = computed
            mismatch_df['diff'] = mismatch_df[computed] - mismatch_df[dot]
            mismatches_all.append(mismatch_df)

    # Validate matrix totals
    print("\n=== Matrix Validation ===")

    # tk should equal sum of fatal columns
    fatal_cols = [f'{vt}f' for vt in VICTIM_TYPES]
    df['tk_from_matrix'] = df[fatal_cols].sum(axis=1)
    tk_matrix_match = (df['tk'] == df['tk_from_matrix']).all()
    print(f"tk == df + of + pf + bf + uf: {tk_matrix_match}")
    summary['tk_equals_matrix'] = bool(tk_matrix_match)

    # ti should equal sum of serious + minor + possible columns
    inj_cols = [f'{vt}{c}' for vt in VICTIM_TYPES for c in ['s', 'm', 'p']]
    df['ti_from_matrix'] = df[inj_cols].sum(axis=1)
    ti_matrix_match = (df['ti'] == df['ti_from_matrix']).all()
    print(f"ti == sum of serious + minor + possible: {ti_matrix_match}")
    summary['ti_equals_matrix'] = bool(ti_matrix_match)

    # pk should equal pf
    pk_match = (df['pk'] == df['pf']).all()
    print(f"pk == pf: {pk_match}")
    summary['pk_equals_pf'] = bool(pk_match)

    # pi should equal ps + pm + pp
    df['pi_from_matrix'] = df['ps'] + df['pm'] + df['pp']
    pi_match = (df['pi'] == df['pi_from_matrix']).all()
    print(f"pi == ps + pm + pp: {pi_match}")
    summary['pi_equals_matrix'] = bool(pi_match)

    # Victim type breakdown
    print("\n=== Victim Type Totals ===")
    for vt, label in [('d', 'Drivers'), ('o', 'Passengers'), ('p', 'Pedestrians'), ('b', 'Cyclists'), ('u', 'Unknown')]:
        vt_cols = [f'{vt}{c}' for c in CONDITIONS]
        total = df[vt_cols].sum().sum()
        fatal = df[f'{vt}f'].sum()
        injured = df[[f'{vt}s', f'{vt}m', f'{vt}p']].sum().sum()
        uninjured = df[f'{vt}n'].sum()
        print(f"  {label}: {total:,} total ({fatal:,} fatal, {injured:,} injured, {uninjured:,} uninjured)")
        summary[f'{vt}_total'] = int(total)
        summary[f'{vt}_fatal'] = int(fatal)
        summary[f'{vt}_injured'] = int(injured)
        summary[f'{vt}_uninjured'] = int(uninjured)

    # Write summary JSON
    summary_path = output_dir / 'victim_counts_summary.json'
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"\nWrote {summary_path}")

    # Write detailed mismatches parquet
    if mismatches_all:
        mismatches_df = pd.concat(mismatches_all, ignore_index=True)
        mismatches_path = output_dir / 'victim_counts_mismatches.parquet'
        mismatches_df.to_parquet(mismatches_path, index=False)
        print(f"Wrote {mismatches_path} ({len(mismatches_df):,} rows)")

    print("\nDone!")


if __name__ == '__main__':
    main()

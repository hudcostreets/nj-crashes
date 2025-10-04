from collections import Counter
import json
from os.path import exists
from click import option
from utz import err
from zipfile import ZipFile
import sys

from njdot.paths import DOT_DATA
from njdot.data import FIELDS_DIR
from njdot.tbls import types_opt, TYPE_TO_FIELDS
from .base import rawdata
from .utils import regions_opt, years_opt
from .parse import parse_rows


@rawdata.group('fsck', short_help='Verify and analyze data file structure')
def fsck():
    """File system check commands for verifying data integrity."""
    pass


@fsck.command('newlines', short_help='Verify line endings and record structure')
@regions_opt
@types_opt
@years_opt
@option('-n', '--num-records', type=int, help='Number of records to check (default: all)')
@option('-p', '--pull', is_flag=True, help='Pull zip file with dvc if txt and zip do not exist')
@option('-j', '--json', 'json_output', is_flag=True, help='Output results as JSON')
def fsck_newlines(regions, types, years, num_records, pull, json_output):
    """Verify line endings, record lengths, and detect internal newlines.

    Uses the same blessed parser as `pqt` command to ensure consistent handling
    of UTF-8, line endings, and embedded newlines.

    If .txt file doesn't exist, will try to read from .zip file.
    """
    from os import getcwd
    from os.path import relpath

    results = [] if json_output else None

    for region in regions:
        for year in years:
            for typ in types:
                txt_path = f'{DOT_DATA}/{year}/{region}{year}{typ}.txt'
                zip_path = f'{DOT_DATA}/{year}/{region}{year}{typ}.zip'

                # Try to get data from .txt or .zip
                raw_bytes = None
                if exists(txt_path):
                    source = txt_path
                    if not json_output:
                        err(f'Checking {txt_path}...')
                elif exists(zip_path):
                    source = zip_path
                    if not json_output:
                        err(f'Checking {zip_path} (reading .txt from zip)...')
                    with ZipFile(zip_path, 'r') as zip_ref:
                        namelist = zip_ref.namelist()
                        txt_name = f'{region}{year}{typ}.txt'
                        if txt_name not in namelist:
                            # Handle Cape May special case
                            if region == 'CapeMay':
                                txt_name = f'Cape May{year}{typ}.txt'
                            if txt_name not in namelist:
                                err(f'  ERROR: {txt_name} not found in {zip_path}')
                                continue
                        raw_bytes = zip_ref.read(txt_name)
                else:
                    # Neither txt nor zip exists
                    if pull:
                        # Try to pull with dvc
                        dvc_path = f'{zip_path}.dvc'
                        if exists(dvc_path):
                            err(f'Pulling {zip_path} with dvc...')
                            from subprocess import run, CalledProcessError
                            try:
                                run(['dvc', 'pull', dvc_path], check=True, capture_output=True)
                                if exists(zip_path):
                                    source = zip_path
                                    err(f'Checking {zip_path} (reading .txt from zip)...')
                                    with ZipFile(zip_path, 'r') as zip_ref:
                                        namelist = zip_ref.namelist()
                                        txt_name = f'{region}{year}{typ}.txt'
                                        if txt_name not in namelist:
                                            # Handle Cape May special case
                                            if region == 'CapeMay':
                                                txt_name = f'Cape May{year}{typ}.txt'
                                            if txt_name not in namelist:
                                                err(f'  ERROR: {txt_name} not found in {zip_path}')
                                                continue
                                        raw_bytes = zip_ref.read(txt_name)
                                else:
                                    err(f'  ERROR: dvc pull succeeded but {zip_path} still not found')
                                    continue
                            except CalledProcessError as e:
                                err(f'  ERROR: dvc pull failed: {e}')
                                continue
                        else:
                            err(f'{txt_path}: not found (no .zip, no .dvc), skipping')
                            continue
                    else:
                        err(f'{txt_path}: not found (no .zip, use --pull to dvc pull), skipping')
                        continue

                # Load schema
                v2017 = year >= 2017
                table = TYPE_TO_FIELDS[typ]
                json_name = f'{2017 if v2017 else 2001}{table}Table.json'
                json_path = f'{FIELDS_DIR}/{json_name}'
                with open(json_path, 'r') as f:
                    fields = json.load(f)

                # Handle DOB field adjustments for 2021+
                if typ in ('Drivers', 'Pedestrians') and year >= 2021:
                    from .parse import get_2021_dob_fix_fields
                    dob_col = 'Driver DOB' if typ == 'Drivers' else 'Date of Birth'
                    fields = get_2021_dob_fix_fields(fields, dob_col, year)

                expected_data_size = sum(f['Length'] for f in fields)

                # Use blessed parser with diagnostics
                result = parse_rows(source, fields, return_diagnostics=True, max_records=num_records, raw_bytes=raw_bytes)

                # Prepare result data
                records_to_report = num_records if num_records else result.total_records

                if json_output:
                    # Collect JSON result
                    rel_source = relpath(source, getcwd())
                    result_obj = {
                        'source': rel_source,
                        'region': region,
                        'year': year,
                        'type': typ,
                        'line_ending': result.line_ending,
                        'expected_record_size': result.expected_record_size,
                        'actual_record_size': result.actual_record_size,
                        'records_checked': min(records_to_report, result.total_records),
                        'total_records': result.total_records,
                        'records_with_internal_newlines': result.records_with_internal_newlines,
                        'incomplete_final_record_bytes': result.incomplete_final_record_bytes,
                        'malformed_records': [
                            {
                                'record_num': record_num,
                                'line_num': line_num,
                                'pos': pos,
                                'issue': issue
                            }
                            for record_num, line_num, pos, issue in result.malformed_records
                        ]
                    }
                    results.append(result_obj)
                else:
                    # Display human-readable results
                    err(f'  Line ending: {result.line_ending}')
                    err(f'  Schema record size: {result.expected_record_size} chars ({expected_data_size} data + {1 if result.line_ending == "LF" else 2} line ending)')
                    if result.actual_record_size != result.expected_record_size:
                        err(f'  Actual record size: {result.actual_record_size} chars (differs from schema)')
                    else:
                        err(f'  Actual record size: {result.actual_record_size} chars')

                    err(f'  Records checked: {min(records_to_report, result.total_records)}')

                    if result.records_with_internal_newlines > 0:
                        err(f'  WARNING: {result.records_with_internal_newlines} records with internal newlines')
                    else:
                        err(f'  ✓ No internal newlines')

                    if result.incomplete_final_record_bytes > 0:
                        err(f'  WARNING: Incomplete final record ({result.incomplete_final_record_bytes} bytes)')

                    if result.malformed_records:
                        err(f'  Issues found:')
                        for record_num, line_num, pos, issue in result.malformed_records[:10]:
                            if num_records is None or record_num < num_records:
                                err(f'    Record {record_num} (line {line_num}, pos {pos}): {issue}')
                        if len(result.malformed_records) > 10:
                            err(f'    ... (showing first 10 of {len(result.malformed_records)} issues)')
                    else:
                        err(f'  ✓ All records properly formatted')

    # Output JSON if requested
    if json_output:
        print(json.dumps(results, indent=2))


@fsck.command('fields', short_help='Analyze field boundaries via comma positions')
@regions_opt
@types_opt
@years_opt
@option('-n', '--num-records', type=int, help='Number of records to analyze (default: all)')
@option('-p', '--pull', is_flag=True, help='Pull zip file with dvc if txt and zip do not exist')
@option('-j', '--json', 'json_output', is_flag=True, help='Output results as JSON')
def fsck_fields(regions, types, years, num_records, pull, json_output):
    """Analyze field widths (chars between commas) and show histogram.

    Uses the blessed parser to handle UTF-8 encoding and embedded newlines.
    If .txt file doesn't exist, will try to read from .zip file.
    """
    from os import getcwd
    from os.path import relpath

    results = [] if json_output else None

    for region in regions:
        for year in years:
            for typ in types:
                txt_path = f'{DOT_DATA}/{year}/{region}{year}{typ}.txt'
                zip_path = f'{DOT_DATA}/{year}/{region}{year}{typ}.zip'

                # Try to get data from .txt or .zip
                raw_bytes = None
                source = None
                rel_source = None
                if exists(txt_path):
                    source = txt_path
                    rel_source = relpath(txt_path, getcwd())
                    if not json_output:
                        err(f'Analyzing {rel_source}…')
                elif exists(zip_path):
                    source = zip_path
                    rel_source = relpath(zip_path, getcwd())
                    if not json_output:
                        err(f'Analyzing {rel_source} (reading .txt from zip)…')
                    with ZipFile(zip_path, 'r') as zip_ref:
                        namelist = zip_ref.namelist()
                        txt_name = f'{region}{year}{typ}.txt'
                        if txt_name not in namelist:
                            # Handle Cape May special case
                            if region == 'CapeMay':
                                txt_name = f'Cape May{year}{typ}.txt'
                            if txt_name not in namelist:
                                err(f'  ERROR: {txt_name} not found in {zip_path}')
                                continue
                        raw_bytes = zip_ref.read(txt_name)
                else:
                    # Neither txt nor zip exists
                    if pull:
                        # Try to pull with dvc
                        dvc_path = f'{zip_path}.dvc'
                        if exists(dvc_path):
                            rel_zip = relpath(zip_path, getcwd())
                            if not json_output:
                                err(f'Pulling {rel_zip} with dvc…')
                            from subprocess import run, CalledProcessError
                            try:
                                run(['dvc', 'pull', dvc_path], check=True, capture_output=True)
                                if exists(zip_path):
                                    source = zip_path
                                    rel_source = rel_zip
                                    if not json_output:
                                        err(f'Analyzing {rel_zip} (reading .txt from zip)…')
                                    with ZipFile(zip_path, 'r') as zip_ref:
                                        namelist = zip_ref.namelist()
                                        txt_name = f'{region}{year}{typ}.txt'
                                        if txt_name not in namelist:
                                            # Handle Cape May special case
                                            if region == 'CapeMay':
                                                txt_name = f'Cape May{year}{typ}.txt'
                                            if txt_name not in namelist:
                                                err(f'  ERROR: {txt_name} not found in {zip_path}')
                                                continue
                                        raw_bytes = zip_ref.read(txt_name)
                                else:
                                    err(f'  ERROR: dvc pull succeeded but {zip_path} still not found')
                                    continue
                            except CalledProcessError as e:
                                err(f'  ERROR: dvc pull failed: {e}')
                                continue
                        else:
                            err(f'{txt_path}: not found (no .zip, no .dvc), skipping')
                            continue
                    else:
                        err(f'{txt_path}: not found (no .zip, use --pull to dvc pull), skipping')
                        continue

                # Load schema
                v2017 = year >= 2017
                table = TYPE_TO_FIELDS[typ]
                json_name = f'{2017 if v2017 else 2001}{table}Table.json'
                json_path = f'{FIELDS_DIR}/{json_name}'
                with open(json_path, 'r') as f:
                    fields = json.load(f)

                # Handle schema adjustments
                if typ in ('Drivers', 'Pedestrians') and year >= 2021:
                    from .parse import get_2021_dob_fix_fields
                    dob_col = 'Driver DOB' if typ == 'Drivers' else 'Date of Birth'
                    fields = get_2021_dob_fix_fields(fields, dob_col, year)
                elif typ == 'Vehicles' and year >= 2023:
                    from .parse import get_2023_vehicles_fix_fields
                    fields = get_2023_vehicles_fix_fields(fields, year)

                # Decode and normalize text (same as blessed parser)
                if raw_bytes is None:
                    with open(source, 'rb') as f:
                        raw_bytes = f.read()

                # Try UTF-8 first, fall back to ISO-8859-1
                try:
                    text = raw_bytes.decode('utf-8', errors='replace')
                except:
                    text = raw_bytes.decode('ISO-8859-1')

                # Replace problematic Unicode characters
                replacements = {
                    '\u2013': '-',
                    '\u2014': '-',
                    '\u2019': "'",
                    '\xa0': ' ',
                    '\ufffd': ' ',
                    '\xad': '-',
                }
                for old, new in replacements.items():
                    text = text.replace(old, new)

                # Detect line ending
                first_lf = text.find('\n')
                if first_lf > 0 and text[first_lf-1:first_lf] == '\r':
                    line_ending = '\r\n'
                else:
                    line_ending = '\n'

                # Calculate expected record size
                data_size = sum(f['Length'] for f in fields)
                expected_record_size = data_size + len(line_ending)

                # Check actual record size
                actual_first_record_size = first_lf + 1
                if actual_first_record_size == expected_record_size + 1:
                    record_size = expected_record_size + 1
                    has_extra_char = True
                else:
                    record_size = expected_record_size
                    has_extra_char = False

                # Extract records using fixed-width character positions (handles embedded newlines)
                lines = []
                pos = 0
                idx = 0

                while pos < len(text) and (num_records is None or idx < num_records):
                    # Read one record (fixed char count)
                    record_text = text[pos:pos+record_size]
                    if len(record_text) < record_size:
                        break

                    # Strip extra character if present
                    if has_extra_char:
                        record_text = record_text[:-(len(line_ending)+1)] + line_ending

                    # Replace embedded newlines/carriage returns with spaces (keep trailing line ending)
                    record_content = record_text[:-len(line_ending)]
                    record_content = record_content.replace('\r', ' ').replace('\n', ' ')

                    lines.append(record_content)
                    idx += 1
                    pos += record_size

                # Analyze comma positions in each record
                records_analyzed = len(lines)
                comma_positions_by_record = []

                for line in lines:
                    comma_positions = []
                    for i, char in enumerate(line):
                        if char == ',':
                            comma_positions.append(i)
                    comma_positions_by_record.append(comma_positions)

                if not comma_positions_by_record:
                    if not json_output:
                        err(f'  No records found')
                    continue

                if not json_output:
                    err(f'  Analyzed {records_analyzed} records')

                # Compute field widths for each record, tracking first occurrence
                field_width_sequences = []
                first_occurrence = {}  # pattern -> (record_idx, line_num)
                for record_idx, (line, positions) in enumerate(zip(lines, comma_positions_by_record)):
                    widths = []
                    prev = 0
                    for pos in positions:
                        width = pos - prev
                        widths.append(width)
                        prev = pos + 1  # +1 to skip comma
                    # Last field (from last comma to end of record)
                    last_width = len(line) - prev
                    widths.append(last_width)
                    widths_tuple = tuple(widths)
                    field_width_sequences.append(widths_tuple)

                    # Track first occurrence (line_num is 1-based)
                    if widths_tuple not in first_occurrence:
                        first_occurrence[widths_tuple] = (record_idx, record_idx + 1)

                # Build histogram of field width sequences
                sequence_histogram = Counter(field_width_sequences)

                # Find mode pattern (most common) and detect internal commas
                # Get comma positions for each record
                all_comma_positions = comma_positions_by_record

                # Find intersection of all comma positions (always present)
                if all_comma_positions:
                    common_positions = set(all_comma_positions[0])
                    for positions in all_comma_positions[1:]:
                        common_positions &= set(positions)
                    common_positions = sorted(common_positions)

                    # Find union of all comma positions (sometimes present)
                    all_positions = set()
                    for positions in all_comma_positions:
                        all_positions.update(positions)
                    all_positions = sorted(all_positions)

                    # Variable positions = positions that aren't always present
                    variable_positions = [p for p in all_positions if p not in common_positions]

                    # Check if variable positions fall within fields defined by common positions
                    # (i.e., they're internal commas, not structural differences)
                    fields_with_internal_commas = []
                    if common_positions and variable_positions:
                        # Build field boundaries from common positions
                        field_boundaries = [(0, common_positions[0])]
                        for i in range(len(common_positions) - 1):
                            field_boundaries.append((common_positions[i] + 1, common_positions[i + 1]))
                        # Last field ends at record end (use first line's length as reference)
                        if lines:
                            field_boundaries.append((common_positions[-1] + 1, len(lines[0])))

                        # Check which variable positions fall within which fields
                        for var_pos in variable_positions:
                            for field_idx, (start, end) in enumerate(field_boundaries):
                                if start <= var_pos < end:
                                    if field_idx not in fields_with_internal_commas:
                                        fields_with_internal_commas.append(field_idx)
                                    break

                    # Compute mode pattern from common positions
                    mode_widths = []
                    prev = 0
                    for pos in common_positions:
                        mode_widths.append(pos - prev)
                        prev = pos + 1
                    if lines:
                        mode_widths.append(len(lines[0]) - prev)
                    mode_pattern = tuple(mode_widths)

                    # Check if all patterns are equivalent to mode (differ only by internal commas)
                    # All patterns should have same total line length (sum of widths + number of commas)
                    mode_line_length = sum(mode_pattern) + (len(mode_pattern) - 1)  # widths + commas
                    all_equivalent = all(
                        sum(widths) + (len(widths) - 1) == mode_line_length and len(widths) >= len(mode_pattern)
                        for widths in sequence_histogram.keys()
                    )
                else:
                    common_positions = []
                    mode_pattern = None
                    all_equivalent = False
                    fields_with_internal_commas = []

                if json_output:
                    # Collect JSON result
                    if all_equivalent and mode_pattern:
                        # Report mode pattern with internal comma info
                        result_obj = {
                            'source': rel_source,
                            'region': region,
                            'year': year,
                            'type': typ,
                            'records_analyzed': records_analyzed,
                            'mode_pattern': {
                                'widths': list(mode_pattern),
                                'total_len': sum(mode_pattern)
                            },
                            'fields_with_internal_commas': fields_with_internal_commas,
                            'records_with_internal_commas': records_analyzed - sequence_histogram[mode_pattern]
                        }
                    else:
                        # Report all patterns
                        patterns = []
                        for widths, count in sequence_histogram.most_common():
                            pct = 100 * count / records_analyzed
                            total_len = sum(widths)
                            record_idx, line_num = first_occurrence[widths]
                            patterns.append({
                                'widths': list(widths),
                                'count': count,
                                'percentage': round(pct, 1),
                                'first_rec_idx': record_idx,
                                'first_line_num': line_num,
                                'total_len': total_len
                            })
                        result_obj = {
                            'source': rel_source,
                            'region': region,
                            'year': year,
                            'type': typ,
                            'records_analyzed': records_analyzed,
                            'unique_patterns': len(sequence_histogram),
                            'patterns': patterns
                        }
                    results.append(result_obj)
                else:
                    # Human-readable output
                    if all_equivalent and mode_pattern:
                        # All patterns are equivalent (differ only by internal commas)
                        total_len = sum(mode_pattern)
                        widths_str = ','.join(str(w) for w in mode_pattern)
                        err(f'  Mode pattern ({total_len} chars): {widths_str}')
                        records_with_internal = records_analyzed - sequence_histogram.get(mode_pattern, 0)
                        if records_with_internal > 0:
                            pct = 100 * records_with_internal / records_analyzed
                            err(f'  Records with internal commas: {records_with_internal} ({pct:.1f}%) in fields {fields_with_internal_commas}')
                        else:
                            err(f'  ✓ All records match mode pattern exactly')
                    elif len(sequence_histogram) == 1:
                        # All records have same pattern
                        widths = list(sequence_histogram.keys())[0]
                        total_len = sum(widths)
                        widths_str = ','.join(str(w) for w in widths)
                        err(f'  ✓ All records have same field widths ({total_len} chars): {widths_str}')
                    else:
                        # Multiple patterns - show with alignment
                        err(f'  Field width patterns (showing top 5):')
                        patterns_to_show = sequence_histogram.most_common(5)

                        # For alignment, find max number of fields and max width of each field value
                        max_fields = max(len(widths) for widths, _ in patterns_to_show)
                        max_width_per_field = [0] * max_fields
                        for widths, _ in patterns_to_show:
                            for field_idx, width in enumerate(widths):
                                width_str = str(width)
                                max_width_per_field[field_idx] = max(max_width_per_field[field_idx], len(width_str))

                        # Calculate dynamic padding for metadata
                        max_count = max(count for _, count in patterns_to_show)
                        max_rec_idx = max(rec_idx for rec_idx, _ in first_occurrence.values())
                        max_line_num = max(line_num for _, line_num in first_occurrence.values())
                        max_total_len = max(sum(widths) for widths, _ in patterns_to_show)

                        count_width = len(str(max_count))
                        rec_idx_width = len(str(max_rec_idx))
                        line_num_width = len(str(max_line_num))
                        total_len_width = len(str(max_total_len))

                        for i, (widths, count) in enumerate(patterns_to_show):
                            pct = 100 * count / records_analyzed
                            total_len = sum(widths)
                            record_idx, line_num = first_occurrence[widths]

                            # Build aligned string with field values right-aligned within columns
                            aligned_parts = []
                            for field_idx in range(len(widths)):
                                width_str = str(widths[field_idx])
                                col_width = max_width_per_field[field_idx]
                                aligned_parts.append(width_str.rjust(col_width))
                            widths_str = ','.join(aligned_parts)

                            err(f'    Pattern {i+1} ({count:{count_width}d} records, {pct:5.1f}%, first at rec idx {record_idx:{rec_idx_width}d} / line {line_num:{line_num_width}d}, {total_len:{total_len_width}d} chars): {widths_str}')
                        if len(sequence_histogram) > 5:
                            err(f'    ... ({len(sequence_histogram) - 5} more patterns)')

    # Output JSON if requested
    if json_output:
        print(json.dumps(results, indent=2))

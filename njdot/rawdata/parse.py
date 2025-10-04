"""Parsing utilities for fixed-width NJDOT crash data files."""
from dataclasses import dataclass
from io import StringIO
import pandas as pd
from numpy import nan
from utz import err


BOOLS = { 'Y': True, 'N': False, '1': True, '0': False, '': False }


@dataclass
class ParseResult:
    """Result of parsing a fixed-width NJDOT data file."""
    df: pd.DataFrame
    # Diagnostic info
    total_records: int
    line_ending: str  # 'LF' or 'CRLF'
    expected_record_size: int  # From schema
    actual_record_size: int  # First record
    records_with_internal_newlines: int
    incomplete_final_record_bytes: int  # 0 if complete
    malformed_records: list  # [(record_num, line_num, pos, issue), ...]


def parse_row(f, idx, fields):
    row = {}
    for fidx, field in enumerate(fields):
        fname, flen = field['Field'], field['Length']
        fval = f.read(flen)
        if not fval:
            if fidx:
                raise RuntimeError(f'row {idx} fidx {fidx} {fname} ({flen}), empty read. {row}')
            else:
                return None
        fval = fval.strip()
        if fname != 'Comma':
            row[fname] = fval
    last = f.read(1)
    if last != '\n':
        raise RuntimeError(f'Row {idx}: expected newline at position {f.tell()}, found {last!r}, row {row}')
    return row


def parse_rows(txt_path, fields, return_diagnostics=False, max_records=None, raw_bytes=None):
    """Parse fixed-width NJDOT crash data file.

    Args:
        txt_path: Path to .txt file (or display name if raw_bytes provided)
        fields: List of field definitions from schema JSON
        return_diagnostics: If True, return ParseResult with diagnostics; otherwise return just DataFrame
        max_records: Maximum number of records to parse (None = all)
        raw_bytes: Optional raw bytes to parse instead of reading from txt_path

    Returns:
        ParseResult if return_diagnostics=True, otherwise pd.DataFrame
    """
    # Calculate expected record size in chars (all field lengths)
    data_size = sum(f['Length'] for f in fields)

    # Read file, decode from UTF-8 (handles 2023+ files with UTF-8 chars),
    # then normalize to ASCII/ISO-8859-1 compatible characters
    if raw_bytes is None:
        with open(txt_path, 'rb') as f:
            raw_bytes = f.read()

    # Try UTF-8 first (for 2023+ files), fall back to ISO-8859-1
    try:
        text = raw_bytes.decode('utf-8', errors='replace')
    except:
        text = raw_bytes.decode('ISO-8859-1')

    # Replace problematic Unicode characters with ASCII equivalents
    replacements = {
        '\u2013': '-',      # en-dash
        '\u2014': '-',      # em-dash
        '\u2019': "'",      # right single quote
        '\xa0': ' ',        # non-breaking space
        '\ufffd': ' ',      # replacement character (from UTF-8 decode errors)
        '\xad': '-',        # soft hyphen
    }
    for old, new in replacements.items():
        text = text.replace(old, new)

    # Detect line ending style (LF vs CRLF) and check for trailing padding
    first_lf = text.find('\n')
    if first_lf > 0 and text[first_lf-1:first_lf] == '\r':
        line_ending = '\r\n'
        line_ending_name = 'CRLF'
        expected_record_size = data_size + 2
    else:
        line_ending = '\n'
        line_ending_name = 'LF'
        expected_record_size = data_size + 1

    # Check actual record size (some files have extra chars)
    actual_first_record_size = first_lf + 1
    if actual_first_record_size == expected_record_size + 1:
        # 2023+ Vehicles files have +1 char (undocumented format change)
        record_size = expected_record_size + 1
        has_extra_char = True
        err(f'Detected extra character in data: record size {record_size} (schema expects {expected_record_size})')
    else:
        record_size = expected_record_size
        has_extra_char = False

    # Process records by character count
    rows = []
    idx = 0
    pos = 0
    line_num = 0  # Count actual \n characters
    records_with_internal_newlines = 0
    malformed_records = []
    incomplete_final_bytes = 0

    while pos < len(text) and (max_records is None or idx < max_records):
        # Read one record (fixed char count)
        record_text = text[pos:pos+record_size]
        if len(record_text) < record_size:
            # Incomplete last record
            incomplete_final_bytes = len(record_text)
            break

        # Strip extra character if present (e.g., 2023 Vehicles have +1 undocumented char)
        if has_extra_char:
            # Remove the last character before line ending
            record_text = record_text[:-(len(line_ending)+1)] + line_ending

        # Check for internal newlines before replacing them
        record_content_before = record_text[:-len(line_ending)]
        internal_newlines = record_content_before.count('\n') + record_content_before.count('\r')
        if internal_newlines > 0:
            records_with_internal_newlines += 1

        # Replace embedded newlines/carriage returns with spaces (except the trailing line ending)
        record_content = record_content_before.replace('\r', ' ').replace('\n', ' ')
        record_text = record_content + line_ending

        # Verify it ends with correct line ending
        if not record_text.endswith(line_ending):
            malformed_records.append((idx, line_num, pos, f'does not end with {line_ending_name}'))

        # Count newlines for line number tracking
        line_num += record_text.count('\n')

        # Normalize to LF for parsing
        if line_ending == '\r\n':
            record_text = record_content + '\n'

        # Parse this record
        record_io = StringIO(record_text)
        row = parse_row(record_io, idx=idx, fields=fields)
        if row:
            rows.append(row)
            idx += 1

        pos += record_size

    df = pd.DataFrame(rows)

    if return_diagnostics:
        return ParseResult(
            df=df,
            total_records=idx,
            line_ending=line_ending_name,
            expected_record_size=expected_record_size,
            actual_record_size=record_size,
            records_with_internal_newlines=records_with_internal_newlines,
            incomplete_final_record_bytes=incomplete_final_bytes,
            malformed_records=malformed_records,
        )
    else:
        return df


def load(txt_path, fields, ints=None, floats=None, bools=None):
    df = parse_rows(txt_path, fields)
    for k in ints or []:
        df[k] = df[k].replace('', '0').astype(int)
    for k in floats or []:
        df[k] = df[k].replace('', nan).astype(float)
    for k in bools or []:
        df[k] = df[k].apply(lambda s: BOOLS[s]).astype(bool)
    return df


def get_2021_dob_fix_fields(fields, dob_col, year):
    """Driver DOB is missing from 2021+ Drivers (similarly "Date of Birth" in 2021+ Pedestrians).

    For 2021-2022: DOB field is moved to end of record (as trailing spaces).
    For 2023+: DOB field is omitted entirely from the record.
    """
    new_fields = []
    pos = 1
    dob_field = None
    for f in fields:
        if f['Field'] == dob_col:
            dob_field = { **f }
        else:
            length = f['Length']
            new_field = { **f, 'From': pos, 'To': pos + length - 1, }
            pos += length
            new_fields.append(new_field)

    if not dob_field:
        raise RuntimeError(f"Couldn't find '{dob_col}' field in {fields}")

    if year < 2023:
        # 2021-2022: DOB moved to end as trailing spaces
        err(f"Moved '{dob_col}' to end of fields (year {year})")
        dob_field['From'] = pos
        dob_field['To'] = pos + dob_field['Length'] - 1
        new_fields.append(dob_field)
    else:
        # 2023+: DOB omitted entirely
        err(f"Removed '{dob_col}' from fields (year {year}, field omitted from data)")

    return new_fields


def get_2023_vehicles_fix_fields(fields, year):
    """2023 Vehicles have layout changes vs. schema:

    - Model field (schema pos 75-94, 20 chars) expanded to 30 chars (pos 75-104)
    - HazMat Placard comma + field (schema pos 173-183, 1+10 chars) omitted
    - Final trailing space omitted

    Total: +10 -9 -1 = 0 chars difference.

    We verify that:
    - Extra 10 chars in Model field (pos 89-98) are spaces
    - Record is 273 chars (vs schema's 272) before line ending
    """
    if year < 2023:
        # No changes for pre-2023
        return fields

    err(f"Adjusting Vehicles schema for 2023 layout changes")

    new_fields = []
    pos = 1

    for f in fields:
        fname = f['Field']
        flen = f['Length']

        if fname == 'Model of Vehicle':
            # Expand from 20 to 30 chars (extra 10 chars must be spaces)
            err(f"  Expanded 'Model of Vehicle' from {flen} to 30 chars (+10 trailing spaces)")
            new_field = { **f, 'Length': 30, 'From': pos, 'To': pos + 29 }
            new_fields.append(new_field)
            pos += 30
        elif fname in ('HazMat Placard',):
            # Omit HazMat Placard field and its preceding comma
            err(f"  Omitted '{fname}' field and preceding comma (schema pos {f.get('From', 'N/A')}-{f.get('To', 'N/A')})")
            # Skip this field and check if previous was a comma
            if new_fields and new_fields[-1]['Field'] == 'Comma':
                # Remove the preceding comma too
                removed_comma = new_fields.pop()
                pos -= removed_comma['Length']
                err(f"    Also removed preceding Comma")
        else:
            new_field = { **f, 'From': pos, 'To': pos + flen - 1 }
            new_fields.append(new_field)
            pos += flen

    # Note: 2023 data is 273 chars (not 272), with structure:
    # - Model field expanded (+10 chars)
    # - HazMat Placard + comma omitted (-9 chars)
    # - But there's still a trailing comma before Hit & Run flag (+1 char)
    # Net: +10 -9 +1 -1 = +1 char
    # Actually the data shows: last 3 chars are [space][comma][hit_run_flag]
    # The final "space" we thought was removed is actually still there before the final comma

    # Add back a trailing space field if needed to make total = 273
    total = sum(f['Length'] for f in new_fields)
    if total == 271:
        # Need 2 more chars: add space + comma before final field
        # Insert before the last field (Hit & Run Driver Flag)
        err(f"  Adding 2-char padding before Hit & Run flag (pos {pos}-{pos+1})")
        new_fields.insert(-1, {'Field': 'Padding', 'Length': 1, 'From': pos, 'To': pos})
        pos += 1
        new_fields.insert(-1, {'Field': 'Comma', 'Length': 1, 'From': pos, 'To': pos})
        pos += 1
        # Update Hit & Run field position
        new_fields[-1]['From'] = pos
        new_fields[-1]['To'] = pos

    return new_fields

#!/usr/bin/env python3
r"""Convert SQLite 3.51+ .dump output to be compatible with older SQLite.

Replaces unistr('...\uXXXX...') with plain SQL string literals containing
the actual Unicode characters. Reads stdin, writes stdout.
"""
import re
import sys


def decode_unistr(m: re.Match) -> str:
    s = m.group(1)
    # Build result, replacing \uXXXX escapes.
    # For control chars (< 0x20), use replace(char(N), ...) to keep SQL on one line.
    parts = []
    i = 0
    current = []

    def flush_current():
        if current:
            text = ''.join(current)
            # Don't re-escape quotes — '' pairs are already handled
            parts.append(f"'{text}'")
            current.clear()

    while i < len(s):
        if s[i] == '\\' and i + 5 < len(s) and s[i+1] == 'u':
            code = int(s[i+2:i+6], 16)
            if code < 0x20:
                # Control char: emit as char(N) concatenation
                flush_current()
                parts.append(f"char({code})")
                i += 6
            else:
                current.append(chr(code))
                i += 6
        elif s[i] == '\\' and i + 1 < len(s) and s[i+1] == '\\':
            current.append('\\')
            i += 2
        elif s[i] == "'" and i + 1 < len(s) and s[i+1] == "'":
            # SQL-escaped single quote ('') — pass through as-is
            current.append("''")
            i += 2
        else:
            current.append(s[i])
            i += 1

    flush_current()
    return '||'.join(parts) if len(parts) > 1 else (parts[0] if parts else "''")


UNISTR_RE = re.compile(r"unistr\('((?:[^'\\]|''|\\.)*)'\)")

for line in sys.stdin:
    if 'unistr(' in line:
        line = UNISTR_RE.sub(decode_unistr, line)
    sys.stdout.write(line)

#!/usr/bin/env bash
# Exact-diff flow against synthetic prior+current sqlite files. Proves
# `d1-diff.py` + the per-table dispatch in `d1-import.sh` produce DELETE+INSERT
# pairs that converge the dest to the source for: added, removed, and
# metric-changed rows; plus the no-natural-key fallback to DROP+CREATE+INSERT.
#
# No wrangler/D1 — `wrangler_exec` is replaced by piping the SQL files into
# sqlite3 against the dest.
set -euo pipefail
cd "$(dirname "$0")/../../.."

TEST_DIR="tmp/d1-exact-diff-test"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

SRC="$TEST_DIR/source.db"      # role of `www/public/njdot/cmymc.db` (current)
PRIOR="$TEST_DIR/prior.db"     # role of DVC-fetched prior .db
DST="$TEST_DIR/dest.db"        # role of D1 (started from prior, converges)
CHUNK_DIR="$TEST_DIR/chunks"
mkdir -p "$CHUNK_DIR"

DIFF_PY="api/scripts/d1-diff.py"
NATURAL_KEYS=(cc mc y m condition id dt)

# Build source: cmymc-style table (natural-key PK + metric cols) +
# njsp-crashes-style table (id as natural key) + no-NK metric-only table.
sqlite3 "$SRC" <<'SQL'
CREATE TABLE cmymc (cc INTEGER, mc INTEGER, y INTEGER, m INTEGER, n INTEGER);
INSERT INTO cmymc VALUES
    (1, 1, 2023, 1, 100),  -- unchanged
    (1, 1, 2023, 2, 101),  -- unchanged
    (1, 2, 2024, 1, 200),  -- metric changed (prior had n=999)
    (2, 1, 2025, 1, 300),  -- added (not in prior)
    (2, 1, 2025, 2, 301);  -- added
CREATE TABLE crashes (id INTEGER, dt TEXT, location TEXT);
INSERT INTO crashes VALUES
    (1001, '2024-01-15', 'Trenton'),
    (1002, '2024-03-22', 'Newark'),       -- location changed
    (1003, '2024-06-10', 'Camden');       -- added
CREATE TABLE meta_only (revision INTEGER, label TEXT);
INSERT INTO meta_only VALUES (3, 'v3'), (4, 'v4');
SQL

sqlite3 "$PRIOR" <<'SQL'
CREATE TABLE cmymc (cc INTEGER, mc INTEGER, y INTEGER, m INTEGER, n INTEGER);
INSERT INTO cmymc VALUES
    (1, 1, 2023, 1, 100),
    (1, 1, 2023, 2, 101),
    (1, 2, 2024, 1, 999),  -- stale metric
    (1, 2, 2024, 2, 700),  -- row removed upstream — must disappear
    (2, 1, 2024, 1, 150);  -- another removed row
CREATE TABLE crashes (id INTEGER, dt TEXT, location TEXT);
INSERT INTO crashes VALUES
    (1001, '2024-01-15', 'Trenton'),
    (1002, '2024-03-22', 'Trenton'),       -- stale location
    (1004, '2024-05-01', 'Paterson');      -- removed upstream
CREATE TABLE meta_only (revision INTEGER, label TEXT);
INSERT INTO meta_only VALUES (1, 'v1'), (2, 'v2');
SQL

# Dest starts byte-identical to prior (the "D1 just-synced-to-prior_md5" state).
cp "$PRIOR" "$DST"

# --- Helpers, mirroring d1-import.sh exactly enough to drive the per-table flow.
apply_to_dest() { sqlite3 "$DST" < "$1"; }

natural_key_cols() {
    local path="$1" table="$2"
    local in_list
    in_list=$(printf "'%s'," "${NATURAL_KEYS[@]}")
    in_list="${in_list%,}"
    sqlite3 "$path" \
        "SELECT name FROM pragma_table_info('$table') WHERE name IN ($in_list);" \
        | paste -sd, -
}

import_table() {
    local table="$1"
    local pk
    pk=$(natural_key_cols "$SRC" "$table")
    if [[ -z "$pk" ]]; then
        echo "  $table: no natural-key — DROP+CREATE+INSERT fallback"
        local drop_file="$CHUNK_DIR/${table}_drop.sql"
        echo "DROP TABLE IF EXISTS \"$table\";" > "$drop_file"
        apply_to_dest "$drop_file"
        rm -f "$drop_file"
        local schema_file="$CHUNK_DIR/${table}_schema.sql"
        sqlite3 "$SRC" ".schema \"$table\"" > "$schema_file"
        apply_to_dest "$schema_file"
        rm -f "$schema_file"
        local inserts_file="$CHUNK_DIR/${table}_inserts.sql"
        sqlite3 "$SRC" ".dump \"$table\"" | grep '^INSERT ' > "$inserts_file" || true
        if [[ -s "$inserts_file" ]]; then apply_to_dest "$inserts_file"; fi
        rm -f "$inserts_file"
        return
    fi
    echo "  $table: pk=($pk)"
    local del_file="$CHUNK_DIR/${table}_delete.sql"
    local ins_file="$CHUNK_DIR/${table}_upsert.sql"
    python3 "$DIFF_PY" \
        --curr "$SRC" --prior "$PRIOR" --table "$table" --pk "$pk" \
        --out-delete "$del_file" --out-upsert "$ins_file"
    if [[ -s "$del_file" ]]; then apply_to_dest "$del_file"; fi
    if [[ -s "$ins_file" ]]; then apply_to_dest "$ins_file"; fi
    rm -f "$del_file" "$ins_file"
}

for t in cmymc crashes meta_only; do import_table "$t"; done

# --- Assertions: dest must exactly match source, per-table, ordered.
# Sort in bash (column count varies per table; sqlite ORDER BY would need
# a per-table key list).
dump_sorted() {
    sqlite3 "$1" "SELECT * FROM \"$2\"" | sort
}

echo
fail=0
for t in cmymc crashes meta_only; do
    src_lines=$(dump_sorted "$SRC" "$t")
    dst_lines=$(dump_sorted "$DST" "$t")
    if [[ "$src_lines" != "$dst_lines" ]]; then
        echo "FAIL: $t mismatch"
        diff <(printf '%s\n' "$src_lines") <(printf '%s\n' "$dst_lines")
        fail=1
    else
        rows=$(printf '%s\n' "$src_lines" | wc -l | tr -d ' ')
        echo "OK: $t — $rows rows match"
    fi
done

if [[ $fail -ne 0 ]]; then
    echo "FAILED"
    exit 1
fi

# Also assert specifics about which scenarios actually fired:
#   - cmymc: 1 metric change + 2 removed rows = 3 deletes; 1 metric change + 2 adds = 3 upserts
#   - crashes: 1 location change + 1 removed = 2 deletes; 1 location change + 1 added = 2 upserts
echo
echo "--- delete/upsert counts ---"
expect_diff_counts() {
    local table="$1" pk="$2" expect_del="$3" expect_ins="$4"
    local del_file="$CHUNK_DIR/${table}_assert_del.sql"
    local ins_file="$CHUNK_DIR/${table}_assert_ins.sql"
    python3 "$DIFF_PY" \
        --curr "$SRC" --prior "$PRIOR" --table "$table" --pk "$pk" \
        --out-delete "$del_file" --out-upsert "$ins_file" 2>/dev/null
    local del ins
    del=$(grep -oE '\([^()]+\)' "$del_file" 2>/dev/null \
        | grep -vE '^\("' | wc -l | tr -d ' ' || echo 0)
    ins=$(grep -oE 'VALUES (.+);' "$ins_file" 2>/dev/null | grep -oE '\([^()]+\)' \
        | grep -vE '^\("' | wc -l | tr -d ' ' || echo 0)
    echo "$table: deletes=$del upserts=$ins (expected $expect_del / $expect_ins)"
    if [[ "$del" != "$expect_del" || "$ins" != "$expect_ins" ]]; then
        echo "FAIL: $table delta count mismatch"
        exit 1
    fi
}
expect_diff_counts cmymc   cc,mc,y,m 3 3
expect_diff_counts crashes id        2 2

echo
echo "All exact-diff checks PASSED."

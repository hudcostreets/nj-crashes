#!/usr/bin/env bash
# Dry-run the exact-diff flow against the real cmymc.db / njsp/crashes.db.
# Synthesizes a "prior" by perturbing the current .db (drop a few rows, mutate
# a few metric values, leave the rest untouched), then runs d1-diff.py and
# replays its DELETE+INSERT into the prior to assert it converges to current.
#
# Prints actual delta sizes so we can see what daily writes will look like.
set -euo pipefail
cd "$(dirname "$0")/../../.."

TEST_DIR="tmp/d1-dryrun"
rm -rf "$TEST_DIR"; mkdir -p "$TEST_DIR"

NATURAL_KEYS=(cc mc y m condition id dt)
DIFF_PY="api/scripts/d1-diff.py"

natural_key_cols() {
    local path="$1" table="$2"
    local in_list
    in_list=$(printf "'%s'," "${NATURAL_KEYS[@]}")
    in_list="${in_list%,}"
    sqlite3 "$path" \
        "SELECT name FROM pragma_table_info('$table') WHERE name IN ($in_list);" \
        | paste -sd, -
}

# Perturb a copy of $src to play the role of "prior":
#   - delete the most recent N rows from each table (simulates new data arriving)
#   - mutate the FIRST metric column of M random rows (simulates value drift)
make_prior() {
    local src="$1" prior="$2" table="$3" delete_n="$4" mutate_n="$5"
    cp "$src" "$prior"
    local metric_col
    metric_col=$(sqlite3 "$prior" \
        "SELECT name FROM pragma_table_info('$table') WHERE name NOT IN ('cc','mc','y','m','condition','id','dt') LIMIT 1;")
    if [[ -z "$metric_col" ]]; then
        echo "    no metric col found for $table — skipping mutation" >&2
        return
    fi
    sqlite3 "$prior" <<SQL
DELETE FROM "$table" WHERE rowid IN (
    SELECT rowid FROM "$table" ORDER BY rowid DESC LIMIT $delete_n
);
UPDATE "$table" SET "$metric_col" = COALESCE("$metric_col", 0) + 99999
WHERE rowid IN (
    SELECT rowid FROM "$table" ORDER BY random() LIMIT $mutate_n
);
SQL
}

# Apply DELETE + INSERT files to a dest sqlite, then assert it equals src.
apply_and_verify() {
    local src="$1" dest="$2" table="$3" del_file="$4" ins_file="$5"
    if [[ -s "$del_file" ]]; then sqlite3 "$dest" < "$del_file"; fi
    if [[ -s "$ins_file" ]]; then sqlite3 "$dest" < "$ins_file"; fi
    local src_dump dest_dump
    src_dump=$(sqlite3 "$src" "SELECT * FROM \"$table\"" | sort)
    dest_dump=$(sqlite3 "$dest" "SELECT * FROM \"$table\"" | sort)
    if [[ "$src_dump" != "$dest_dump" ]]; then
        echo "FAIL: $table dest != src after diff replay"
        diff <(printf '%s\n' "$src_dump") <(printf '%s\n' "$dest_dump") | head -10
        return 1
    fi
}

run_db() {
    local src="$1" delete_n="$2" mutate_n="$3"
    echo
    echo "=== $src ==="
    for t in $(sqlite3 "$src" ".tables" | tr ' ' '\n' | grep -v '^_metadata$'); do
        local pk
        pk=$(natural_key_cols "$src" "$t")
        if [[ -z "$pk" ]]; then
            echo "  $t: no natural-key — skipping (would fall back to DROP+INSERT)"
            continue
        fi
        local prior="$TEST_DIR/${t}_prior.db"
        make_prior "$src" "$prior" "$t" "$delete_n" "$mutate_n"
        local full_rows
        full_rows=$(sqlite3 "$src" "SELECT count(*) FROM \"$t\";")
        local del_file="$TEST_DIR/${t}_delete.sql"
        local ins_file="$TEST_DIR/${t}_upsert.sql"
        python3 "$DIFF_PY" \
            --curr "$src" --prior "$prior" --table "$t" --pk "$pk" \
            --out-delete "$del_file" --out-upsert "$ins_file"
        local delete_stmts upsert_stmts
        delete_stmts=$(grep -c '^DELETE' "$del_file" 2>/dev/null || echo 0)
        upsert_stmts=$(grep -c '^INSERT' "$ins_file" 2>/dev/null || echo 0)
        echo "  $t: pk=($pk) full=$full_rows delete_stmts=$delete_stmts upsert_stmts=$upsert_stmts"
        apply_and_verify "$src" "$prior" "$t" "$del_file" "$ins_file"
        rm -f "$prior" "$del_file" "$ins_file"
    done
}

# Real perturbations: delete the most-recent 10 rows + mutate 5 random metrics.
# Approximates "small daily delta": a handful of new rows + a handful of changed
# aggregates from AASHTO supplementing the latest year.
run_db www/public/njdot/cmymc.db 10 5
run_db www/public/njsp/crashes.db 10 5

echo
echo "All dry-run checks PASSED."

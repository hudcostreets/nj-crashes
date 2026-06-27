#!/usr/bin/env bash
# Import local SQLite databases into D1.
#
# Modes:
#   remote   — staging-swap workflow (default): create fresh staging D1,
#              import, verify, atomic binding swap via `wrangler.toml`
#              edit + `wrangler deploy`. Zero-downtime; mutates
#              `wrangler.toml` (must be committed). Always full import.
#   local    — `wrangler dev` local D1; direct DROP+CREATE+INSERT.
#   inplace  — remote, existing binding. Default uses exact-diff against
#              the prior `.db` (fetched via DVC md5 from local cache or
#              S3) so write volume tracks actual deltas. Pass `--full`
#              to force DROP+CREATE+INSERT (escape hatch for schema
#              changes or recovery).
#
# Usage:
#   bash scripts/d1-import.sh --local            [db_name ...]
#   bash scripts/d1-import.sh --inplace          [db_name ...]   # exact diff
#   bash scripts/d1-import.sh --inplace --full   [db_name ...]   # full re-import
#   bash scripts/d1-import.sh                    [db_name ...]   # remote, staging
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="remote"
FULL=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --local)   MODE="local";   shift ;;
        --inplace) MODE="inplace"; shift ;;
        --full)    FULL=1;         shift ;;
        --) shift; break ;;
        -*)
            echo "Unknown flag: $1" >&2
            exit 2
            ;;
        *) break ;;
    esac
done

WWW="../www/public"
CHUNK_DIR="tmp/chunks"
CHUNK_SIZE=200000
SMALL_THRESHOLD=$((50 * 1024 * 1024))  # 50MB
DVC_CACHE=".dvc/cache/files/md5"
DVC_S3_PREFIX="s3://nj-crashes/.dvc/files/md5"
# Universal natural-key columns (cmymc-style dims + njsp-crashes id/dt).
NATURAL_KEYS=(cc mc y m condition id dt)

declare -A DB_MAP=(
    [crashes]="$WWW/njdot/crashes.db"
    [vehicles]="$WWW/njdot/vehicles.db"
    [occupants]="$WWW/njdot/occupants.db"
    [pedestrians]="$WWW/njdot/pedestrians.db"
    [cmymc]="$WWW/njdot/cmymc.db"
    [njsp-crashes]="$WWW/njsp/crashes.db"
)

# Binding names in wrangler.toml, keyed by db_name
declare -A BINDING_MAP=(
    [crashes]="CRASHES_DB"
    [vehicles]="VEHICLES_DB"
    [occupants]="OCCUPANTS_DB"
    [pedestrians]="PEDESTRIANS_DB"
    [cmymc]="CMYMC_DB"
    [njsp-crashes]="NJSP_CRASHES_DB"
)

requested=("$@")

wrangler_exec() {
    local db_name="$1" file="$2"
    if [[ "$MODE" == "local" ]]; then
        npx wrangler d1 execute "$db_name" --local --file="$file"
    else
        npx wrangler d1 execute "$db_name" --remote --file="$file"
    fi
}

drop_tables() {
    local db_name="$1" local_path="$2"
    local tables
    tables=$(sqlite3 "$local_path" ".tables")
    if [[ -z "$tables" ]]; then return; fi
    local drop_file="$CHUNK_DIR/${db_name}_drop.sql"
    : > "$drop_file"
    for t in $tables; do
        echo "DROP TABLE IF EXISTS \"$t\";" >> "$drop_file"
    done
    echo "  Dropping existing tables..."
    wrangler_exec "$db_name" "$drop_file"
    rm -f "$drop_file"
}

import_data() {
    local db_name="$1" local_path="$2"
    local file_size
    file_size=$(stat -f%z "$local_path" 2>/dev/null || stat -c%s "$local_path")

    # Schema first (handles multi-line CREATE statements)
    local schema_file="$CHUNK_DIR/${db_name}_schema.sql"
    sqlite3 "$local_path" .schema > "$schema_file"
    echo "  Importing schema..."
    wrangler_exec "$db_name" "$schema_file"
    rm -f "$schema_file"

    # Dump INSERT statements
    local inserts_file="$CHUNK_DIR/${db_name}_inserts.sql"
    echo "  Dumping INSERT statements..."
    SCRIPT_DIR="$(dirname "$0")"
    sqlite3 "$local_path" .dump | python3 "$SCRIPT_DIR/dump-compat.py" | grep '^INSERT ' > "$inserts_file"

    local insert_lines
    insert_lines=$(wc -l < "$inserts_file")

    if [[ $file_size -lt $SMALL_THRESHOLD ]]; then
        echo "  Importing $insert_lines statements..."
        wrangler_exec "$db_name" "$inserts_file"
        rm -f "$inserts_file"
    else
        local num_chunks=$(( (insert_lines + CHUNK_SIZE - 1) / CHUNK_SIZE ))
        echo "  $insert_lines INSERT statements → $num_chunks chunks"
        split -l "$CHUNK_SIZE" "$inserts_file" "$CHUNK_DIR/${db_name}_chunk_"
        rm -f "$inserts_file"

        local i=0
        for chunk_file in "$CHUNK_DIR/${db_name}_chunk_"*; do
            i=$((i + 1))
            local chunk_lines
            chunk_lines=$(wc -l < "$chunk_file")
            echo "  Chunk $i/$num_chunks ($chunk_lines statements)..."
            wrangler_exec "$db_name" "$chunk_file"
            rm -f "$chunk_file"
        done
    fi
}

write_metadata() {
    local db_name="$1" local_path="$2"
    local md5
    md5=$(md5sum "$local_path" 2>/dev/null | cut -d' ' -f1 || md5 -q "$local_path")
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local meta_file="$CHUNK_DIR/${db_name}_metadata.sql"
    cat > "$meta_file" <<SQL
CREATE TABLE IF NOT EXISTS _metadata (source_md5 TEXT, imported_at TEXT, source_path TEXT);
DELETE FROM _metadata;
INSERT INTO _metadata VALUES ('$md5', '$ts', '$local_path');
SQL
    echo "  Writing _metadata (md5=$md5)..."
    wrangler_exec "$db_name" "$meta_file"
    rm -f "$meta_file"
}

# Get row count from a local .db file for a given table
local_row_count() {
    local db_path="$1" table="$2"
    sqlite3 "$db_path" "SELECT count(*) FROM \"$table\";"
}

# Get row count from a D1 database for a given table
d1_row_count() {
    local db_name="$1" table="$2"
    local flag="--remote"
    if [[ "$MODE" == "local" ]]; then flag="--local"; fi
    npx wrangler d1 execute "$db_name" $flag \
        --command="SELECT count(*) as n FROM \"$table\";" --json 2>/dev/null \
        | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['n'])"
}

verify_import() {
    local db_name="$1" local_path="$2"
    echo "  Verifying row counts..."
    local tables
    tables=$(sqlite3 "$local_path" ".tables")
    local ok=true
    for t in $tables; do
        local expected actual
        expected=$(local_row_count "$local_path" "$t")
        actual=$(d1_row_count "$db_name" "$t")
        if [[ "$expected" != "$actual" ]]; then
            echo "  MISMATCH $t: expected $expected, got $actual"
            ok=false
        else
            echo "  $t: $actual rows ✓"
        fi
    done
    if ! $ok; then
        echo "  VERIFICATION FAILED"
        return 1
    fi
}

# Echo D1's stamped source_md5 for db_name, or empty if missing/unreadable.
read_source_md5() {
    local db_name="$1"
    local flag="--remote"
    if [[ "$MODE" == "local" ]]; then flag="--local"; fi
    npx wrangler d1 execute "$db_name" $flag \
        --command="SELECT source_md5 FROM _metadata LIMIT 1;" --json 2>/dev/null \
        | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    rows = d[0]['results']
    print(rows[0]['source_md5'] if rows else '')
except Exception:
    print('')
" || echo ""
}

# Resolve a md5 to a local .db file (cache hit) or fetch from S3.
fetch_prior_db() {
    local md5="$1" out_path="$2"
    local rel="${md5:0:2}/${md5:2}"
    if [[ -f "$DVC_CACHE/$rel" ]]; then
        cp "$DVC_CACHE/$rel" "$out_path"
        return 0
    fi
    if command -v aws >/dev/null 2>&1; then
        if aws s3 cp "$DVC_S3_PREFIX/$rel" "$out_path" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Echo comma-separated natural-key columns present in (local_db, table).
natural_key_cols() {
    local local_path="$1" table="$2"
    local in_list
    in_list=$(printf "'%s'," "${NATURAL_KEYS[@]}")
    in_list="${in_list%,}"
    sqlite3 "$local_path" \
        "SELECT name FROM pragma_table_info('$table') WHERE name IN ($in_list);" \
        | paste -sd, -
}

# Exact-diff per-db: read prior md5, fetch prior .db, diff each table, apply.
import_db_diff() {
    local db_name="$1" local_path="$2"
    local current_md5 prior_md5
    current_md5=$(md5sum "$local_path" 2>/dev/null | cut -d' ' -f1 || md5 -q "$local_path")
    prior_md5=$(read_source_md5 "$db_name")
    echo "  current_md5=$current_md5"
    echo "  prior_md5=${prior_md5:-<none>}"
    if [[ -n "$prior_md5" && "$prior_md5" == "$current_md5" ]]; then
        echo "  no changes since last sync — skipping"
        return 0
    fi
    if [[ -z "$prior_md5" ]]; then
        echo "  no prior md5 stamped — falling back to full import"
        drop_tables "$db_name" "$local_path"
        import_data "$db_name" "$local_path"
        write_metadata "$db_name" "$local_path"
        return 0
    fi

    local prior_db="$CHUNK_DIR/${db_name}_prior.db"
    rm -f "$prior_db"
    if ! fetch_prior_db "$prior_md5" "$prior_db"; then
        echo "  prior .db ($prior_md5) not available in cache or S3 — falling back to full import"
        drop_tables "$db_name" "$local_path"
        import_data "$db_name" "$local_path"
        write_metadata "$db_name" "$local_path"
        return 0
    fi

    local tables t pk del_file ins_file
    tables=$(sqlite3 "$local_path" ".tables")
    SCRIPT_DIR="$(dirname "$0")"
    for t in $tables; do
        if [[ "$t" == "_metadata" ]]; then continue; fi
        pk=$(natural_key_cols "$local_path" "$t")
        if [[ -z "$pk" ]]; then
            echo "  $t: no natural-key columns — falling back to DROP+CREATE+INSERT"
            local drop_file="$CHUNK_DIR/${db_name}_${t}_drop.sql"
            echo "DROP TABLE IF EXISTS \"$t\";" > "$drop_file"
            wrangler_exec "$db_name" "$drop_file"
            rm -f "$drop_file"
            local schema_file="$CHUNK_DIR/${db_name}_${t}_schema.sql"
            sqlite3 "$local_path" ".schema \"$t\"" > "$schema_file"
            wrangler_exec "$db_name" "$schema_file"
            rm -f "$schema_file"
            local inserts_file="$CHUNK_DIR/${db_name}_${t}_inserts.sql"
            sqlite3 "$local_path" ".dump \"$t\"" \
                | python3 "$SCRIPT_DIR/dump-compat.py" \
                | grep '^INSERT ' > "$inserts_file" || true
            if [[ -s "$inserts_file" ]]; then
                wrangler_exec "$db_name" "$inserts_file"
            fi
            rm -f "$inserts_file"
            continue
        fi

        del_file="$CHUNK_DIR/${db_name}_${t}_delete.sql"
        ins_file="$CHUNK_DIR/${db_name}_${t}_upsert.sql"
        echo "  $t: pk=($pk)"
        python3 "$SCRIPT_DIR/d1-diff.py" \
            --curr "$local_path" \
            --prior "$prior_db" \
            --table "$t" \
            --pk "$pk" \
            --out-delete "$del_file" \
            --out-upsert "$ins_file"
        if [[ -s "$del_file" ]]; then
            wrangler_exec "$db_name" "$del_file"
        fi
        if [[ -s "$ins_file" ]]; then
            wrangler_exec "$db_name" "$ins_file"
        fi
        rm -f "$del_file" "$ins_file"
    done
    rm -f "$prior_db"

    write_metadata "$db_name" "$local_path"
}

# Create a staging D1 database, returns the new database_id
create_staging_db() {
    local db_name="$1"
    local staging_name="${db_name}-staging-$(date +%Y%m%d-%H%M%S)"
    echo "  Creating staging database: $staging_name"
    local output
    output=$(npx wrangler d1 create "$staging_name" 2>&1)
    local new_id
    new_id=$(echo "$output" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
    if [[ -z "$new_id" ]]; then
        echo "  ERROR: Could not extract database_id from wrangler output:"
        echo "$output"
        return 1
    fi
    echo "  Staging database_id: $new_id"
    echo "$new_id"
}

# Update wrangler.toml: replace database_id for a given database_name
update_wrangler_toml() {
    local db_name="$1" new_id="$2"
    local old_id
    old_id=$(grep -A2 "database_name = \"$db_name\"" wrangler.toml | grep database_id | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    if [[ -z "$old_id" ]]; then
        echo "  ERROR: Could not find database_id for $db_name in wrangler.toml"
        return 1
    fi
    sed -i.bak "s/$old_id/$new_id/" wrangler.toml
    rm -f wrangler.toml.bak
    echo "  Updated wrangler.toml: $db_name → $new_id (was $old_id)"
}

mkdir -p "$CHUNK_DIR"

# Collect databases to import
declare -a import_dbs=()
for db_name in "${!DB_MAP[@]}"; do
    if [[ ${#requested[@]} -gt 0 ]]; then
        skip=true
        for r in "${requested[@]}"; do
            if [[ "$r" == "$db_name" ]]; then skip=false; break; fi
        done
        if $skip; then continue; fi
    fi
    local_path="${DB_MAP[$db_name]}"
    if [[ ! -f "$local_path" ]]; then
        echo "SKIP $db_name: $local_path not found"
        continue
    fi
    import_dbs+=("$db_name")
done

if [[ ${#import_dbs[@]} -eq 0 ]]; then
    echo "No databases to import."
    exit 0
fi

if [[ "$MODE" == "local" || "$MODE" == "inplace" ]]; then
    if [[ "$MODE" == "local" ]]; then
        echo "Importing into LOCAL D1 databases"
    elif [[ "$FULL" -eq 1 ]]; then
        echo "Importing into REMOTE D1 databases (in-place, full DROP+CREATE+INSERT)"
    else
        echo "Importing into REMOTE D1 databases (in-place, exact diff)"
    fi
    echo
    for db_name in "${import_dbs[@]}"; do
        local_path="${DB_MAP[$db_name]}"
        size_human=$(du -h "$local_path" | cut -f1)
        echo "Importing $db_name ($size_human)..."
        if [[ "$MODE" == "inplace" && "$FULL" -eq 0 ]]; then
            import_db_diff "$db_name" "$local_path"
        else
            drop_tables "$db_name" "$local_path"
            import_data "$db_name" "$local_path"
            write_metadata "$db_name" "$local_path"
        fi
        if [[ "$MODE" == "inplace" ]]; then
            verify_import "$db_name" "$local_path"
        fi
        echo "  Done: $db_name"
        echo
    done
else
    echo "Importing into REMOTE D1 databases (staging workflow)"
    echo

    # Save wrangler.toml before appending staging entries. The happy path
    # restores from this backup and then rewrites the prod IDs (below). If
    # the script aborts before reaching that point, restore via trap — earlier
    # runs that crashed mid-import left orphaned `STAGING_*` bindings, which
    # then collided on the next run with "binding assigned to multiple D1
    # Database bindings".
    cp wrangler.toml "$CHUNK_DIR/wrangler.toml.pre-staging"
    staging_done=0
    trap '[[ $staging_done -eq 0 ]] && cp "$CHUNK_DIR/wrangler.toml.pre-staging" wrangler.toml || true' EXIT

    # Track staging database names/IDs for the deploy step
    declare -A staging_ids=()
    declare -A staging_names=()

    for db_name in "${import_dbs[@]}"; do
        local_path="${DB_MAP[$db_name]}"
        size_human=$(du -h "$local_path" | cut -f1)
        echo "=== $db_name ($size_human) ==="

        # Create staging database
        staging_name="${db_name}-staging-$(date +%Y%m%d-%H%M%S)"
        echo "  Creating staging database: $staging_name"
        output=$(npx wrangler d1 create "$staging_name" 2>&1)
        new_id=$(echo "$output" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
        if [[ -z "$new_id" ]]; then
            echo "  ERROR: Could not extract database_id:"
            echo "$output"
            exit 1
        fi
        echo "  Staging database_id: $new_id"
        staging_ids[$db_name]="$new_id"
        staging_names[$db_name]="$staging_name"

        # Temporarily add staging db to wrangler.toml so wrangler can find it
        # We use the staging name for import, then swap to production name
        cat >> wrangler.toml <<TOML

[[d1_databases]]
binding = "STAGING_${BINDING_MAP[$db_name]}"
database_name = "$staging_name"
database_id = "$new_id"
TOML

        # Import into staging
        import_data "$staging_name" "$local_path"
        write_metadata "$staging_name" "$local_path"

        # Verify
        verify_import "$staging_name" "$local_path"
        echo "  Done importing: $db_name"
        echo
    done

    # All imports verified — now swap bindings atomically (single deploy)
    echo "=== Swapping bindings ==="

    # Restore wrangler.toml from pre-staging backup, then update IDs
    cp "$CHUNK_DIR/wrangler.toml.pre-staging" wrangler.toml
    for db_name in "${import_dbs[@]}"; do
        new_id="${staging_ids[$db_name]}"
        update_wrangler_toml "$db_name" "$new_id"
    done
    staging_done=1  # past the trap-driven cleanup window

    echo
    echo "Deploying worker with new bindings..."
    npx wrangler deploy
    echo
    echo "Deploy complete. Old databases can be deleted manually:"
    echo "  npx wrangler d1 list"
    echo "  npx wrangler d1 delete <old-database-name>"
fi

echo "All imports complete."

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Import databases to D1" > "$DVX_COMMIT_MSG_FILE"
fi

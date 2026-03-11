#!/usr/bin/env bash
# Import local SQLite databases into D1 (local or remote).
#
# Large databases are dumped to SQL and split into chunks to avoid
# wrangler's ~128MB memory limit. Small databases (<50MB) are imported
# directly.
#
# Usage:
#   bash scripts/d1-import.sh [--local] [db_name ...]
#   bash scripts/d1-import.sh --local crashes vehicles
#   bash scripts/d1-import.sh              # remote, all databases
set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL_FLAG=""
if [[ "${1:-}" == "--local" ]]; then
    LOCAL_FLAG="--local"
    shift
    echo "Importing into LOCAL D1 databases"
else
    echo "Importing into REMOTE D1 databases"
fi

WWW="../www/public"
CHUNK_DIR="tmp/chunks"
# Max statements per chunk; ~200K is safe for wrangler's memory limit
CHUNK_SIZE=200000
# Databases under this size (bytes) skip chunking
SMALL_THRESHOLD=$((50 * 1024 * 1024))  # 50MB

declare -A DB_MAP=(
    [crashes]="$WWW/njdot/crashes.db"
    [vehicles]="$WWW/njdot/vehicles.db"
    [occupants]="$WWW/njdot/occupants.db"
    [pedestrians]="$WWW/njdot/pedestrians.db"
    [cmymc]="$WWW/njdot/cmymc.db"
    [njsp-crashes]="$WWW/njsp/crashes.db"
)

requested=("$@")

wrangler_exec() {
    local db_name="$1" file="$2"
    npx wrangler d1 execute "$db_name" $LOCAL_FLAG --file="$file"
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

import_small() {
    local db_name="$1" local_path="$2"
    echo "  Direct import (small database)..."
    local schema_file="$CHUNK_DIR/${db_name}_schema.sql"
    sqlite3 "$local_path" .schema > "$schema_file"
    wrangler_exec "$db_name" "$schema_file"
    rm -f "$schema_file"
    local inserts_file="$CHUNK_DIR/${db_name}_inserts.sql"
    sqlite3 "$local_path" .dump | grep '^INSERT ' > "$inserts_file"
    wrangler_exec "$db_name" "$inserts_file"
    rm -f "$inserts_file"
}

import_chunked() {
    local db_name="$1" local_path="$2"

    # Import schema separately (multi-line CREATE statements)
    local schema_file="$CHUNK_DIR/${db_name}_schema.sql"
    sqlite3 "$local_path" .schema > "$schema_file"
    local schema_lines
    schema_lines=$(wc -l < "$schema_file")
    if [[ $schema_lines -gt 0 ]]; then
        echo "  Importing schema ($schema_lines lines)..."
        wrangler_exec "$db_name" "$schema_file"
    fi
    rm -f "$schema_file"

    # Dump INSERT statements only
    echo "  Dumping INSERT statements..."
    local inserts_file="$CHUNK_DIR/${db_name}_inserts.sql"
    sqlite3 "$local_path" .dump \
        | grep '^INSERT ' \
        > "$inserts_file"

    local insert_lines
    insert_lines=$(wc -l < "$inserts_file")
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
}

mkdir -p "$CHUNK_DIR"

for db_name in "${!DB_MAP[@]}"; do
    # Skip if specific databases were requested and this isn't one of them
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

    file_size=$(stat -f%z "$local_path" 2>/dev/null || stat -c%s "$local_path")
    size_human=$(du -h "$local_path" | cut -f1)
    echo "Importing $db_name ($size_human) from $local_path..."

    drop_tables "$db_name" "$local_path"
    if [[ $file_size -lt $SMALL_THRESHOLD ]]; then
        import_small "$db_name" "$local_path"
    else
        import_chunked "$db_name" "$local_path"
    fi
    echo "  Done: $db_name"
    echo
done

echo "All imports complete."

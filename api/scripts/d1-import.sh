#!/usr/bin/env bash
# Import local SQLite databases into D1.
# Usage: bash scripts/d1-import.sh [--local]
#   --local: import into local D1 (for wrangler dev) instead of remote
set -euo pipefail

LOCAL_FLAG=""
if [[ "${1:-}" == "--local" ]]; then
    LOCAL_FLAG="--local"
    echo "Importing into LOCAL D1 databases (for wrangler dev)"
else
    echo "Importing into REMOTE D1 databases"
fi

WWW="../www/public"

declare -A DB_MAP=(
    [crashes]="$WWW/njdot/crashes.db"
    [vehicles]="$WWW/njdot/vehicles.db"
    [occupants]="$WWW/njdot/occupants.db"
    [pedestrians]="$WWW/njdot/pedestrians.db"
    [cmymc]="$WWW/njdot/cmymc.db"
    [njsp-crashes]="$WWW/njsp/crashes.db"
)

for db_name in "${!DB_MAP[@]}"; do
    local_path="${DB_MAP[$db_name]}"
    if [[ ! -f "$local_path" ]]; then
        echo "SKIP $db_name: $local_path not found"
        continue
    fi
    size=$(du -h "$local_path" | cut -f1)
    echo "Importing $db_name ($size) from $local_path..."
    npx wrangler d1 execute "$db_name" $LOCAL_FLAG --file=<(sqlite3 "$local_path" .dump) || {
        echo "  ERROR: import failed for $db_name"
        continue
    }
    echo "  Done"
done

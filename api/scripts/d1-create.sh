#!/usr/bin/env bash
# Create all D1 databases and print their IDs for wrangler.toml.
set -euo pipefail

dbs=(crashes vehicles occupants pedestrians cmymc njsp-crashes)

for db in "${dbs[@]}"; do
    echo "Creating D1 database: $db"
    npx wrangler d1 create "$db" 2>&1 || echo "  (may already exist)"
    echo
done

echo "Now run: npx wrangler d1 list"
echo "Copy the database_id values into api/wrangler.toml"

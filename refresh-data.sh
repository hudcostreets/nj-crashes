#!/usr/bin/env bash

set -e

if [ $# -eq 0 ]; then
    # Only the current and previous year seem to update; check one prior for good measure
    set -- 2020 2021 2022
fi

echo "Refreshing years: $@"
./update-year.sh "$@"

# Or: update all years
#./update-year.sh `seq 2008 2022`

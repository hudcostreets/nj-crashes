#!/usr/bin/env bash

set -e

for year in "$@"; do
    name="FAUQStats${year}.xml"
    wget -O "data/$name" "https://nj.gov/njsp/info/fatalacc/$name"
done

#!/usr/bin/env bash

update_year() {
    for year in "$@"; do
        name="FAUQStats${year}.xml"
        wget -O "data/$name" "https://nj.gov/njsp/info/fatalacc/$name"
    done
}

update_year `seq 2008 2022`

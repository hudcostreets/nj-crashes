# `njdot/data/2023/` — per-county bulk dumps

First year of the **per-county** bulk-dump format. 21 counties × 5
tables = 105 `.zip` files. (Statewide files are no longer published
in this format.)

## File pattern

`<County><year><Table>.zip`, where `<County>` is one of:

> Atlantic · Bergen · Burlington · Camden · CapeMay · Cumberland · Essex
> · Gloucester · Hudson · Hunterdon · Mercer · Middlesex · Monmouth ·
> Morris · Ocean · Passaic · Salem · Somerset · Sussex · Union · Warren

and `<Table>` is one of `Accidents`, `Drivers`, `Occupants`,
`Pedestrians`, `Vehicles`.

## Reconstructing a statewide view

Concatenate all 21 county files for a given table (e.g., all
`*2023Accidents.zip`) to get a statewide equivalent of what
[`../2022/NewJersey2022Accidents.zip`](../2022/) provides.

For browsing or analysis, our parsed parquet copies (e.g. our
[`crashes.parquet`](https://github.com/hudcostreets/nj-crashes) feed
the dashboard) merge all counties into a single table — that's the
recommended starting point unless you need the original NJ DOT layout.

## Schemas

See [`../fields/2017*Table.json`](../fields/) for column layouts.

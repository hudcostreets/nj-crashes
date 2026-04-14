# Facet NJDOT crashes by Police Department

## Motivation

The Alpine data-gap annotation (see `www/public/annotations.json`,
id `alpine-palisades-ipw-gap`) explains the 2013-2018 under-reporting
as "Palisades Interstate Parkway Police Department stopped filing
reports." Currently that's just a tooltip narrative. Ideally, the
user could click through from the tooltip to a view that *shows* the
pattern: Alpine crashes over time, grouped by `Police Department`.
With that view, the reader sees the 2012 → 2013 cliff in PIPW
submissions directly, rather than having to take our word for it.

The same facet is useful beyond Alpine — any time a jurisdictional
reporting change drives an apparent crash-count anomaly, being able
to split by reporting agency is the fastest way to diagnose.

## Data

NJDOT raw crash rows already carry:
- `Police Department` (free-text name, e.g. `PALISADES INTER. PARKWAY`)
- `Police Department Code`
- `Police Station`

Example 2012 vs 2015 Alpine Route 445 crashes split by `Police
Department`:
- 2012: 127 PIPW, 6 Alpine PD, 1 Parsippany-Troy Hills
- 2015: 1 PIPW, 0 Alpine PD
- 2019: 230 PIPW, 5 Port Authority of NY and NJ, 1 each for
  Parsippany/Fort Lee

This field is already parsed into `njdot/rawdata/pqt.py` output.

## UI integration

Two plausible surfaces:

### (a) Add `police-dept` as a new `stackBy` option in `CrashPlot`

`CrashPlot` already has `stackBy: 'none' | 'severity' | 'county' |
'municipality'`. Add `police-dept` — stacks the bars by reporting
agency. Available anywhere that shows NJDOT crashes, not just Alpine.

Challenges:
- PD list is long (hundreds statewide) — need aggressive top-N +
  "Other" bucketing, or only enable the option at muni level where
  the PD list is small.
- PD names have typos, case variants, and historical renames in raw
  data — should normalize upstream in `njdot/rawdata/pqt.py` first,
  or in a `police_depts.parquet` mapping table.
- Need a new pre-aggregated parquet (`ymccmcpds.parquet`?) to avoid
  loading full row data at query time. Or query on demand via D1.

### (b) Standalone "police-dept breakdown" linked from annotation

A smaller, linkable chart page: `/c/:county/:muni/police-depts`.
Given a geo, shows stacked bars by year grouped by PD. The
annotation tooltip gets a "See police-department breakdown →" link.
Simpler scope; avoids adding a stackBy mode to the main CrashPlot.

Recommend **(b) first**. It's a self-contained artifact that
validates the use case, and it gives the annotation tooltip
something concrete to link to. If it proves valuable at more than
just Alpine, promote to option (a).

## Pre-aggregation format

For option (b), build a per-muni parquet:
`www/public/njdot/police-depts/<cc>-<mc>.parquet` with columns
`(year, pd_code, pd_name, crashes, k, si, mi, pi, ni)`.
Small file per muni (few KB each for most).

Generation: add a step to `njdot compute pqt` that groups by
`(cc, mc, year, pd_code)` and writes the per-muni file.

## Annotation tooltip integration

Extend the annotation schema with:
```json
{
  "links": [
    { "label": "Police-dept breakdown", "href": "/c/bergen/alpine/police-depts" }
  ]
}
```
Rendered as a "[↗ Police-dept breakdown]" line inside the tooltip
body and the `<Annotation>` panel. Ties into
`specs/page-annotations.md` (generic link rendering for annotation
kinds).

## Open questions

- How aggressively to normalize PD names? Raw values include
  `PALISADES INTER. PARKWAY`, `PALISADES INTERSTATE PKWY POLICE DEPT`,
  etc. Keep raw and also a canonical slug.
- Multi-PD munis (e.g. an interstate shared by 3 jurisdictions) need
  a sensible color palette + legend.
- Scope to fatal/injury/all? Probably "all" to avoid empty bars.

## Out of scope

- State-level PD aggregation (thousands of agencies).
- Historical PD renames / mergers tracking.
- Linking annotation tooltips to this view automatically (requires
  the `links` field to be populated per-annotation by hand).

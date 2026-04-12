# NJSP Annual Report PDFs — Data Quality Findings

This document catalogs inconsistencies found while parsing NJSP annual fatal-crash
report PDFs (2001–2024) at `www/njsp/data/annual-reports/*.pdf`.

## Methodology

Each PDF contains at least three tables we can cross-check:

- **Section A** — *"Victim Classification by Month"* (2006+) / *"Accident Victim
  Classification by Month"* (2001–2005): monthly driver/passenger/pedestrian/
  pedalcyclist counts, with a "Totals" column.
- **Section B** — *"Accidents and Fatalities by Month of Occurrence"* (2001–2005) /
  *"Crashes and Fatalities by Month of Occurrence"* (2006+): monthly accident
  counts and fatality counts, aggregated across a 5-year window that includes
  the report's own year.
- **Per-crash listing** — *"Fatal Crashes by County, Municipality, Date, Time and
  Location"* (2006+) / *"Fatal Accidents by County, …"* (2001–2005): one row per
  fatal crash with a `Persons Killed` free-text column (e.g. `"1 DRIVER"`,
  `"1 DRIVER, 1 PASSENGER"`, `"1 PEDEDESTRIAN"`).

The parser (`extract_county_monthly_types.py` / `extract_monthly_types.py`)
extracts all three independently so we can triangulate.

**Identity checks that pass for every year, 2001–2024:**
- Section A's printed "Totals" row equals the sum of its monthly type cells.
- Section B's fatalities column equals Section A's monthly totals.

So **within the PDF, Section A and Section B are always internally consistent**.

## Finding 1: Per-crash row count matches Section B accident count (99.9% of months)

For every residual year (2001–2005, 2012, 2015, 2016, 2017, 2019, 2022), the
number of per-crash rows we parse for each month matches Section B's accident
count **exactly**, with one exception:

| Year | Month | Section B accidents | Per-crash rows parsed |
|------|-------|---------------------|-----------------------|
| 2003 | April | 47                  | 46                    |

Inspection of the 2003 April per-crash section shows 46 date-bearing rows and no
visibly-wrapped or missing lines. This appears to be a case where **Section B
reports 47 April accidents but the per-crash section physically lists only 46**.

## Finding 2: A literal typo masks one 2001 row (PARSER FIX)

The 2001 PDF contains one crash row where `PEDESTRIAN` is misspelled as
`PEDEDESTRIAN`:

```
CARNEYS POINT TWP 02/22/2001 THURSDAY 1357 TURNPIKE 3.4 1 PEDEDESTRIAN
```

We patched the parser to tolerate `PED(?:ED)?ESTRIAN` so this row is now counted.
(Commit `778100e8062`.)

## Finding 3: Section A totals disagree with per-crash listing on victim type

For 21 (year, month) cells across 11 years, Section A's type totals and the sum
of per-crash rows (as captured by our parser) disagree. In all but one case
(2003 April, see Finding 1 above), **the number of crash rows matches**; the
disagreement is in how victims are categorized or how many victims a given
crash had.

Two patterns emerge:

### 3a. Net-zero rearrangements

Same monthly total, but types re-allocated between Section A and the per-crash
rows:

| Year-Mo | Section A (D,P,C,Ped)=T | Per-crash (D,P,C,Ped)=T | Shift           |
|---------|-------------------------|-------------------------|-----------------|
| 2001-12 | (40, 19, 1, 21)=81      | (41, 19, 1, 20)=81      | D+1, Ped-1      |
| 2003-02 | (22, 12, 1, 11)=46      | (23, 12, 1, 10)=46      | D+1, Ped-1      |
| 2003-08 | (53, 18, 1, 9)=81       | (52, 19, 1, 9)=81       | D-1, P+1        |
| 2004-02 | (34, 6, 1, 8)=49        | (35, 5, 1, 8)=49        | D+1, P-1        |
| 2004-04 | (27, 6, 2, 9)=44        | (28, 5, 2, 9)=44        | D+1, P-1        |
| 2005-07 | (39, 15, 3, 9)=66       | (40, 14, 3, 9)=66       | D+1, P-1        |

These require a victim to be assigned one type in Section A and a different type
in the per-crash listing.

### 3b. Off-by-one fatality counts

Monthly total differs by ±1. In every case, the per-crash rows for that month
match Section B's accident count, so a crash with two victims is listed
somewhere with only one type count (or vice versa):

| Year-Mo | A total | Per-crash total | Delta | Direction                                   |
|---------|---------|-----------------|-------|---------------------------------------------|
| 2002-03 | 55      | 56              | +1    | per-crash over                              |
| 2003-06 | 88      | 89              | +1    | per-crash over                              |
| 2003-09 | 56      | 55              | −1    | per-crash under                             |
| 2004-05 | 60      | 61              | +1    | per-crash over                              |
| 2004-11 | 58      | 59              | +1    | per-crash over                              |
| 2005-03 | 59      | 58              | −1    | per-crash under                             |
| 2005-04 | 59      | 60              | +1    | per-crash over                              |
| 2012-01 | 52      | 51              | −1    | per-crash under (pedestrian)                |
| 2015-08 | 45      | 44              | −1    | per-crash under (pedestrian)                |
| 2015-11 | 53      | 52              | −1    | per-crash under (pedestrian)                |
| 2016-11 | 52      | 51              | −1    | per-crash under (driver)                    |
| 2017-10 | 65      | 64              | −1    | per-crash under (cyclist)                   |
| 2019-02 | 40      | 39              | −1    | per-crash under (pedestrian)                |
| 2022-09 | 68      | 67              | −1    | per-crash under (pedestrian)                |

Since total mismatches can be in either direction, this is not a systematic
parser under-count. It's Section A counting one more (or one fewer) victim
than the per-crash listing reports, for a specific crash in that month.

### 3c. Compound rearrangement + off-by-one

Two residuals show both a type shift and a fatality-count change:

| Year-Mo | Section A          | Per-crash          | Shift                   |
|---------|--------------------|--------------------|-------------------------|
| 2003-04 | (37, 6, 0, 7)=50   | (37, 6, 0, 6)=49   | Ped−1 (row count off)   |
| 2003-06 | (52, 25, 2, 9)=88  | (54, 24, 2, 9)=89  | D+2, P−1, net +1        |

## Annual residual summary (after all parser fixes)

|Year|Δ Driver|Δ Passenger|Δ Cyclist|Δ Pedestrian|Net|
|----|--------|-----------|---------|------------|---|
|2001| +1     | 0         | 0       | −1         | 0 |
|2002| +1     | 0         | 0       | 0          |+1 |
|2003| +2     | −1        | 0       | −2         | −1|
|2004| +3     | −1        | 0       | 0          |+2 |
|2005| +1     | −1        | 0       | 0          | 0 |
|2012| 0      | 0         | 0       | −1         | −1|
|2015| 0      | 0         | 0       | −2         | −2|
|2016| −1     | 0         | 0       | 0          | −1|
|2017| 0      | 0         | −1      | 0          | −1|
|2019| 0      | 0         | 0       | −1         | −1|
|2022| 0      | 0         | 0       | −1         | −1|

Years not listed (2006–2011, 2013–2014, 2018, 2020–2021, 2023–2024) match
Section A **exactly** on every type and total.

Max annual |net| is 2. Sum of all 21 nonzero cells' absolute deltas = 23
victim-type units across 24 years × ~620 annual fatalities ≈ **0.02% of
victim-type classifications disagree internally** within the NJSP PDFs.

## Questions for NJSP

1. For each (year, month, type) cell in §3 above, which source is authoritative
   — Section A's summary, or the per-crash listing?
2. Is there raw crash-level data (the source for both Section A and the
   per-crash listing) that could be shared so downstream users don't need to
   reconcile the PDF tables?
3. For 2003 April: Section B claims 47 accidents but the per-crash section
   lists 46. Is a record missing from the PDF?
4. For the literal `PEDEDESTRIAN` typo in the 2001 per-crash listing, and the
   cyclist nomenclature drift across years (`PEDALCYCLE` in 2001,
   `BICYCLIST` in 2002–05, `PEDAL CYCLIST`/`PEDALCYCLIST` in 2006+), is there
   an authoritative style guide or data dictionary we could reference?

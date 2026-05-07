# Cells API: flexible temporal axis (and convergence with ctbk)

## Status (2026-05-07)

Design note, no implementation. Use-case-gated — defer until one of the
listed scenarios actually lands.

## Motivation

ctbk (Citi Bike GBFS) recently shipped a 2D rollup grid: `(agg × cons)`,
where `agg` is bucket size (1m, 5m, 1h, 1d) and `cons` is the
consolidation period each bucket covers. Cascade compactor on
CFW + GHA cron, `ShardStore` interface, YAML grid spec, calendar-aware
period encoding, monoid `(n, sum, sum²)` merge for variance derivation.
See ctbk commits ~Feb-May 2026, particularly `8371f126` (`ShardStore`
interface), `3b79e106` (grid spec + types), `744de9a8` (cascade), and
`45a9d762` (`ensureCell` driver).

Crashes' cells pipeline is conceptually a sibling system: H3 resolution
hierarchy r6..r14 sharded by r4 parents, with `(year)` as the only
temporal dim. We're a single-axis subset of ctbk's two-axis grid. The
question this note exists to capture: when does it pay off to expand
crashes' temporal axis, and is there a shared library hiding here?

## Use cases (and what each requires)

### 1. Date-bounded queries (e.g. report cards for elected officials)

> "Show all crashes in this town during this mayor's term:
> 2018-01-15 → 2022-01-15."

**Doesn't need pyramid changes.** Raw r14 already has per-row `dt`
(epoch-minute), so a worker endpoint can filter `dt ∈ [a, b]` over the
cells covering a muni and aggregate at request time. Worker work: small
(extend the raw fast-path to accept a `dt_min`/`dt_max` query param,
push it into the row-group filter). Pipeline work: zero.

This is the *cheapest* of the three to ship. Likely first to actually
land, since "report cards" is a foreseeable product direction.

### 2. Sub-month trend bucketing (smoothing, weekly/daily charts)

> "Show this county's crash count by week, with a 30-day MA overlay."

**Needs a pyramid extension.** Add `(year, month)` (and maybe
`(year, week)` or `(year, dow)`) as additional temporal axes alongside
H3 resolution. Storage at coarse H3 res is small — r6 with 12 month
buckets per year is 12× the current r6 row count = ~165k cell-month
rows, still well under 5 MB. Cost grows as we add finer time
granularity at finer H3 res, so probably want to cap aggressively:
e.g., monthly only at r6..r9, year-only at r10..r14.

Speculative without a concrete chart. Defer until per-capita / smoothed
trend plots ask for it (`per-capita-stats.md`,
`projection-and-yoy-audit.md` adjacent).

### 3. Distribution-monoid stats (mean, variance, percentiles)

> "Show fatalities-per-100k by muni, with confidence intervals."

**Needs a real-valued aggregation column + monoid `(n, sum, sum²)`
storage** (similar to ctbk's availability metric). Crash data is
mostly integer counts, so the natural place this becomes useful is
*derived* per-capita rates — but those are rates, not raw monoidal
sums.

The convergence story is **asymmetric**: ctbk's strength here comes
from continuous availability metrics (station fullness over time);
crashes are events (fatal/injury/PDO), so percentile-style queries
don't natively apply. We'd benefit from this only if we start
aggregating continuous derivative fields. No concrete use case today.

## Library extraction

### High confidence (extractable today, but small win)

- **`ShardStore` interface**: head/get/put/list abstraction over R2 +
  local + Node, used in CFW workers and CLI. Both projects do these
  operations; both could share. ~1 day to lift; modest user-visible
  value (cleaner test ergonomics for `cells-api`).

### Moderate confidence (would need refactor on both sides)

- **Period-encoding helpers**: ctbk has calendar-aware encoders
  (`YYYYMM`, ISO weeks, `YYYY-MM-DD_HHMM`). Crashes only uses `year`
  today, so paying for unused encoders is premature. Reusable when
  use case 2 above lands.

### Low confidence (don't unify yet)

- **Cascade orchestration / `ensureCell` driver**: ctbk's two-pass cron
  cascade with manifest-as-state-machine is solving an *online
  streaming* problem. Crashes does *offline batch* rebuilds. The
  abstraction layers don't naturally meet. Wait for a third project
  before generalizing.

- **Manifest topology**: ctbk's D1-backed live manifest vs. crashes'
  static JSON. Different consistency models. Same answer: wait.

## Recommendation

Do nothing infrastructural right now.

**When to revisit**:

- *Use case 1 (report cards) lands*: implement the `dt`-range raw-layer
  filter in the worker. No pyramid work; no library lift.
- *Use case 2 (smoothing / weekly charts) lands*: add a `(year, month)`
  pyramid axis at coarse H3 res. At that point the period-encoding
  abstraction becomes useful and the `ShardStore` lift might piggy-back.
- *A third sibling project appears*: revisit unification across
  ctbk + crashes + (third). Two data points isn't enough to design a
  general grid framework.

## Out of scope

- Designing the new (year, month) schema. Defer until use case lands.
- Migrating either project to a shared library. Premature.
- Backfilling distribution-monoid columns. No use case.

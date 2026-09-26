# Compact wire format for `/v1/cells`

Status: `format=cols` + `fields=` landed for heatmap C (see "Heatmap C" below;
dev worker only as of 2026-09-26); the general client rollout is not started.
Measured 2026-08-22 against the deployed worker (`tmp/audit-cells.py`,
`tmp/audit-encoding.py`).

## Problem

The bins budget (`BINS_BUDGET = 100_000`, `specs/autores-bins-budget.md`) is a
**render** budget with no **byte** budget attached. The picker is doing what it
was told — keep cells ~1-5 px so the map stays legible — and the wire cost of
that decision is unbounded:

| view | level | cells | JSON body | gzip | B/cell |
|---|---|---|---|---|---|
| statewide wide (embed) | 12 | 4,690 | 742 KB | 97 KB | 158 |
| statewide mid | 13 | 12,560 | 2.05 MB | 229 KB | 163 |
| statewide mid | 14 | 36,027 | 5.97 MB | 580 KB | 166 |
| Hudson-fit (viewport bbox) | 17 | 168,415 | 30.5 MB | 1.87 MB | 181 |

Ryan, voting on `/tune/ab`: *"across many examples i felt that the data xfer
was higher than we want. in some cases it seems well above what should be
required given what was rendered."* Vote rows back that up — `picker_votes` #9
recorded 15.7 MB for one Hudson side, #13/#19/#21/#24 carry a "too much data"
note.

The per-cell breakdown (statewide mid l14, `labels=full`):

| field | B/cell | share |
|---|---|---|
| `sld_name` | 29.2 | 15.2% |
| `mun` | 29.1 | 15.2% |
| `county` | 21.8 | 11.4% |
| `n_inj_other` | 19.5 | 10.2% |
| `h3` | 19.0 | 9.9% |
| `n_inj_ped` | 17.0 | 8.9% |
| `n_vehs` | 15.0 | 7.8% |
| `n_fatal` | 15.0 | 7.8% |
| `n_pdo` | 13.8 | 7.2% |
| `cross_sld_name` | 12.1 | 6.3% |

Two independent kinds of waste:

1. **Labels** (~48%) are tooltip-only, and at these cell sizes they're not even
   *correct* — a level-13 cell is ~1 km across, so its centroid's `sld_name` is
   one of many roads it covers. Partly addressed now (client gate +
   `label_max_cells`, below); fully addressed by `specs/labels-on-demand.md`.
2. **The counts** (~52%) are integers, mostly small, in a per-object JSON
   envelope that re-sends every key name for every cell. `"n_inj_other":0,` is
   17 bytes carrying ~1 bit. Measured zero-rates at statewide l14: `n_fatal`
   81%, `n_inj_ped` 76%, `n_inj_other` 22%, `n_pdo` 3%, `n_vehs` 0%.

Cardinality also argues against the current shape: at l14 statewide there are
**501** distinct `mun` values and **21** distinct `county` values across 36,027
cells, each re-sent in full.

## Candidate encodings (measured on the same l14 statewide payload)

| encoding | body | gzip | B/cell | gz B/cell |
|---|---|---|---|---|
| current (`labels=full`) | 5.97 MB | 580 KB | 166 | 16.1 |
| A. drop 4 label columns (`labels=nums`) | 3.00 MB | 321 KB | 83.4 | 8.9 |
| B. A + omit zero counts | 2.13 MB | 298 KB | 59.1 | 8.3 |
| C. columnar (parallel arrays) | 843 KB | 222 KB | 23.4 | 6.2 |
| D. C + sorted, prefix-delta tokens | **634 KB** | **152 KB** | **17.6** | **4.2** |
| E. binary: delta-varint cell ids + varint counts | 382 KB | 131 KB | 10.6 | 3.6 |

**D is the recommendation**: 9.4× smaller uncompressed, 3.8× on the wire,
while staying JSON (debuggable in DevTools, `curl`-able, no client decoder
beyond a loop). E's extra 1.7× on the body doesn't buy much on the wire (152 KB
→ 131 KB) and costs a binary decoder plus a second content type.

D's shape:

```json
{
  "res": 14, "year_range": [2001, 2025], "data_version": "…",
  "source": "d1", "labels": "nums", "n": 36027,
  "cols": {
    "cell": ["89c25c14", "8+3", "6+45", …],
    "n_fatal": [0, 0, 1, …], "n_inj_ped": [...], "n_inj_other": [...],
    "n_pdo": [...], "n_vehs": [...]
  }
}
```

- `cell[i]` for `i > 0` is `<shared-prefix-length><suffix>`: cells are sorted
  (which they already are coming out of a `cellid BETWEEN` scan — no extra
  sort), and S2 tokens on the Hilbert curve share long prefixes with their
  neighbors, so the average entry is ~4 chars instead of 17.
- Count arrays are dense (no key repetition, no per-cell braces).
- Labels, when present, ride as `cols.sld_name` etc. — and `mun`/`county`
  become dictionary-encoded (`{"dict": ["Hudson", …], "idx": [0, 0, 3, …]}`),
  which is where their 51 B/cell goes to ~2.

## Heatmap C: `format=cols` + `fields=` (2026-09-26, landed on dev)

Heatmap C (`useHeatTiles`) uses only `cellid` + the four severity counts `cellHeatWeight` reads, but fetched every count column (`n_fatal`, `n_inj_ped`, `n_inj_other`, `n_pdo`, `n_vehs`, `n_killed`, `n_killed_ped`) plus `fatal_years`, as row objects. A view is ~10–13 tiles, and each zoom step fetches a new tile×level set; a few minutes of zoom/pan measured **35 MB / 749 requests**.

### Design

Opt-in, additive request mode on `/v1/cells` (`cells-api/src/cells.ts`):

- `format=cols` → `CellsColsResponse`: the row response's envelope (`res`, `year_range`, `data_version`, `source`, `labels`) plus `format: "cols"`, `cellid_enc: "prefix-hex1"`, `n`, and `cols: {cellid: [...], <field>: [...], ...}` — this spec's candidate **D**.
- `fields=n_fatal,n_inj_ped,n_inj_other,n_pdo` (requires `format=cols`; default all seven counts): which count columns ship, in the order given. Unknown/repeated names → 400.
- Label-less: `format=cols` implies `labels=nums`; `labels=full|only` → 400. `fatal_years` is never shipped, and the D1 scan stops selecting/parsing it in this mode.
- Rows are sorted by `cellid` (lex order of stripped tokens = cell-id order at a fixed level), and `cols.cellid[i]` is `<one hex digit: prefix length shared with cellid[i-1]><suffix>` (entry 0 has prefix `0`). Tokens are distinct and ≤16 chars, so the shared prefix is ≤15 and one hex digit is unambiguous — no separator needed.
- Same query code on both paths (D1 and the year-filtered pyramid): `handleCellsRequest` runs the unchanged query and `toColumnar` reshapes the result. The default (`format` unset / `rows`) path is untouched and byte-identical (verified vs prod, below).

Why `fields=` rather than a server-computed weight (`weight=` / `[cellid, w]` pairs): the client names the raw counts it needs and keeps `cellHeatWeight` as the one place the severity weighting lives, so worker and client can't drift, and `fetchTileCells` still builds the same `StackedCell[]` (per-severity breakdown intact) — nothing downstream changes. The cost of that choice is measurable: `fields=n_pdo` (one int column, a proxy for a single `w` column) is ~half the wire bytes of the four-field request (z8: 49 KB vs 94 KB). If that second 2× is wanted later, a client-supplied linear combination (`weight=n_fatal:8,n_inj_ped:2,…`) keeps the weights client-owned — but drops the breakdown from `StackedCell`.

Client (`www/src/map/cellsCols.ts`): `heatCellsFromBody` decodes `cols` into `StackedCell[]` and still accepts the row shape, so the new client works against a worker that predates `format=cols` (it ignores unknown params and answers in rows; the client keeps sending `labels=nums` so that fallback stays label-less).

### Measured (2026-09-26, `crashes-cells-dev.hccs.dev`, `Accept-Encoding: br, gzip`)

Exact `fetchTileCells` query shape (`severities=fip`, `maxCells=150000`, tile bbox + 30% margin), one tile each; parse = median `JSON.parse` in Node; parse+decode adds the per-cell loop to `StackedCell`-equivalent tuples (no `tokenCenterLngLat`).

D1 path (`years=2001-2025`, all years):

| view | tile | level | cells | wire rows → cols | decoded rows → cols | parse ms | parse+decode ms |
|---|---|---|---|---|---|---|---|
| statewide z8 | 8/75/96 | l14 | 29,498 | 305 → **94 KB** (3.2×) | 3,384 → **421 KB** (8.0×) | 6.4 → 1.8 | 7.8 → 3.8 |
| z10.5 | 11/602/769 | l17 | 41,550 | 312 → **108 KB** (2.9×) | 4,786 → **577 KB** (8.3×) | 7.7 → 3.0 | 8.9 → 5.0 |
| z13.7 | 14/4821/6159 | l19 | 4,202 | 25 → **11 KB** (2.2×) | 486 → **59 KB** (8.3×) | 1.1 → 0.3 | 0.8 → 0.4 |

Pyramid path (`years=2020-2025`):

| view | cells | wire rows → cols | decoded rows → cols | parse ms |
|---|---|---|---|---|
| z8 | 27,542 | 242 → **72 KB** | 3,175 → **377 KB** | 6.9 → 1.3 |
| z10.5 | 37,913 | 247 → **86 KB** | 4,360 → **518 KB** | 6.5 → 1.8 |
| z13.7 | 3,657 | 20 → **9 KB** | 422 → **51 KB** | 0.6 → 0.2 |

Other `fields` choices at the same tiles (D1, wire / decoded): all seven counts 143 / 625 KB (z8); `n_pdo` only 49 / 231 KB (z8).

In the browser (local `www` dev server → dev worker, `/map?mode=heatmap&hr=c`, default statewide view, 12 tiles at l14; UI years 2001–2023, so the pyramid path): **1,238 → 400 KB wire, 13.4 MB → 1.66 MB decoded, 68 → 12 ms total `JSON.parse`**, same cell counts, surface renders as before.

Checks: decoded per-cell `(cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo)` identical between modes for all six requests above (and the envelope fields); default-mode bodies from the dev worker byte-identical to prod (`crashes-cells.hccs.dev`) for the same six queries. Tests: `cells-api/src/cells-cols.test.ts` (parse, encoding, D1 + pyramid paths in both modes, default-mode goldens produced by the pre-change handler), `www/src/map/cellsCols.test.ts`.

Not addressed here: the heatmap page also fires the regular (non-tile) `useCellsApi` fetch — 2 statewide l13 `labels=nums` row requests, 370 KB wire / 3.4 MB decoded on the default view — which C doesn't render from. That's the general rollout below (or skipping that fetch under `hr=c`).

## Rollout

Content negotiation, not a flag day — the client and worker deploy
independently (`memory/feedback_cells_api_deploy_skew.md`):

1. Worker: `?format=cols` returns D; default stays the current row format.
   Same query paths, new serializer — the D1/parquet code is untouched.
   **Done** (with `fields=`), deployed to the dev worker; heatmap C is the
   first client.
2. Client: send `format=cols`, decode into the existing `CellRow[]` shape at
   the fetch boundary (`useCellsApi.ensureShardsCached`) so nothing downstream
   changes. Keep the row decoder for a release.
3. Once the client is deployed everywhere, flip the worker default and delete
   the row serializer.

Worth measuring at step 2: decode time. The row format's cost isn't only bytes
— `JSON.parse` of 5.97 MB is milliseconds the map spends not painting — and
columnar parse should be strictly cheaper (fewer objects allocated), but that
needs a number, not an assumption.

## Already landed (2026-08-22), and why it isn't enough

- The client's label gate was `res < 12` — an **H3 resolution** compared
  against S2 levels after the migration, so it never fired. Now
  `res < LABELS_MIN_S2_LEVEL` (18, ~30 m: the S2 analog of the original
  hover-scale intent).
- `labels=nums` used to disqualify the D1 fast path, so the one byte-saving
  lever cost 3-20× in latency (statewide-mid l14: 945 ms full → 10.5 s nums;
  Hudson l17: 3.0 s → 21.9 s). The D1 scan now serves `nums` by selecting
  fewer columns — measured 262 ms vs 775 ms full at l13.
- New `label_max_cells` (default 20k) degrades `full` → `nums` server-side and
  reports the mode served, bounding the label tax for views that pass the
  client gate but still return tens of thousands of cells.

Together those roughly halve the wide-zoom payload (l14 statewide: 5.97 MB →
3.00 MB body, 580 KB → 291 KB wire, *and* 1150 ms → 629 ms). The remaining
3.00 MB is the counts, and only a format change touches it.

## Related

- `specs/labels-on-demand.md` — hover-fetch + background fill, which is how
  labels come *back* everywhere once they're off the critical path.
- `specs/autores-bins-budget.md` — where `BINS_BUDGET` comes from. A byte
  budget alongside the bins budget is the natural follow-up: the preference
  corpus says statewide wants *more* bins (`njdot tune fit`), which is only
  affordable once a bin costs ~4 gz B instead of ~16.
- `specs/tune-preference-learning.md` — the corpus that surfaced this.

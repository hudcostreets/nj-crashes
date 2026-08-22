# Compact wire format for `/v1/cells`

Status: draft, not started. Measured 2026-08-22 against the deployed worker
(`tmp/audit-cells.py`, `tmp/audit-encoding.py`).

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

## Rollout

Content negotiation, not a flag day — the client and worker deploy
independently (`memory/feedback_cells_api_deploy_skew.md`):

1. Worker: `?format=cols` returns D; default stays the current row format.
   Same query paths, new serializer — the D1/parquet code is untouched.
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

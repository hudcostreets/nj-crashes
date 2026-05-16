# Cells-API: extend coverage to 2024-25 via AASHTO supplemented data

**Run on EC2 (`e`)** — local MacBook is low on disk. The rebuild needs
~6 GB during pipeline + ~30 min upload.

## Why

The cells-api pyramid is built from `njdot/data/crashes.parquet`,
which only goes to 2023. The homepage year-range dropdown is gated by
the v2 manifest's `year_range: [2001, 2023]` (also derived from that
parquet). Hudson Co.'s `aashto_supplemented_crashes.parquet` already
has 2023-2025 (574 / 648 / 552 fatal crashes per year) and the
homepage chart already uses it for 2023+.

So: rebuild the cells-api pyramid + v2 prebins from a **combined**
source — NJDOT 2001-2022 + AASHTO 2023-2025 — to match the
homepage's authoritative-source policy and surface 2024-25 on the
map.

## Pre-flight

1. Spec branch is rebased onto `h/main` so the `cells_pyramid_combos`
   CLI (`530ecd3f0f2`) and AASHTO `.dvc` pointer are present.
2. `dvx pull njdot/data/aashto_supplemented_crashes.parquet.dvc
   njdot/data/crashes.parquet.dvc` to ensure both sources are local.
3. `uv sync` (needs `pandas`, `pyarrow`, `h3`, `scipy`, `geopandas`,
   `shapely` — `scipy` is the easy-to-miss one).
4. AWS credentials: profile `cf` (for R2) + default (for AWS S3
   `nj-crashes` mirror) both configured.

## Step 1 — Add `load_crashes_with_aashto()` helper

`export_map_v2` already merges AASHTO inline (~15 lines: column-projected
read of `crashes.parquet` + `aashto_supplemented_crashes.parquet`, drop
per-table years that AASHTO covers, concat). `cells_raw` reads only
`crashes.parquet` and so misses 2024-25 entirely.

Rather than duplicating the merge in `cells_raw` (drift risk) or threading
a `--source` flag (manual ceremony every refresh, scratch parquet in
`tmp/`), extract the merge into a single-source-of-truth helper:

```python
# njdot/load.py
def load_crashes_with_aashto(columns: Optional[list[str]] = None) -> pd.DataFrame:
    """NJDOT 2001-2022 + AASHTO 2023+ (when present), columns normalized to NJDOT.

    AASHTO supersedes per-table for any year it covers — the per-table 2023
    fatal-flag bug surfaced this need. Change this function to change the
    policy in every caller.
    """
```

Both `export_map_v2` and `cells_raw` then become a one-line
`load_crashes_with_aashto(columns=MAP_INPUT_COLS)`. The daily pipeline
auto-picks-up AASHTO refreshes — no manual rebuilds gated on a scratch
parquet existing.

## Step 2 — Free local cells dir (optional)

On EC2 disk is fine — skip.

## Step 3 — Rebuild cells-api pyramid

```bash
env -u PYTHONPATH njdot compute cells raw -f

env -u PYTHONPATH njdot compute cells pyramid-combos \
    -c 's2:r6,s3:r6,s2:r7,s3:r7,s4:r7,s3:r8,s4:r8,s5:r8,s4:r9,s5:r9,s6:r9,s5:r10,s6:r10,s7:r10,s6:r11,s7:r11,s8:r11,s7:r12,s8:r12,s9:r12,s8:r13,s9:r13,s9:r14' \
    -f

env -u PYTHONPATH njdot compute cells manifest
```

The combo list above mirrors the 23 currently-published combos so the
new pyramid is a drop-in replacement.

Expected manifest year_range after this step: `[2001, 2025]`.

## Step 4 — Push cells to R2 (additive)

```bash
env -u PYTHONPATH njdot compute cells push --no-delete
```

This is the slow step — ~160k files, ~30 min on a fast connection.
`--no-delete` so any R2 keys we don't have locally aren't dropped
(defensive; we expect the file set to be identical, but be safe).

## Step 5 — Rebuild v2 prebins

```bash
env -u PYTHONPATH njdot compute export_map_v2
env -u PYTHONPATH njdot compute export_hex_sld
env -u PYTHONPATH njdot compute gen_county_outlines
env -u PYTHONPATH njdot compute gen_muni_outlines
```

(Same set the `www/public/njdot/map.dvc` stage runs; touching that
.dvc directly with `dvx run -f` will update everything in one shot
and bump its md5. `export_map_v2` already merges AASHTO inline — no
flag plumbing needed; the loader change in Step 1 means the same
auto-merge now happens at the cells_raw stage too.)

## Step 6 — Sync v2 prebins to AWS S3

```bash
cd www/public/njdot && aws s3 sync map s3://nj-crashes/njdot/map --delete
```

This is the existing `map_sync.dvc` cmd. Use `--delete` here because
this *is* the canonical mirror (unlike R2, where some legacy keys
might still be in use). After sync:

- Prod homepage dropdown should now show 2024 + 2025 as options
- Hovering hexes in 2024-25 should show road names (via the same
  `hex-sld.parquet` walk-up that just landed)

## Step 7 — Bump cells-api worker (if not already)

The `crashes-cells-api` Cloudflare Worker was deployed today
(commit `a53a3000`) with multi-resolution combo routing. No code
changes needed; it reads the manifest from R2 each request and
discovers new combos automatically. Verify:

```bash
curl -s https://crashes-cells-api.ryan-0dc.workers.dev/v1/manifest \
  | python3 -c "import sys,json; m=json.load(sys.stdin); print(m.get('year_range'))"
# Expected: [2001, 2025]
```

## Step 8 — Verify on prod

After the deploy, open `https://crashes.hudcostreets.org/` and confirm:

1. **Dropdown** end-year goes to 2025
2. With `?y=2024-2025`, the map renders fatal+injury data (552 + 648
   fatals across NJ, ~120k injury crashes/year)
3. **Tooltip** at any zoom level shows a road name (the
   `useHexSld` walk-up landed in `4fa452977c2`)

## Step 9 — Update this spec + commit

Move this spec to `specs/done/cells-api-2024-25-data.md` alongside
the data + CLI commits. Note any deltas from the plan in a
"Notes" section if the EC2 run hit anything unexpected.

## Related context

- Pyramid + worker architecture: `specs/cfw-cells-pipeline.md` +
  `specs/cfw-cells-api.md`
- AASHTO supplement provenance: `specs/done/cms-sm-2025-04-aashto-supplement.md`
  (and the `aashto_supplemented_crashes.parquet.dvc` stage)
- Homepage 2023-source switch (the policy this rebuild aligns with):
  commit `1b657e6b` ("Home page: AASHTO data-source link, map default 2019-2025")

## Out of scope (follow-ups for the same session if time allows)

- The dropdown is currently gated by `v2Manifest.year_range`; logically
  it should follow the cells-api manifest (the actual data source). A
  follow-up could rewire `CrashMapSection`'s `[y0min, y1max]` to read
  the cells-api manifest, removing the dual-source-of-truth.
- `useHexSld` 404 currently disables the lookup for the session;
  `4fa452977c2` added a `.catch` retry hook but a more robust fix
  would let the tooltip still render with just muni/county when the
  parquet is missing.
- Wire `cells-api` worker deploy + `map_sync.dvc` into the daily
  workflow so future data refreshes propagate without manual steps.

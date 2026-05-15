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

1. `git pull h main` (the rebuild source `cells_pyramid_combos` CLI is
   on main as of `530ecd3` and assumes the 23-combo layout that was
   pushed in this round).
2. `dvx pull njdot/data/aashto_supplemented_crashes.parquet.dvc
   njdot/data/crashes.parquet.dvc` to ensure both sources are local.
3. Verify pyproject deps installed: `uv sync` (need `pandas`,
   `pyarrow`, `h3`, `scipy`, `geopandas`, `shapely`).
4. AWS credentials: profile `cf` (for R2) + default (for AWS S3
   `nj-crashes` mirror) both configured.

## Step 1 — Build the combined source parquet

NJDOT and AASHTO schemas are column-compatible (the 20 columns the
cells pipeline needs all exist in both). Glue NJDOT 2001-2022 to
AASHTO 2023-2025:

```python
# scratch script — run from repo root, writes to a local temp path.
import pandas as pd
NJDOT = "njdot/data/crashes.parquet"
AASHTO = "njdot/data/aashto_supplemented_crashes.parquet"
OUT = "tmp/crashes_combined.parquet"

n = pd.read_parquet(NJDOT)
a = pd.read_parquet(AASHTO)
n_old = n[n["year"] <= 2022]
a_new = a[a["year"] >= 2023]
# Drop AASHTO-only columns so the resulting frame matches the NJDOT
# schema cells.py expects.
a_new = a_new[[c for c in n.columns if c in a_new.columns]]
combined = pd.concat([n_old, a_new], ignore_index=True)
print(f"NJDOT 2001-2022: {len(n_old):,} rows")
print(f"AASHTO 2023-2025: {len(a_new):,} rows")
print(f"Combined: {len(combined):,} rows, years {combined['year'].min()}-{combined['year'].max()}")
combined.to_parquet(OUT, compression="zstd", index=False)
```

Expected: combined ≈ 6.6M (NJDOT old) + 775k (AASHTO new) ≈ 7.4M rows
spanning `year` 2001-2025.

## Step 2 — CLI flag for source parquet

The current `njdot compute cells raw` and `njdot compute export_map_v2`
both hard-code `CRASHES_PQT = "njdot/data/crashes.parquet"`. Add a
`--source/-S` option to both that defaults to `CRASHES_PQT`. Touches:

- `njdot/cli/cells.py`: `cells_raw` — accept `source: str` arg, use
  in `pd.read_parquet(source)` instead of `CRASHES_PQT`.
- `njdot/cli/export_map_data.py`: similar.

Commit message:
> `njdot compute cells raw` / `export_map_v2`: accept `--source` flag
>
> Default stays `njdot/data/crashes.parquet` (the NJDOT-only canonical).
> A combined NJDOT-2001-2022 + AASHTO-2023-2025 parquet can now be
> passed in for the cells-api + v2 prebin rebuild that surfaces 2024-25
> on the homepage map.

## Step 3 — Free local cells dir (optional)

On EC2 disk is fine — skip.

## Step 4 — Rebuild cells-api pyramid

```bash
env -u PYTHONPATH njdot compute cells raw -f \
    --source tmp/crashes_combined.parquet

env -u PYTHONPATH njdot compute cells pyramid-combos \
    -c 's2:r6,s3:r6,s2:r7,s3:r7,s4:r7,s3:r8,s4:r8,s5:r8,s4:r9,s5:r9,s6:r9,s5:r10,s6:r10,s7:r10,s6:r11,s7:r11,s8:r11,s7:r12,s8:r12,s9:r12,s8:r13,s9:r13,s9:r14' \
    -f

env -u PYTHONPATH njdot compute cells manifest
```

The combo list above mirrors the 23 currently-published combos so the
new pyramid is a drop-in replacement.

Expected manifest year_range after step 4: `[2001, 2025]`.

## Step 5 — Push cells to R2 (additive)

```bash
env -u PYTHONPATH njdot compute cells push --no-delete
```

This is the slow step — ~160k files, ~30 min on a fast connection.
`--no-delete` so any R2 keys we don't have locally aren't dropped
(defensive; we expect the file set to be identical, but be safe).

## Step 6 — Rebuild v2 prebins

```bash
env -u PYTHONPATH njdot compute export_map_v2 \
    --source tmp/crashes_combined.parquet
env -u PYTHONPATH njdot compute export_hex_sld
env -u PYTHONPATH njdot compute gen_county_outlines
env -u PYTHONPATH njdot compute gen_muni_outlines
```

(Same set the `www/public/njdot/map.dvc` stage runs; touching that
.dvc directly with `dvx run -f` will update everything in one shot
and bump its md5.)

## Step 7 — Sync v2 prebins to AWS S3

```bash
cd www/public/njdot && aws s3 sync map s3://nj-crashes/njdot/map --delete
```

This is the existing `map_sync.dvc` cmd. Use `--delete` here because
this *is* the canonical mirror (unlike R2, where some legacy keys
might still be in use). After sync:

- Prod homepage dropdown should now show 2024 + 2025 as options
- Hovering hexes in 2024-25 should show road names (via the same
  `hex-sld.parquet` walk-up that just landed)

## Step 8 — Bump cells-api worker (if not already)

The `crashes-cells-api` Cloudflare Worker was deployed today
(commit `a53a3000`) with multi-resolution combo routing. No code
changes needed; it reads the manifest from R2 each request and
discovers new combos automatically. Verify:

```bash
curl -s https://crashes-cells-api.ryan-0dc.workers.dev/v1/manifest \
  | python3 -c "import sys,json; m=json.load(sys.stdin); print(m.get('year_range'))"
# Expected: [2001, 2025]
```

## Step 9 — Verify on prod

After the deploy, open `https://crashes.hudcostreets.org/` and confirm:

1. **Dropdown** end-year goes to 2025
2. With `?y=2024-2025`, the map renders fatal+injury data (552 + 648
   fatals across NJ, ~120k injury crashes/year)
3. **Tooltip** at any zoom level shows a road name (the
   `useHexSld` walk-up landed in `4fa452977c2`)

## Step 10 — Update this spec + commit

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

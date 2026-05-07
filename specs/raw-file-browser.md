# Raw NJDOT file browser

> **MVP target**: webinar-ready link to email DOT-BTDS, showing what raw
> NJDOT bulk data used to look like (separate `Accidents` / `Drivers` /
> `Occupants` / `Pedestrians` / `Vehicles` tables), so they understand
> why a single denormalized dashboard `Crash.csv` is a regression.

## Goal

Stand up a thin file-browser at `/raw/*` that:

1. Lists directories.
2. Renders `.zip` (entry list; click an entry → renders its content).
3. Renders `.txt` (paginated, fixed-width-aware).
4. Renders `.pqt` / `.parquet` (paginated table via `hyparquet`).

Data path: **R2 only**, hand-curated mirror. No DVX integration, no Git
or GitHub-API integration. The point is the demo, not the plumbing.

## Storage model

A new R2 prefix `raw/` on the existing `nj-crashes` bucket, mirroring
the repo's path layout for the files we care about:

```
raw/njdot/data/2022/NewJersey2022Accidents.zip
raw/njdot/data/2022/NewJersey2022Accidents.pqt
raw/njdot/data/2022/NewJersey2022Drivers.zip
…
raw/njdot/data/2023/Atlantic2023Accidents.zip   (per-county)
raw/njdot/data/2023/Atlantic2023Drivers.zip
…
```

URL ↔ R2 key is 1:1 under `raw/`:

| URL | R2 key |
|-----|--------|
| `/raw/njdot/data/2023/` | (list with `prefix=raw/njdot/data/2023/&delimiter=/`) |
| `/raw/njdot/data/2023/NewJersey2023Drivers.zip` | `raw/njdot/data/2023/NewJersey2023Drivers.zip` |
| `/raw/.../X.zip!/X.txt` | X.zip + entry path after `!/` (pkzip-URI convention) |
| `/raw/njdot/data/2022/NewJersey2022Drivers.pqt` | `raw/njdot/data/2022/NewJersey2022Drivers.pqt` |

### Why R2, not DVX

- DVX cache lives in S3 only today. CFW→S3 = $0.09/GB egress + ~50ms
  latency + signed-URL hassle.
- CFW→R2 = in-network, sub-ms, free egress, edge-cache automatic.
- The DOT bulk dumps change rarely or never, so a one-shot manual
  mirror has no maintenance cost. We don't need provenance through
  DVX/Git for *this* surface — it's a static demo of frozen historical
  data.
- If we ever want this to expose live DVX-tracked outputs later, an
  `r2` DVX remote can be added separately. Out of scope for MVP.

### Initial upload

`raw/` is a sibling prefix to `cells/` on the same `nj-crashes` bucket.
One-shot mirror of just enough for the demo:

```bash
# 2022 statewide files (5 zips + 5 pqt + 5 txt)
for f in njdot/data/2022/NewJersey2022*.{zip,pqt,txt}; do
  pnpm wrangler r2 object put "nj-crashes/raw/${f#njdot/data/}" --file "$f"
done
# 2023 per-county files (105 zips: 21 counties × 5 tables)
for f in njdot/data/2023/*.zip; do
  pnpm wrangler r2 object put "nj-crashes/raw/njdot/data/2023/$(basename "$f")" --file "$f"
done
```

(Or rclone `r2:nj-crashes/raw/` if the per-file `wrangler put` is too
slow; rclone supports the R2 S3-compat endpoint with a token.)

Total payload ≈ 200–400 MB. One-time.

## Architecture

```
[browser]
   GET /raw/njdot/data/2023/                       ← dir listing
   GET /raw/njdot/data/2023/NewJersey2023Drivers.zip
   GET /raw/njdot/.../X.zip!/X.txt?page=3          ← zip entry, paginated
   ▼
[Vite/React app: src/routes/RawFileBrowser.tsx]
   tanstack/react-query for cache, Range slicing for .txt,
   hyparquet streaming for .pqt
   ▼
[CFW: cells-api (extend, don't fork)]
   GET /v1/raw/list?prefix=…
   GET /v1/raw/get?path=…              (Range-passthrough)
   GET /v1/raw/zip-entries?path=…
   GET /v1/raw/zip-entry?path=…&entry=…&offset=…&csize=…&method=…
   ▼
[R2: nj-crashes/raw/…]
```

### CFW endpoints

Add to `cells-api` (R2 binding + CORS already wired — no new worker).

```
GET /v1/raw/list?prefix=<p>&cursor=<c>
  → { entries: [{ key, size, lastModified, isDir }], cursor?: string }
  Wraps R2.list({ prefix, delimiter: "/", cursor }). isDir = was rolled
  up by the delimiter. Validates prefix begins with "raw/" (security:
  no peeking at "cells/").

GET /v1/raw/get?path=<k>
  → streams the R2 object body, forwarding Range / If-None-Match.
  Content-Type from extension; .pqt → octet-stream. Cache-Control
  public, max-age=86400 (R2 keys under raw/ are immutable).

GET /v1/raw/zip-entries?path=<k>
  → { entries: [{ name, size, compressedSize, offset, method }] }
  Reads the zip's End-of-Central-Directory by Range-fetching the last
  64 KB, parses with fflate (CFW supports it). Cached at the edge
  alongside the underlying object's ETag.

GET /v1/raw/zip-entry?path=<k>&entry=<n>&offset=<o>&csize=<c>&method=<m>
  → streams the decompressed entry. Range-fetch [offset, offset+csize)
  on the underlying zip, pipe through fflate inflate, return as a
  stream. Range over the *decompressed* output is supported by skipping
  inflate output bytes (slow but acceptable for demo).
```

All `Cache-Control: public, max-age=86400, immutable`. R2 ETag is
forwarded for revalidation.

### Frontend

New route in `www/src/App.tsx`:
```tsx
<Route path="/raw/*" element={<RawFileBrowser />} />
```

`RawFileBrowser` parses the splat:

- Trailing `/` → call `/v1/raw/list`, render `<DirListing>`.
- `<path>.zip` → call `/v1/raw/zip-entries`, render `<ZipEntryList>`.
- `<path>.zip!/<entry>` → render entry by *entry*'s extension (NJDOT
  zips contain a single .txt, but be general).
- `<path>.txt` → `<TextViewer>` (Range-paginated).
- `<path>.pqt` / `.parquet` → `<ParquetTable>` via hyparquet.
- Else → "preview not supported, [download]" fallback.

Always: breadcrumb (`raw / njdot / data / 2023 / NewJersey2023Drivers.zip /
NewJersey2023Drivers.txt`).

#### `<TextViewer>`
- Range requests in 1 MB chunks (configurable). Show row count estimate
  from file_size ÷ avg-line-length sampled from first 4 KB.
- Page size 500 lines. Jump-to-page / jump-to-byte. No column awareness
  in MVP — render as plain monospace text.

#### `<ParquetTable>`
- Reuse hyparquet (already a dep, used by `useParquet.ts`).
- Show schema first, then lazy-load row groups on scroll. Cap visible
  to 1000 rows (DOM is the bottleneck).

#### `<DirListing>`
- Plain table: name / size / modified.
- Dirs first, then files. Click → navigate.

## Implementation order

1. **Worker** (~half day):
   1. `cells-api/src/raw.ts` with handlers `list`, `get`,
      `zip-entries`, `zip-entry`.
   2. Wire into `index.ts` router. Validate `prefix`/`path` start with
      `raw/`.
   3. Local test: `wrangler dev --remote`, hit endpoints with curl.
2. **Mirror data to R2** (~30 min):
   1. Script the `wrangler put` loop for 2022 statewide + 2023
      per-county.
   2. Verify with `wrangler r2 object get` on a couple keys.
3. **Frontend** (~half day):
   1. `RawFileBrowser.tsx` with splat parsing + breadcrumb.
   2. `<DirListing>`, `<ZipEntryList>`, `<TextViewer>`,
      `<ParquetTable>`.
   3. Dark-mode parity with existing pages.
4. **Polish for demo** (~1 hour):
   1. `/raw/njdot/data/` index with one paragraph explaining what each
      table is and linking to a representative row.
   2. CIC end-to-end: zip → entry → 5 pages of txt → parquet view.
   3. Deploy worker + Pages.

## Webinar / email demo script

1. Open `/raw/njdot/data/2023/`.
2. "This is the per-county breakdown — Atlantic, Bergen, …, Warren."
3. Click `Atlantic2023Drivers.zip`.
4. "One fixed-width text file per zip — driver-level rows tied back to
   crashes by case key." Click the entry.
5. Page through. Point at the column structure.
6. Back to `/raw/njdot/data/2022/`, open
   `NewJersey2022Drivers.pqt`. "Same data, parquet for programmatic
   use; here's the schema." Show schema panel.
7. Pivot to current dashboard `Crash.csv`: "this is a single
   denormalized table — every row is a person × crash combination,
   you've lost the structure that the prior bulk dumps had."
8. "What I want from your team is the original C/D/O/P/V tables
   continued forward through 2024+."

## Out of scope (mention to DOT in the email as obvious next steps)

- Full-text / grep across files
- Side-by-side compare across years
- Schema diff between bulk-dump format and dashboard `Crash.csv`
- Live updates (DVX/R2 sync) — not needed for frozen historical data

# Adopt `dvx import-url --git` for NJSP XML/PDF fetching

## Status (2026-04-14)

- **Phase 1a (done)** — `9e3be812575`. Recreated `data/FAUQStats{2024,2025,2026}.xml.dvc` via `dvx import-url --git --user-agent ...` with full provenance (`deps.checksum` ETag, `deps.size`, `deps.mtime`, `deps.user_agent`, `meta.import.fetched`). Older years (2008-2023) left as-is — NJSP doesn't update those.
- **Phase 1b (done)** — `2bfcda1b33c`. `refresh_data.update_xml_dvc` now writes the deps-side fields after each daily fetch (from `ETag` + `Last-Modified` headers), keeping the dvcs canonical-shape so `dvx update` remains a working fallback.
- **Phase 1c (blocked)** — replacing `refresh_data` entirely with `dvx update <dvcs>`. Blocked on the upstream gaps below.

## Background

Several NJSP pipeline stages fetch data from external HTTPS URLs:
- `refresh_data`: fetches `FAUQStats*.xml` from `nj.gov/njsp/info/fatalacc/`
- `refresh_summaries`: fetches `ptccr_*.pdf` from `nj.gov/njsp/info/fatalacc/pdf/`

Currently these are modeled as side-effect stages with custom fetch logic in Python. The stages handle downloading, diffing against git-tracked copies, and reverting if unchanged.

## Existing DVX support

DVX already has `dvx import-url --git` (`src/dvx/git_import.py`) which:
- Downloads a file from an HTTPS URL
- Commits it to git (not DVX cache) — preserving the current pattern of git-tracked XMLs
- Creates a `.dvc` file with URL provenance: source URL, ETag, Last-Modified, MD5, download date
- `dvx update <file>.dvc` re-checks via HEAD request, re-downloads if ETag changed
- `meta.git_tracked: true` flag distinguishes these from DVC-cached imports

Example `.dvc` file:
```yaml
deps:
- path: https://nj.gov/njsp/info/fatalacc/FAUQStats2026.xml
  checksum: '"abc123"'
  size: 203456
  mtime: 2026-04-11T10:00:00+00:00
outs:
- md5: 7471d4ecfbcd084edeb18d391e987458
  size: 203456
  hash: md5
  path: FAUQStats2026.xml
meta:
  git_tracked: true
  import:
    fetched: '2026-04-11'
```

## Migration plan

### Phase 1: Create `.dvc` files for existing XMLs

For each `FAUQStats*.xml` already in the repo:
```bash
dvx import-url --git https://nj.gov/njsp/info/fatalacc/FAUQStats2026.xml -o data/FAUQStats2026.xml
```

This is non-disruptive — the XMLs stay git-tracked as today, we just add `.dvc` provenance alongside.

### Phase 2: Replace `refresh_data` with `dvx update`

The custom Python fetch logic in `njsp/cli/refresh_data.py` would be replaced by:
```bash
dvx update data/FAUQStats*.xml.dvc
```

Each `.dvc` could have `fetch: { schedule: daily }` so `dvx run` knows to check them.

### Phase 3: Same for summary PDFs

Apply the same pattern to `ptccr_*.pdf` files fetched by `refresh_summaries`.

## Gaps / upstream work needed

- **Glob-based update**: `dvx update` currently handles one `.dvc` at a time. Need to support `dvx update data/FAUQStats*.xml.dvc` or `dvx run` triggering updates for all due fetch-scheduled imports.
- **Year-aware fetching**: `refresh_data` currently only fetches recent years (current + previous). DVX would need a way to mark older years' `.dvc` files as "don't re-fetch" (maybe `fetch: { schedule: manual }` or just no `fetch` block).
- **Timeout handling**: `refresh_data` has a 30s timeout for NJSP requests. DVX's `_download()` in `git_import.py` uses `urlopen` with no timeout — may need a configurable timeout.
- **Commit grouping**: Currently `refresh_data` fetches all XMLs and makes one "Refresh NJSP data" commit. With per-XML `.dvc` files, DVX would need to group updates into a single commit (or we accept per-XML commits).
- **Crash-log SHA references**: `crash_log compute` walks git history to find which commit introduced each crash. This already works with git-tracked XMLs and would continue to work — the XMLs stay in git.

## Non-goals

- Don't move XMLs out of git into DVX cache. They're small (~2MB each), the git history is used by `crash_log compute`, and other code reads XMLs at historical commits.

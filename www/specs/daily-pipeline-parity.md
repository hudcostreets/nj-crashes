# Daily pipeline: full parity with old daily.yml

## Old pipeline steps (from pre-DVX daily.yml)

1. **Refresh data** → `njsp -cc refresh_data --s3`
   - Fetches FAUQStats XML files from NJSP website
   - Outputs: `data/FAUQStats{2024,2025,2026}.xml`

2. **Harmonize county/muni codes** → `njsp -cc harmonize_muni_codes`
   - Reconciles codes across NJDOT/NJSP/NJGIN
   - Outputs: `njsp/data/muni_codes.parquet`, `www/public/njdot/cc2mc2mn.json`

3. **Update parquets** → `njsp -cc update_pqts --s3`
   - Parses XMLs → `njsp/data/crashes.parquet` + `www/public/njsp/crashes.db`
   - Also updates `www/public/njsp/rundate.json`
   - **MISSING from DVX pipeline**

4. **Update crash log** → `njsp crash_log compute --s3 -v`
   - Updates crash-log parquet in S3
   - **MISSING from DVX pipeline**

5. **Refresh annual summaries** → `njsp -cc refresh_summaries`
   - Updates annual report data
   - Depends on: refresh (needs latest year data)

6. **Fetch ≈1yr of history** → `git fetch --shallow-since`
   - Deep-fetches git history for Slack posting
   - **MISSING from DVX pipeline**

7. **Update YTD / ROY projections** → `njsp -cc update_projections`
   - Updates `www/public/njsp/projected.csv`
   - Depends on: update_pqts (needs crashes.parquet)

8. **Post to Slack** → `njsp slack sync -r $SHA`
   - Posts crash updates to #crash-bot Slack channel
   - Depends on: crash_log, refresh SHA
   - **MISSING from DVX pipeline**

9. **Rebuild www** → CF Pages deploy
   - Depends on: csvs, projections (www/public changes)

## Dependency chain

```
refresh (XMLs)
  → update_pqts (crashes.parquet, crashes.db, rundate.json)
    → harmonize (muni_codes.parquet)
    → update_www_data (CSVs in www/public/njsp/)
    → update_projections (projected.csv)
    → crash_log (S3)
      → slack post (side-effect)
  → refresh_summaries (annual data)
  → www deploy (CF Pages, side-effect)
  → d1 import (D1, side-effect — only when .db files change)
```

## What's needed

### New .dvc stages

- `njsp/data/update_pqts.dvc` — cmd: `njsp update_pqts --s3`, deps: refresh XMLs
- `njsp/data/crash_log.dvc` — cmd: `njsp crash_log compute --s3 -v`, deps: crashes.parquet
- `njsp/data/slack_post.dvc` — cmd: `njsp slack sync`, deps: crash_log, side-effect

### Fixes to existing stages

- `harmonize.dvc` — dep should be on crashes.parquet (produced by update_pqts)
- `csvs.dvc` — dep on crashes.parquet (correct, but update_pqts must run first)
- `projections.dvc` — dep on crashes.parquet (same)
- All deps need to actually be checked against current file state (not just .dvc hash)

### GHA step for git history fetch

Not a DVX stage — just a GHA step before the Slack post step:
```yaml
- name: "Fetch ≈1yr of git history"
  run: |
    since="$(date --date="$(date +%Y-%m-%d) -375 day" +%Y-%m-%d)"
    git fetch --shallow-since "$since" origin main
```

### GHA step ordering (matching old pipeline)

1. Pull DVC deps from S3
2. Refresh NJSP data
3. Update parquets
4. Harmonize county/muni codes
5. Update crash log
6. Refresh annual summaries
7. Fetch ≈1yr of git history
8. Update NJSP projections
9. Update www CSVs
10. Post to Slack
11. Deploy www to CF Pages
12. Import databases to D1 (only if .db changed)

## Other issues to fix

- **Empty commits**: DVX commits `.dvc` metadata (last_run) even when no data changed. Should skip commit or use descriptive message.
- **Stage logs**: DVX output not visible in GHA — need `2>&1` or DVX verbose mode
- **D1 import**: separate from daily NJSP pipeline (only needed when NJDOT data updates)

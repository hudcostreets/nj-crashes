# Harmonization Review UI

New route `/match-review` in the www app for inspecting and curating the NJSP-NJDOT fatal-crash matching pipeline.

## Data sources

- `njsp/data/njsp_njdot_match.parquet` — 8428 matched pairs with `pass` column (1-8)
- `njsp/data/njsp_njdot_candidates.csv` — 1290 scored candidate pairs for unmatched residuals
- `njsp/data/njsp_njdot_manual_matches.csv` — human-curated accept/reject decisions (currently header-only)
- NJSP + NJDOT crash detail columns (date, cc, mc, case, tk, route, mp, location/road) for display

## Data loading

Pre-generate a single `match-review.json` (or split into `match-passes.json` + `candidates.json`) at build time via a Python script (`njsp/cli/export_match_review.py`), placed in `www/public/`. This avoids shipping parquet files to the browser and keeps the page simple. Include:

- **passes**: array of `{ pass, description, count, pairs }` where each pair has NJSP + NJDOT columns side-by-side (date, cc, mc, case, tk, route, mp, location hint)
- **candidates**: array from the CSV, already sorted by score descending
- **manual**: current contents of `njsp_njdot_manual_matches.csv` (accepted/rejected IDs)

Regenerate via `njsp export_match_review` (add to CLI). Run as part of `csvs.dvc` or a separate step.

## Route and component

Add `<Route path="/match-review" element={<MatchReview />} />` in `App.tsx`. New file: `www/src/routes/MatchReview.tsx`.

## Layout

### Header
Title "NJSP-NJDOT Match Review", summary stats: total NJSP fatal crashes in scope, total NJDOT fatal crashes, matched count, residual counts per side.

### Pass tabs
Horizontal tab bar with passes 1-8. Each tab label: "Pass N (count)". Active tab shows:

- **Description**: one-line criteria summary (from the docstrings in `match_njdot.py`)
- **Table**: paginated (50 rows/page), columns:

| NJSP Date | NJSP CC | NJSP MC | NJSP Case | NJSP TK | NJDOT Date | NJDOT CC | NJDOT MC | NJDOT Case | NJDOT TK | Route | MP |
|-----------|---------|---------|-----------|---------|------------|----------|----------|------------|----------|-------|----|

Pass descriptions (from `match_njdot.py`):
1. Exact `(date, cc, mc)` with equal row count + tk sum
2. Same `(date, cc)`, different mc — route+mp agreement
3. Same date, cross-county — route+mp agreement
4. Date +/-1 day — route+mp agreement
5. Same `(date, cc, tk)`, time-of-day within +/-3 hours
6. Same `(date, cc, tk, pk)` — pedestrians-killed decomposition
7. Route+mp agree, tk disagrees (within 2)
8. Same `(date, cc)`, street-name fuzzy match, tk within 2

### Candidates section
Below pass tabs. Shows unmatched residuals with their best candidate matches, sorted by score descending. Table columns:

| Side | Ref Date | Ref CC | Ref MC | Ref Case | Ref TK | Score | Signals | Cand Date | Cand CC | Cand MC | Cand Case | Cand TK | Action |
|------|----------|--------|--------|----------|--------|-------|---------|-----------|---------|---------|-----------|---------|--------|

- Score badge: green (>=100), yellow (50-99), gray (<50)
- Signals column: comma-separated tags like `same-date`, `route`, `mp`
- **Action column**: Accept / Reject buttons per row

### Score filter
Slider or threshold input above the candidates table to filter by minimum score (default: 50). Show count of visible candidates.

## Accept/Reject workflow

Clicking Accept or Reject writes to `localStorage` keyed by `(side, ref_id, rank)`. A "Download CSV" button at the top of the candidates section exports all decisions as a CSV matching the `njsp_njdot_manual_matches.csv` schema:

```
njsp_id,year,cc,mc,case,note
```

Accepted pairs populate the NJDOT PK fields; rejected rows get `note=rejected`. The user downloads this CSV and replaces `njsp/data/njsp_njdot_manual_matches.csv`, then re-runs the matcher.

A badge on the header shows "N pending decisions" with a count of localStorage entries not yet exported.

## Styling

Reuse existing table styles from `www/src/tables/`. Use the project's existing SCSS module pattern. Keep the page minimal — no heavy charting, just tables and tabs.

## Implementation order

1. Python export script (`njsp/cli/export_match_review.py`) + wire into CLI
2. `MatchReview.tsx` with pass tabs + paginated match table (read-only)
3. Candidates table with score filtering
4. Accept/reject buttons + localStorage persistence + CSV export

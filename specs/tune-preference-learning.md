# `/tune/ab` preference stream → learned picker thresholds

## Motivation

Picker tuning by "edit a constant, eyeball one view" silently skews other views (see the `scopedTargetFactor` episode). And the v1 `/tune/ab` flow — Ryan authors a candidate config, the page diffs it against shipped — had the roles backwards: the human shouldn't have to hypothesize configs.

v2 inverts it: the page generates side-by-side comparisons, Ryan only expresses preference, and translating the accumulated "vibes" into picker parameters (thresholds / a decision tree over `{viewport, zoom, bins returned, clip share, …}`) is Claude's offline job.

## Collection (implemented; v3)

- `/tune/ab` samples a view from a deck (statewide / county / muni / street, with per-view zoom jitter), computes the shipped picker's level `prod`, and renders it against an adjacent level (`prod±1`, direction random, sides randomized).
- **Informed voting** (v2.1, replacing the original blind design): each side's corner label shows its level, geom/inscribed/render px, cells, body + wire bytes, and perceived load ms — Ryan: "i'll want to take those metrics into account in some cases."
- Verdicts: `1` left · `2` tie · `3` right · **`4` neither — want finer than both** · **`5` neither — want coarser than both** · `s` skip (not recorded). The directional "neither" verdicts capture sweet-spots outside the shown pair (e.g. statewide-mid where both l12 and l13 read "too griddy"). An optional free-text note rides along with each vote.
- Voting is gated until both sides' cells have loaded, so recorded metrics are real.
- Votes live in the **`tune` D1 database** (`picker_votes` table, schema `cells-api/sql/tune.sql`), served by the cells-api worker: `GET /v1/tune/votes[?limit=&view=]` (public), `POST /v1/tune/votes`, `PATCH /v1/tune/votes/<id>` (both require `Authorization: Bearer $TUNE_TOKEN`). Columns are flat so the corpus is queryable in SQL — analysis is `wrangler d1 execute tune --remote --command "SELECT …"`, not a JSONL parse.
  - Writes **fail closed**: no `TUNE_TOKEN` secret on the worker ⇒ writes refused. The client sends `VITE_TUNE_TOKEN` from the gitignored `www/.env.local`.
  - The `voter` column is the seam for **$oa/auth**: token writes record NULL (the local admin); logged-in voters would record their identity, which is what lets others participate in admin-ish actions like this. (v2 kept votes in a git-tracked JSONL; Ryan: "I definitely don't want a Git-tracked jsonl pretending to be a DB" — it is gone.)
- The current pair is URL-encoded, golfed but readable: **`?v=<deck-slug>&z=<zoom>&l=<level>&r=<level>`** (e.g. `?v=hud&z=11.14&l=18&r=17`). Deck entries carry a stable `slug` so links survive renames/reordering; `z` uses `floatParam`'s string encoding (2 decimals) rather than the default base64 float.
- A **history panel** lists all votes newest-first (chosen side highlighted); choice is editable in place (PATCH stamps `edited_ts`, shown as a `*`), and `open` reloads that row's exact pair.

### Vote wire schema

```json
{
  "id": 1,
  "ts": "2026-08-22T…",
  "editedTs": null,
  "voter": null,
  "view": "Hudson county fit",
  "lat": 40.73, "lon": -74.09, "zoom": 10.93,
  "vp": [1470, 900],
  "scopeKm2": 120,
  "mppx": 33.1,
  "areaPx": 109000,
  "autoTargetPx": 1.04,
  "cfg": { "targetFactor": 0.85, "pickMult": { "20": 0.55, "21": 0.4 } },
  "prod": 17,
  "left":  { "level": 17, "bins": 13300, "bodyBytes": 2300000, "wireBytes": 152000, "ms": 3283 },
  "right": { "level": 16, "bins": 5400,  "bodyBytes": 930000,  "wireBytes": 78000,  "ms": 2555 },
  "choice": "left",
  "chosen": 17,
  "note": ""
}
```

`cfg` snapshots the shipped config at vote time, so rows remain interpretable as `tuning.json` evolves. `chosen: null` ⇔ tie/finer/coarser. `choice ∈ {left, right, tie, finer, coarser}`. `wireBytes: 0` means unknown — it needs the cells-api worker's `Timing-Allow-Origin: *` header (`cells-api/src/index.ts`, deployed 2026-08-22).

## Learning (Claude, offline — the contract)

Periodically (on request, or when the corpus grows meaningfully):

1. Read the corpus: `curl -s $CELLS_API/v1/tune/votes`, or query it directly with `wrangler d1 execute tune --remote --command "SELECT view, choice, count(*) …"` (grouping/filtering in SQL beats pulling every row).
2. Aggregate per feature region. Useful views of the data:
   - **Prod win rate** overall and per deck view: `chosen == prod` vs `chosen == alt` vs tie. High tie/alt-agnostic regions = boundary insensitivity (don't tune there).
   - **Directional pressure**: among decisive votes, does the preferred side skew finer or coarser than prod, and in which `{zoom, areaPx, bins}` regions?
   - **Bins sweet spot**: preferred side's bins count distribution — an empirical bins-per-budgeted-area target, which is the quantity `BINS_BUDGET`/`targetFactor` proxy.
3. Contradictory votes are expected, not noise: model preference as probabilistic near boundaries; only propose changes where directional pressure is consistent (e.g. ≥70% of decisive votes in a region point one way, n ≥ ~10).
4. Translate into the smallest config change that captures the signal — `targetFactor`, per-level `pickMult`, or (if the signal is structural) a picker-shape change proposed as a spec.
5. Validate a candidate before shipping by re-running the same stream with the pair generator set to `shipped-pick vs candidate-pick` (the v1 config-diff mode, resurrectable from git history / a small generator swap).

## Possible extensions

- Real clip polygons instead of hardcoded `scopeKm2` per deck view.
- Reverse/threshold mode (Ryan's other idea): display each level's current min/max zoom ranges across several counties with draggable thresholds and a "this feels right" commit — an extension of `/tune` (which already computes `zoomRangeForLevel`) rather than of the vote stream.
- Deck growth: more counties, off-center views, DF-mode / render-curve A/Bs (would need `renderMode` variants in the pair, recorded in rows).
- Weight recent votes over old ones once configs shift substantially.

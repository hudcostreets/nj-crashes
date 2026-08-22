# `/tune/ab` preference stream → learned picker thresholds

## Motivation

Picker tuning by "edit a constant, eyeball one view" silently skews other views (see the `scopedTargetFactor` episode). And the v1 `/tune/ab` flow — Ryan authors a candidate config, the page diffs it against shipped — had the roles backwards: the human shouldn't have to hypothesize configs.

v2 inverts it: the page generates side-by-side comparisons, Ryan only expresses preference, and translating the accumulated "vibes" into picker parameters (thresholds / a decision tree over `{viewport, zoom, bins returned, clip share, …}`) is Claude's offline job.

## Collection (implemented)

- `/tune/ab` samples a view from a deck (statewide / county / muni / street, with per-view zoom jitter), computes the shipped picker's level `prod`, and renders it against an adjacent level (`prod±1`, direction random, sides randomized). Level numbers are hidden (no anchoring on which is shipped); the per-side **bins count is shown** — data cost is a legitimate preference input.
- Keys: `1` left · `2` tie · `3` right · `s` skip (not recorded). Voting is gated until both sides' cells have loaded, so bins counts in the record are real.
- Each vote POSTs to the dev middleware `/__tune/vote` (in `www/vite.config.ts`), which appends one row to **`www/tune/votes.jsonl`** — git-tracked, accumulating across sessions. `GET /__tune/votes` returns the corpus (page header count).

### Vote-row schema

```json
{
  "ts": "2026-08-21T…",
  "view": "Hudson county fit",
  "lat": 40.73, "lon": -74.09, "zoom": 10.93,
  "vp": [1470, 900],
  "scopeKm2": 120,
  "mppx": 33.1,
  "areaPx": 109000,
  "autoTargetPx": 1.04,
  "cfg": { "targetFactor": 0.85, "pickMult": { "20": 0.55, "21": 0.4 } },
  "prod": 17,
  "left": 17, "right": 16,
  "bins": { "left": 13300, "right": 5400 },
  "choice": "left",
  "chosen": 17
}
```

`cfg` snapshots the shipped config at vote time, so rows remain interpretable as `tuning.json` evolves. `chosen: null` ⇔ tie.

## Learning (Claude, offline — the contract)

Periodically (on request, or when the corpus grows meaningfully):

1. Read `www/tune/votes.jsonl`.
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

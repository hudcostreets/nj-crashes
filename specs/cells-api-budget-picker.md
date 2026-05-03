# Cells API: budget-based picker with client-side coarsening

## Motivation

The current picker uses *theoretical* hex count (`viewport_area / hex_area`)
as its cap. For sparse data, actual rendered hexes are 3–5× less than
theoretical, so the cap forces over-conservative res choices.

Concrete bad case (observed at JC, z=9.23):
- Picker computes r9 theoretical = 117k cells.
- 100k cap → reject r9, pick r8.
- r8 actually renders ~13k hexes.
- r9 *would have* rendered ~26k hexes, well under any sane render budget.

User intuition: "given this viewport, what's the highest hex-level we
can render without exceeding our hex cap (say 30k)?" — i.e. the cap
should be on **rendered hex bins**, not theoretical.

## Approach

Drop the theoretical cap from the picker. Pick `targetRes` purely from
zoom (`pickHexResolutionForPixels`). After fetch, count actual cells; if
over the render budget, **coarsen client-side** via `h3 cellToParent`
until under budget. Render at that effective res.

Why client-side coarsening rather than server-side adaptive res:
- **Lossless**: parent-cell counts = sum of children counts. Coarsening
  in client gives the same result as fetching at the coarser res.
- **No worker change**: server still serves a single res per request,
  caching unchanged. Per-shard URL stability we just landed stays valid.
- **No extra round trip**: server-side adaptive would need either a
  probe call (extra latency) or per-shard mixed-res responses (renderer
  changes — `StackedHexLayer.radius` is currently keyed on a single res).
- **Simple**: `coarsenHexes` already exists in `StackedHexLayer.tsx`,
  used today by the prebin path (`min(planRes, renderRes)`).

Tradeoff (only one): when the picker's `targetRes` is one level finer
than what fits in budget, we transfer slightly more bytes than needed
(fetched finer cells, then coarsened away). Bounded by
`budget × 7` (h3 child-to-parent ratio) ≈ 200k cells worst case, so
≤ a few MB; typically < 500 KB per fetch. Pyramid response payloads
are zstd-compressed, so the bytes-on-wire cost is small. Cached after.

If this worst case ever bites, we can add a *second-pass adaptive
sharpening* later: after fetch, if `total << BUDGET / 2` and a finer
pyramid exists, refetch at `targetRes + 1`. Symmetric to coarsening.

## Changes

### 1. `www/src/map/useCellsApi.ts`

```diff
-const CELLS_CAP = 100000
+/** Render budget — max hex bins shown on screen. Picker no longer
+ *  caps on this; coarsening enforces it post-fetch. */
+const CELLS_BUDGET = 30000
```

Picker becomes a one-liner — no more `pickResForArea`:

```ts
const pick = useMemo(() => {
    if (!filter) return null
    if (filter.resOverride != null) {
        return { res: clamp(filter.resOverride), reason: `override r${filter.resOverride}` }
    }
    const targetRes = pickHexResolutionForPixels(filter.hexPxTarget ?? 1.2, filter.zoom, filter.viewportLat)
    const res = clamp(targetRes)
    return { res, reason: `zoom r${targetRes}` }
}, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride])
```

(The `polygon ∩ viewport` area math drops out entirely — it was only
input to `pickResForArea`. NJ_DATA_BBOX constant becomes dead code; remove.)

Export `CELLS_BUDGET` for the consumer to do post-fetch coarsening.

### 2. `www/src/map/CrashMapSection.tsx`

Compute the effective render set with budget-aware coarsening:

```ts
const renderHexes = useMemo(() => {
    if (result.status !== "ready" || result.dataKind !== "hex") return null
    let hexes = result.data as StackedHex[]
    let res = result.plan?.kind === "hex" ? result.plan.res : getResolution(hexes[0].h3)
    while (hexes.length > CELLS_BUDGET && res > MIN_RES) {
        res--
        hexes = coarsenHexes(hexes, res)
    }
    return { hexes, res }
}, [result])
```

Replace existing `effectiveRes = min(planRes, renderRes)` with the
budget-aware result. `renderRes` (from `pickHexResolutionForPixels`) is
no longer the binding constraint — `result.plan.res` already follows it
via the picker.

### 3. `www/src/map/DebugOverlay.tsx`

When picker res ≠ effective res (coarsening kicked in), surface it:

```
plan
r9 single-file · zoom r9 · coarsened to r8 (budget 30k)
render
hexes: 13.5 k
```

Plan reason wording: `coarsened r{from} → r{to} (budget {N})` when applied.

## Verification

- **Statewide z=9.23**: now picks r9 (was r8). Rendered count ~26k —
  under budget. No coarsening needed.
- **Statewide z=7.5**: picker picks r8 by zoom, fetches r8 (~13k cells),
  no coarsening. (Same outcome as today, different path.)
- **Statewide z=10**: picker picks r10. Fetches r10 (~600k theoretical,
  much less actual, but possibly > 30k for dense urban). Coarsens to r9.
- **Scoped JC z=15**: picker picks r12. Fetches r12 (small response).
  No coarsening. Same as today.
- **Worst case wasted bytes**: statewide z=9.23 fetches r9 (≈26k cells,
  ~800 KB pre-zstd, ~150 KB on wire) — under budget so no coarsening.
  Next zoom-in to z=10 picks r10, fetches r10, sums to ~140k actual,
  coarsens to r9. Wasted bytes: ~5 MB on wire one-time.

## Done when

- [ ] Picker no longer references `CELLS_CAP` or theoretical area math
- [ ] Statewide z=9.23 renders r9 (or r10 if budget permits)
- [ ] No regression at scoped views (HC, JC at deep zoom)
- [ ] Coarsening shows in debug overlay reason when active
- [ ] Manual test: drag at z=9–10 statewide, watch res transitions
- [ ] No new fetches per pan within scope (cache stability preserved)

## Out of scope

- Server-side adaptive res (probe or sharpening) — covered above as
  "if needed later".
- Per-shard mixed-res rendering — would unblock denser shards picking
  finer res independently. Requires renderer changes.
- Lowering MAX_PYRAMID_RES floor — picker still correct at deep zoom.

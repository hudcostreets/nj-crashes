# autoRes: replace hand-tuned zoom→res table with a bins-per-viewport budget

**Owner:** landed on `m3` (macbook owns the client eval infra — `picker.test.ts`,
`/dev/ab`, the `scrns` matrix). This doc carries the measured curve so the budget
ceiling is picked from evidence, not gut.

**Author (spec + measurements):** `e` (cells-api / worker side).

## Problem

At wide zoom the picker serves a data_res far finer than the viewport can resolve.
The reported symptom: zooming toward r9 from the default view, `/cells` took 15–22s.

Root cause is on the **client**, not the worker: `autoHexPxTarget` (`picker.ts`)
maps zoom→res via the hand-tuned `AUTO_RES_BY_ZOOM` table (`z8→r9, z9→r9`). At
those zooms the viewport still spans most of the state, so r9 draws tens of
thousands of sub-pixel bins. The worker then has to range-read all 34 r4 shards,
decode ~550k rows × 11 cols, and serialize a ~13 MB payload — all to render bins
you can't see.

The worker-side row-group `$or` pruning (added in the pyramid consolidation) does
**not** help this regime: at wide zoom the cover's h3-descendant ranges span the
whole in-state keyspace, so no row-group is skipped. Pruning pays off at tight
county/muni zoom, which is the trade the consolidation made deliberately.

## Measured curve (deployed worker, statewide viewport, 2016–2025, `fip`)

Same viewport, varying only `res`:

| data_res | bins/vp | payload | wall (cold→warm) | r-hex edge @ statewide (~328 m/px) |
|---------:|--------:|--------:|:----------------:|:-----------------------------------|
| r6 | 812 | 0.14 MB | 4.6s | ~3 km (~9 px) |
| **r7** | **4.1k** | **0.73 MB** | **5.8 → 3.4s** | **~1.2 km (~3.6 px)** |
| r8 | 20k | 3.4 MB | 10.0s | ~0.46 km (~1.4 px) |
| r9 | 75k | 12.8 MB | 15–17s | ~0.17 km (~0.5 px) |

Latency and payload scale ~linearly with bins/vp, which scales ~7× per res level.
The knee for a statewide viewport is ~r7 (4k bins, 0.73 MB, ~3.4s) — the
"reasonable latency + IO" point. r8 is ~1.4 px hexes; r9 is ~0.5 px (sub-pixel).

**Caveat on "invisible" (from `m3`):** in circle mode `circleRadiusPx` clamps to a
1.2 px minimum, so r9 statewide renders as 75k overlapping 1.2 px dots — the
density signal is essentially the same as r7's 4k dots, but r9 gives marginally
more granular hover targets. So the removed detail is "sub-pixel + overlapping
into the same color," not literally invisible. Judged an acceptable loss at wide
zoom; the sweep (below) is what actually decides.

## The change

Replace the table lookup in `autoHexPxTarget` (`www/src/map/picker.ts`) with a
computed target from a **bins-per-viewport budget** and the viewport pixel area.

Number of H3 hexes filling a viewport ≈ `A_px / hexArea_px`, and a hex of
vertex-diameter `d_px` has area `(3√3/8)·d_px² ≈ 0.65·d_px²`. Solving for the
diameter that yields `budget` hexes:

```
d_px = sqrt(A_px / (0.65 · budget)) ≈ 1.24 · sqrt(A_px / budget)
```

The `1.24` packing constant and the data-fill factor (not every viewport hex has
crashes) both fold into the single swept `budget`. So the edit is:

```ts
// picker.ts — replaces the AUTO_RES_BY_ZOOM dependency in autoHexPxTarget
export function autoHexPxTarget(
    viewportAreaPx: number,     // width_px * height_px of the map canvas
    budget: number,             // target bins/vp (swept param, see below)
): number {
    const diaPx = Math.sqrt(viewportAreaPx / budget)  // packing const folded into budget
    return Math.min(30, Math.max(1.0, diaPx))          // keep existing clamps
}
```

- `pickHexResolutionForPixels` (`CrashMap.tsx`) is unchanged — it already maps a
  diameter target → finest res whose vertex-diameter ≥ target.
- This is deterministic in `(viewportAreaPx, budget)` — no feedback loop, no
  manifest lookup, no per-frame cell-count read.
- `AUTO_RES_BY_ZOOM` (`autoRes.ts`) and the `autoOverrides` plumbing can be
  deleted once the budget is calibrated (keep them until the sweep confirms the
  budget reproduces or beats the hand-tuned feel across the matrix).
- `hexPxTargetFor` / `pickRes` signatures shift from `(viz, zoom, lat, overrides)`
  to threading `viewportAreaPx` + `budget`; `zoom`/`lat` are still needed by
  `pickHexResolutionForPixels` downstream.

Because the picker now targets a constant bins/vp, hex-pixel-size stays roughly
constant across zoom — which is both what looks good and what bounds
latency/IO. The current table overshoots only at the wide end.

## Sweep + eval (do not hard-code a ceiling)

Land the mechanism, then pick `budget` from evidence using the existing infra:

1. Sweep `budget ∈ {3000, 5000, 8000}` (extend if the knee sits outside).
2. Run the `scrns` matrix (13 viewports × 2 viz modes) at each budget; compare
   visual density + hover usability against the current `AUTO_RES_BY_ZOOM` output.
3. Use `/dev/ab` to view current-table vs a candidate budget side-by-side at the
   statewide + mid-zoom (z8) regressions specifically.
4. Re-pin `picker.test.ts` goldens to the chosen budget's `(zoom, viz)→res` map.
5. Record chosen budget + the measured latency/IO at 2–3 representative viewports
   back into this spec before moving to `specs/done/`.

Target acceptance: the z8 / statewide regressions drop from ~15–17s to ~3–4s
with no worse-than-marginal visual density loss.

## Orthogonal worker items (documented, not blockers)

Both live in `cells-api`, owned by `e`. Neither moves the wide-vp tail — that's
decode + serialize bound, and only fewer/coarser bins (this spec) cuts it.

- **Footer cache** (`parquet.ts`, deployed): per-isolate LRU of parsed parquet
  footers. Helps only *across* invocations on a warm isolate re-reading the same
  r4 shard (interactive pan/zoom overlap), and most at deep zoom where footer
  parse is a meaningful fraction of a small decode. **Retained; not a mover for
  anything reported.**
- **`anyCoarse` `<=`→`<`** (`cells.ts`, deployed, Version `81323cb7`): fixes the
  mid-zoom r4-cover band that wrongly fell back to reading all 34 shards. Does
  **not** affect the statewide case (r2 cover ⇒ `anyCoarse` true either way ⇒ all
  34 shards by design).
- **Optional `$or`-prefilter guard** (not deployed): when `anyCoarse` (cover
  coarser than r4, i.e. the ranges can't prune), pass the year-only filter and
  skip the per-row h3-range `$or`. Correctness is preserved by the existing
  `cellInPolygon` clip. Estimated <1% of wide-vp wall (removes ~14M JS
  comparisons out of a 17s decode/serialize), so not worth a churned deploy on
  its own — fold into the next worker deploy if convenient.

# `legendgroup`-based shadow-trace fade (pltly contract + crashes adoption)

**Status:** shipped (2026-06-20). Pltly landed the refined contract as `a474eda`
(`applyFadeSolo: legendgroup-based shadow-trace fade`) and split off the unrelated
fade-mode perf fix as `47af36b` (`React-driven dispatch: 0 Plotly.react per legend
hover in soloMode:'fade'`); dist tag `0.1.0-dist.47af36b`. Crashes bumped its pin to
that dist tag, deleted the `YtdDeathsPlot` afterplot DOM-mirror `useEffect` (was at
`src/njsp/YtdDeathsPlot.tsx:498-545` in the pre-adoption file), and verified that the
RoY future-segment shadow now fades with its visible sibling on hover under the new
pltly contract — same visual behavior as the mirror used to produce, but driven by
pltly's standard `applyFadeSolo` path. Tomat sign-off in the addendum below predates
the refinement and inspected only the pre-refined `(legendgroup, line.color)` tuple
impl; tomat re-verification against the shipped refined rule is the only remaining
non-blocking follow-up (tomat's `WallclockPlot` already hit the "≥2 visible →
color-match" branch in either version, so behavior is unchanged for it).

## Problem

pltly's `<Plot>` fades non-active traces on legend hover/solo (`applyFadeSolo`). Until
now it did:

```ts
if (trace.showlegend === false) continue   // skip every legendless trace
```

So **"shadow" traces** — `showlegend: false` traces that share a single legend entry
with a visible sibling via `legendgroup` — were never faded. A legend group looks like
one line in the legend but is several Plotly traces; hovering an *unrelated* entry faded
the visible member but left every shadow at full opacity, so the plot looked "not faded".

This is **not tomat-specific.** At least three consumers build this pattern:

- **crashes** — two instances (below).
- **tomat** — `WallclockPlot`: each training restart spawns a new `showlegend:false`
  line segment sharing the latest segment's group; `losses` group holds both TL and VL.
- **awair** — raw/smoothed overlays sharing a `legendgroup` (but driven via
  `hoverinfo:'skip'`, see Exemption below — likely stays opt-out).

crashes hit this first and left a standing TODO for pltly:

> `src/njsp/YtdDeathsPlot.tsx:499` —
> *"Pltly's `applyFadeSolo` still skips `showlegend: false` traces, so YTD's RoY sibling
> needs an afterplot mirror until pltly handles `legendgroup`-based fade."*

…followed by ~40 lines of `querySelectorAll('.scatterlayer .trace')` + per-group opacity
mirroring. **The goal of this spec is to delete that hack.**

## What tomat already wrote into pltly (the UCs under review)

tomat has uncommitted changes in pltly that implement shadow fade. A `showlegend:false`
shadow is treated as "active" iff it shares a **`(legendgroup, line.color)` tuple** with
a `showlegend:true` trace whose `name === active`:

```ts
const siblingKey = (t) => {
  const lg = t.legendgroup
  if (lg == null) return null
  const color = t.line?.color ?? t.marker?.color ?? null
  return `${lg}\x1f${color ?? ''}`
}
// shadow.isActive = activeSiblingKeys.has(siblingKey(shadow))
```

Color is in the key because tomat's `losses` group holds **two visible metrics** (TL red,
VL orange), and each metric's shadows share that metric's exact color. Without color, an
orange-VL shadow would follow red-TL's active state. For tomat's convention (shadows
share their visible sibling's color) this is correct.

## The design tension (why I'm circulating this before merging)

**crashes' shadows deliberately use a *different* color from their visible sibling**, so
keying on `line.color` would fail to match them:

1. `src/njdot/CrashPlot.tsx:648-660` — 12-month average overlay:
   ```ts
   const lineColor = lightenColor(baseColor)   // ≠ the bar's marker.color
   traces.push({ type:'scatter', mode:'lines', name:`${trace.name} (12mo)`,
                 legendgroup: trace.name, showlegend: false,
                 line: { color: lineColor, width: 3.5 }, hovertemplate: … })
   ```
2. `src/njsp/YtdDeathsPlot.tsx:322-340` — faded "future" segment:
   ```ts
   const futureColor = fadeColor(color, { opacity: effectiveFadeOpacity })  // ≠ sibling
   traces.push({ …, name: yearLabel, line: { color: futureColor, … },
                 legendgroup: yearLabel, showlegend: false, hoverinfo: 'none' })
   ```

Both keep the **same `legendgroup` as the visible sibling but a different `line.color`**.
And crashes' own (to-be-deleted) workaround keys on **`legendgroup` alone**
(`opByGroup.set(t.legendgroup, op)`), confirming legendgroup is the natural join for our
case. So the tuple-with-color contract, as written, **would not fade crashes' shadows** —
we'd be unable to drop the hack.

The difference is structural, not accidental:

| consumer | visible traces per `legendgroup` | shadow color vs. sibling |
|----------|----------------------------------|--------------------------|
| crashes  | 1                                | **different** (lightened / faded) |
| tomat    | 2 (TL + VL in `losses`)          | **same** (shares metric color) |

## Proposed contract (convention-agnostic)

Match shadows to siblings by **`legendgroup`, using color only to disambiguate when a
group has more than one visible member**:

1. Build `visibleByGroup: Map<legendgroup, Trace[]>` from `showlegend !== false` traces.
2. For a shadow with group `g`:
   - **0 visible members in `g`** → fall back to `name === active` (today's behavior for
     groupless shadows).
   - **exactly 1 visible member** → shadow follows that member's active state.
     **Color is ignored.** (Satisfies crashes — lightened/faded shadows still match.)
   - **≥2 visible members** → shadow follows the member it color-matches
     (`line.color`/`marker.color`); if none match, fall back to "any member active".
     (Satisfies tomat — red shadow → TL, orange shadow → VL.)

This is a strict generalization of tomat's UCs (identical behavior when every group has
one visible member *or* shadows share their sibling's color) that also covers crashes.

Alternative if a smart default feels too magic: expose a pluggable
`shadowSibling?: (shadow, visibleTraces) => Trace | null` prop and ship the rule above as
the default. tomat/crashes would then never need to override it, but awair-style cases
could. **Preference: smart default, no required config.** (Flag in review if you'd rather
have the explicit hook.)

### `hoverinfo` exemption — please confirm this convention

pltly's UCs exempt shadows with `hoverinfo === 'skip'` entirely ("caller manages its own
opacity; pltly keep out") — used by ±σ band edges in tomat/awair. Note crashes' RoY
shadows use `hoverinfo: 'none'`, **not** `'skip'`, so under this contract they
**participate** in fade (which is what we want). Pinning the convention:

- `hoverinfo: 'skip'` → caller-managed, pltly never touches opacity.
- everything else (incl. `'none'`) → participates in `legendgroup`-based fade.

crashes + tomat: confirm this `skip` vs. `none` split matches your intent.

## crashes adoption (once pltly ships the contract)

1. Bump the pltly pin (currently `dist.4d286ec`, `package.json:50`) to the new build.
2. **`src/njsp/YtdDeathsPlot.tsx`** — delete the afterplot DOM-mirror `useEffect`
   (the `wrapRef` opacity/stroke-width mirror, ~lines 498-540) and its `wrapRef` wiring;
   verify RoY future-segment shadows fade with their year's visible line on hover/solo,
   and that the active-RoY width bump still happens (it's also expressible via
   `activeStyle`, already in use here).
3. **`src/njdot/CrashPlot.tsx`** — verify the 12mo overlay shadow now fades with its bar
   on hover. (I have *not* fully traced CrashPlot's fade path — confirm whether it relied
   on any manual mirroring or just inherited the skip-everything gap. Line 606's
   `isActive = trace.name === activeTrace || trace.legendgroup === activeTrace` suggests
   it may already lean on legendgroup; reconcile with the new pltly behavior.)
4. Visually re-verify both plots (hover + solo, fade mode and any solo/hide mode) — these
   are central charts.

## Sign-off checklist

- [ ] **tomat**: the refined "legendgroup-primary, color-disambiguates-multi-visible-groups"
      rule still produces correct fades for `WallclockPlot` (TL/VL in `losses`, restart
      segments) and your other shadow plots. No regression vs. your current UCs.
- [ ] **tomat**: `hoverinfo:'skip'` = caller-managed exemption matches your band-edge usage.
- [ ] **crashes**: legendgroup-only matching (color ignored for single-visible groups)
      fades our lightened/faded shadows; we can delete the YtdDeathsPlot mirror.
- [ ] **pltly**: implement the refined contract; keep tomat's `_pltlyOrigs` restore path
      and the `hoverinfo:'skip'` exemption; split from the unrelated
      "0 `Plotly.react` per hover in fade mode" fix (that one is mode-agnostic and should
      land independently).

## Out of scope / separate

The other half of tomat's pltly UCs — gating `mergedLayout`'s `activeTrace` dep on
`soloMode:'hide'`, the `EMPTY_LINKED` sentinel, and ref-trampolining
`afterRender`/`bindEvents` so **fade mode** stops firing a full `Plotly.react` per legend
hover — is a pure pltly-layer perf/correctness fix that benefits every consumer. It's
unrelated to this contract and should land on its own.

## Addendum — tomat sign-off (2026-06-20)

Verified against `WallclockPlot` + a full audit of every other `showlegend: false` site
in tomat (`grep -rn "showlegend.*false" site/src`):

| site                                       | kind                            | participates? |
|--------------------------------------------|---------------------------------|---------------|
| `runs/WallclockPlot.tsx` segment lines     | shadow (group `losses`/lineage) | **yes**       |
| `runs/WallclockPlot.tsx` dashed bridges    | shadow w/ `hoverinfo: 'none'`   | **yes**       |
| `runs/WallclockPlot.tsx` band edges        | `hoverinfo: 'skip'`             | exempt        |
| `voxel-corr/VoxelCorrPage.tsx` ±σ edges    | `hoverinfo: 'skip'`             | exempt        |
| `runs/RunsTimelinePlot.tsx` band edges     | `hoverinfo: 'skip'`             | exempt        |
| `TrajectoryPlot.tsx` "best" star markers   | `hoverinfo: 'skip'`             | exempt        |
| `ParetoPlot.tsx`/`FractionPlot.tsx` min-max| `hoverinfo: 'skip'`             | exempt        |
| `JointHistPlot.tsx` marginal bars          | trace-level, no `legendgroup`   | "0 visible → name fallback" — n/a (plot has no legend) |
| `MatsMetadataPlots.tsx` / `RunsTimelinePlot.tsx:1221` | layout-level setting    | not a trace   |

So WallclockPlot is the only place in tomat with the shadow pattern, and the refined
rule handles it correctly:

- **`losses` group** has 2 visible members (`TL (train loss)`, `VL (eval loss)`) →
  falls into "≥2 visible members → color-match" branch. Each metric's shadows share
  exactly that metric's color (red TL_color / orange VL_color), so they match
  unambiguously. Behavior identical to the current UCs. ✓
- **`lineage:<ancestor>` groups** each have 1 visible member (the latest ancestor
  segment) → falls into "exactly 1 visible → shadow follows it, color ignored". Tomat
  happens to share color today (`traceColor = ancestor.color` for all segments in an
  ancestor group), so the refined rule and the current UCs are observationally identical
  here too. ✓
- **`mtmv` group** holds 4 visible members (MT/MV × K=1/K=12) with no shadows. No
  shadow-fade path involved. ✓

### Checklist — tomat

- [x] Refined rule produces correct fades for `WallclockPlot`; no regression vs. current
      UCs (verified by inspection — the refined rule is a strict generalization and tomat's
      groups all hit branches with identical behavior).
- [x] `hoverinfo: 'skip'` = caller-managed exemption matches our band-edge usage in
      `voxel-corr/`, `RunsTimelinePlot`, `ParetoPlot`/`FractionPlot`, `TrajectoryPlot`.
- [x] WallclockPlot dashed bridges (`hoverinfo: 'none'`) **should** participate in fade —
      they're a cosmetic continuation of their parent segment, so following its opacity
      is the right call. Matches the spec's `skip` vs. `none` split.
- [x] Splitting the unrelated `mergedLayout` / fade-mode-Plotly.react-per-hover fix into
      its own pltly commit is fine — no tomat-side coupling.

### One forward-looking note (not blocking)

When the refined rule lands, tomat's own consumer-side band-fade hack in
`WallclockPlot.tsx:193-237` (`applyBandFade` — walks `plotDiv.data` and `Plotly.restyle`s
band edges) becomes redundant IFF the band edges drop `hoverinfo: 'skip'` and rely on
pltly's automatic shadow-fade. Today they explicitly opt out, and the hack restores
fade manually. We can revisit this as a follow-up after the contract lands, but it's not
part of this spec's adoption.

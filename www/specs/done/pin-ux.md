# Pin UX Spec (for pltly)

## Summary
Pinned legend item (LI) behavior for pltly's `<Plot>` component. Should be the default (or easily enabled via flag).

## States

### No pin active
- Hover LI → highlight/solo that trace on plot, bold that LI
- Unhover → back to normal (all traces visible/unfaded)
- Click LI → **pin** that trace

### Pin active
- **Pinned LI**: bold text, trace is highlighted/solo'd on plot
- **Plot does NOT change on hover** — pinned trace stays highlighted/solo'd
- Hover a *different* LI → that LI's text becomes bold (preview signal: "click to switch pin here"), but plot stays on pinned trace
- Click a different LI → pin switches to that trace
- Click the pinned LI → **unpin**, back to normal
- Double-click any LI → **unpin**, back to normal

## Implementation Notes

### `useSoloTrace` changes
Current: `activeTrace = hoverTrace ?? soloTrace ?? null`
New: `activeTrace = soloTrace ?? hoverTrace ?? null`

When `soloTrace` is set, it takes priority over `hoverTrace` for plot rendering.

### LI styling
- `activeTrace` (pinned or hovered) → bold LI text
- When pinned: hovered LI gets bold *in addition to* pinned LI (two bold LIs possible)
- This means we need both `soloTrace` and `hoverTrace` exposed for styling, or a combined "bold set"

### Outputs from hook
```ts
{
  activeTrace: string | null     // drives plot fade/solo (soloTrace ?? hoverTrace)
  soloTrace: string | null       // the pinned trace (null if no pin)
  hoverTrace: string | null      // transient hover (always tracks mouse)
  // LI should be bold if: name === activeTrace || (soloTrace && name === hoverTrace)
}
```

### `onActiveTraceChange` callback
Should fire with the new `activeTrace` (pin-prioritized). Consumers use this for custom effects (bar widening, text labels, visibility toggling, etc.)

### `onHoverTraceChange` callback
Always fires with the raw hover state, even when pinned. Useful for LI bold-preview styling if consumer manages their own legend.

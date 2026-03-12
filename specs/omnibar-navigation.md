# Omnibar navigation with `use-kbd`

Supersedes the omnibar portion of `specs/keyboard-nav-and-speed-dial.md`. SpeedDial and plot/table keyboard shortcuts are out of scope here.

## Goals

1. Cmd+K omnibar for searching and navigating to counties, municipalities, and page sections
2. Geo navigation: selecting a county or muni navigates to the corresponding route
3. Section jumping: selecting a section scrolls to its anchor on the current page

## Plan

### 1. Install and wire `use-kbd`

```bash
pnpm add use-kbd
```

Add `<KbdProvider>` in `main.tsx`, wrapping the app inside the existing provider stack:

```tsx
<ThemeProvider>
  <KbdProvider>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </KbdProvider>
</ThemeProvider>
```

`KbdProvider` must be outside `BrowserRouter` so the omnibar component can use router hooks via children that consume both contexts.

### 2. Search index structure

Build a flat array of searchable items from two sources:

#### Geo items (from `cc2mc2mn`)

`cc2mc2mn` is already loaded in `GeoFilterContext`. Flatten it into items:

```ts
type OmnibarItem = {
  id: string
  label: string
  // secondary text shown dimmer, e.g. "County" or "Bergen County"
  description: string
  keywords: string[]
  action: () => void
}
```

For each county `cc`:
```ts
{ id: `county-${cc}`, label: cn, description: "County", keywords: [cn], action: () => navigate(`/c/${normalize(cn)}`) }
```

For each municipality `(cc, mc)`:
```ts
{ id: `muni-${cc}-${mc}`, label: mn, description: `${cn} County`, keywords: [mn, cn], action: () => navigate(`/c/${normalize(cn)}/${normalize(mn)}`) }
```

This yields ~21 county items + ~565 municipality items.

#### Section items (from current page)

Derive from the `<h2 id="...">` elements present on the page. These are currently:

| `id` | Label |
|------|-------|
| (plot: per-year) | Fatalities per Year |
| `njsp-crashes` | Recent Fatal Crashes (NJSP) |
| (plot: ytd) | Year-to-Date Deaths |
| (plot: homicides) | Homicides Comparison |
| (plot: per-month) | Fatalities per Month |
| (plot: by-month-bars) | Fatalities by Month |
| `njdot` | NJ DOT Crash Data |
| `stats` | Annual Statistics (NJ DOT) |
| `njdot-crashes` | Crash Details (NJ DOT) |
| `map` | Hudson County Crash Map |

Plots that lack `<h2>` anchors today should get `id` attributes on their `PlotContainer` wrappers (or a wrapping `<section>`) so they become scrollable targets. This is a prerequisite change.

Section items:
```ts
{ id: `section-${sectionId}`, label: heading, description: "Section", keywords: [heading], action: () => scrollToAnchor(sectionId) }
```

Build section items dynamically by querying `document.querySelectorAll('h2[id]')` when the omnibar opens, so they reflect the actual page (some sections are conditionally rendered based on geo filter).

### 3. Omnibar component

Create `src/components/Omnibar.tsx`:

- Register `use-kbd` action with hotkey `Meta+k` (Cmd+K on Mac, Ctrl+K elsewhere) to open the omnibar
- Also register `Escape` to close when open
- Render as a modal overlay (centered, above content, with backdrop)
- Text input at top, filtered results list below
- Fuzzy match against `label` and `keywords` fields
- Group results visually: "Counties", "Municipalities", "Sections" (with group headers)
- Arrow keys to navigate results, Enter to select, Escape to close
- Show at most ~10 results, prioritizing exact prefix matches over fuzzy

Place `<Omnibar />` inside `GeoFilterProvider` in `App.tsx` (it needs `cc2mc2mn` from context and `useNavigate` from router):

```tsx
function GeoHome() {
    return (
        <GeoFilterProvider>
            <Omnibar />
            <Home />
        </GeoFilterProvider>
    )
}
```

### 4. Geo navigation

When a geo item is selected:
- Call `navigate()` to the county/muni route (same as `setCounty`/`setMunicipality` in `GeoFilterContext`)
- Close the omnibar
- No scroll behavior needed; route change triggers full re-render

The `normalize()` function from `county.ts` handles slug generation.

### 5. Section jumping

When a section item is selected:
- Close the omnibar
- Call `document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' })` (or use `location.hash` for URL update)
- Prefer `scrollIntoView` with a small `scroll-margin-top` CSS rule on `h2[id]` to account for any sticky header

### 6. Prerequisite: add `id` attributes to plot sections

Currently only some `<h2>` elements have `id`s. Each plot/section needs one. Either:
- Add `id` prop to `PlotContainer` and render a wrapping element with that id
- Or add `id` directly to existing `<h2>` elements in `Home.tsx`

Proposed ids for plots that currently lack them:

| Plot component | Proposed `id` |
|---------------|---------------|
| `FatalitiesPerYearPlot` | `per-year` |
| `YtdDeathsPlot` | `ytd` |
| `HomicidesComparisonPlot` | `homicides` |
| `FatalitiesPerMonthPlot` | `per-month` |
| `FatalitiesByMonthBarsPlot` | `by-month` |
| `CrashPlot` | `njdot-plot` |

Add `<h2 id="...">` wrappers or `id` on the `PlotContainer` for each.

### 7. Styling

- Modal backdrop: semi-transparent dark overlay (`rgba(0,0,0,0.5)`)
- Omnibar panel: max-width ~600px, centered, rounded corners, respects theme (light/dark)
- Input: full width, large font, autofocused
- Results: scrollable list, highlighted current selection, group headers
- Add to existing SCSS modules or create `src/components/omnibar.module.scss`
- Transition: fade in/out (keep it simple, CSS-only)

### 8. Mobile considerations

- No Cmd+K on mobile; add a search icon button in the header/nav area that opens the omnibar on tap
- Omnibar should be full-width on small viewports (responsive)
- Virtual keyboard will push content up; the omnibar should be positioned at the top of the viewport (not centered vertically) on mobile to stay visible above the keyboard
- Touch targets for result items should be at least 44px tall

## Out of scope

- SpeedDial / floating action button (separate spec)
- Plot-specific keyboard shortcuts (arrow keys, enter, escape)
- Table keyboard navigation
- Cross-page search (searching sections on a page you're not currently viewing)

## Dependencies

- [`use-kbd`] -- omnibar primitives, hotkey registration

[`use-kbd`]: https://www.npmjs.com/package/use-kbd

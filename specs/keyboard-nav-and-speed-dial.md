# Keyboard navigation and SpeedDial

## Context

The site has 7+ interactive plots, 3 tables, a map, and multiple control panels — but no keyboard navigation or discoverability layer. [`use-kbd`] provides omnibars, speed dials, and editable hotkeys for React apps.

## Goals

1. **SpeedDial** (floating action button): quick access to sections, theme toggle, controls
2. **Keyboard shortcuts**: navigate between sections, toggle plot controls, table interactions
3. **Omnibar** (Cmd+K): search/jump to counties, municipalities, plots, tables

## Plan

### 1. Install and wire `use-kbd`

```bash
pnpm add use-kbd
```

Add `<KbdProvider>` wrapping the app in `main.tsx` (alongside existing `ThemeProvider`, `GeoFilterProvider`).

### 2. SpeedDial actions

Floating button (bottom-right corner, above footer). Actions:

| Key | Action | Description |
|-----|--------|-------------|
| `t` | Toggle theme | Light ↔ Dark |
| `1`–`7` | Jump to plot | Scroll to FatalitiesPerYear, YTD, Homicides, PerMonth, ByMonth, CrashPlot, Map |
| `s` | Jump to stats table | Scroll to Annual Statistics |
| `c` | Jump to crashes table | Scroll to NJDOT Crash Details |
| `f` | Jump to fatal crashes | Scroll to NJSP Recent Fatal Crashes |
| `g` | Toggle CrashPlot controls | Open/close the gear panel |

### 3. Omnibar (Cmd+K)

Search targets:
- **Counties**: "Hudson", "Bergen", etc. → navigate to `/c/{county}`
- **Municipalities**: "Jersey City", etc. → navigate to `/c/{county}/{muni}`
- **Sections**: "map", "stats", "fatal crashes" → scroll to section
- **Actions**: "dark mode", "light mode" → toggle theme

Data source: `cc2mc2mn` (already loaded in GeoFilterContext) provides full county/municipality list.

### 4. Plot-specific shortcuts

When a plot is focused/visible:
- `←`/`→`: navigate between time periods (if applicable)
- `Enter`: toggle solo on hovered trace
- `Escape`: reset solo / clear selection

### 5. Table keyboard nav

- `↑`/`↓`: move selection in year stats table
- `Space`: toggle row selection
- `Shift+↑`/`Shift+↓`: extend range selection

## Dependencies

- [`use-kbd`] — keyboard hooks, SpeedDial, Omnibar components

[`use-kbd`]: https://www.npmjs.com/package/use-kbd

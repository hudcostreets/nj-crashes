/** Placement of the full-screen map's overlay chrome (home link, title pill,
 *  legend, settings drawer / ⚙ button) by map width.
 *
 *  Wide maps keep the original layout: title pill centered on top, drawer
 *  top-right. Below `NARROW_MAP_PX` the centered pill ran under both the
 *  "NJ Crashes" home link and the open settings drawer (Points/Heatmap/Bins
 *  + render strategy + debug) at 360-430 px phone widths, so there:
 *  - the home link collapses to its icon,
 *  - the title pill spans the gap between it and the ⚙/↺ buttons (and may
 *    wrap to two lines),
 *  - the legend and the open drawer start below the title pill,
 *  - the drawer starts closed (the ⚙ button opens it). */
export const NARROW_MAP_PX = 640

/** Top/left/right of the fixed controls on a narrow map (CSS px). */
const EDGE = 8
/** Icon-only home link: 8 px inset + ~30 px box + 6 px gap. */
const HOME_ICON_RIGHT = 44
/** ⚙ (right: 8, ~26 px) and ↺ (right: 40, 24 px) buttons + gap. */
const TOP_RIGHT_BUTTONS = 72
const GAP = 6

export type MapChrome = {
    narrow: boolean
    /** Home link shows only its icon. */
    homeIconOnly: boolean
    /** Title pill: centered (`left: 50%` + translate), or pinned between
     *  `left` and `right` insets. */
    title: { centered: true } | { centered: false; left: number; right: number }
    /** Legend top offset. */
    legendTop: number
    /** Open drawer's top offset. */
    drawerTop: number
    drawerDefaultOpen: boolean
}

/** Overlay layout for a full-screen map `width` px wide whose title pill is
 *  `titleHeight` px tall (measured; wraps on narrow maps). */
export function mapChrome(width: number, titleHeight: number): MapChrome {
    if (width >= NARROW_MAP_PX) {
        return {
            narrow: false, homeIconOnly: false, title: { centered: true },
            legendTop: 42, drawerTop: EDGE, drawerDefaultOpen: true,
        }
    }
    const belowTitle = EDGE + titleHeight + GAP
    return {
        narrow: true, homeIconOnly: true,
        title: { centered: false, left: HOME_ICON_RIGHT, right: TOP_RIGHT_BUTTONS },
        legendTop: Math.max(42, belowTitle),
        drawerTop: belowTitle,
        drawerDefaultOpen: false,
    }
}

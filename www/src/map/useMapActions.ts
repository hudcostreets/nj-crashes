import { useActions } from "use-kbd"
import type { MapMode, HeatRender } from "@/src/map/CrashMap"
import { HEAT_C_SIGMA_FRAC, HEAT_C_PX_TARGET, HEAT_C_OPACITY } from "@/src/map/CrashMap"

type Severity = "f" | "i" | "p"

export type MapActionsState = {
    mode: MapMode
    setMode: (m: MapMode) => void
    heatRender: HeatRender
    setHeatRender: (hr: HeatRender) => void
    severities: Set<Severity>
    toggleSeverity: (s: Severity) => void
    heightScale: number
    setHeightScale: (v: number) => void
    cellAuto: boolean
    setCellAuto: (v: boolean) => void
    manualCellPx: number
    setCellPxTarget: (v: number) => void
    /** Strategy-C knobs; `null` = the `HEAT_C_*` default (keeps the URL clean). */
    heatSig: number | null
    setHeatSig: (v: number | null) => void
    heatCpx: number | null
    setHeatCpx: (v: number | null) => void
    heatOp: number | null
    setHeatOp: (v: number | null) => void
    drawerOpen: boolean
    setDrawerOpen: (v: boolean) => void
    debugOpen: boolean
    setDebugOpen: (v: boolean) => void
}

const GROUP = "Map"
const MODE_LABELS: Record<MapMode, string> = { bins: "Bins", scatter: "Points", heatmap: "Heatmap" }
const MODE_KEYS: Record<MapMode, string> = { bins: "m b", scatter: "m p", heatmap: "m h" }
const HEAT_LABELS: Record<HeatRender, string> = {
    legacy: "Legacy (deck.gl HeatmapLayer)",
    a: "A (baked KDE surface)",
    b: "B (soft-kernel discs)",
    c: "C (tiled baked KDE)",
}
const SEV_LABELS: Record<Severity, string> = { f: "fatal", i: "injury", p: "property-damage" }
const SEV_KEYS: Record<Severity, string> = { f: "m f", i: "m i", p: "m o" }

/** Multiplicative nudge step for scale-like knobs (height, σ, cell px). */
const STEP = 1.25
const round = (v: number) => Math.round(v * 1000) / 1000
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Write `v`, or `null` when it lands back on the default (so it drops out of the URL). */
const orNull = (v: number, dflt: number) => (round(v) === round(dflt) ? null : round(v))

/** Registers the crash map's controls as `use-kbd` actions, so they're
 *  reachable from the omnibar (e.g. "heatm…") and, for the common ones,
 *  via `m …` key sequences. Mirrors the toolbox drawer's controls. */
export function useMapActions(s: MapActionsState): void {
    const heatC = s.mode === "heatmap" && s.heatRender === "c"
    const sig = s.heatSig ?? HEAT_C_SIGMA_FRAC
    const cpx = s.heatCpx ?? HEAT_C_PX_TARGET
    const op = s.heatOp ?? HEAT_C_OPACITY

    const modes = Object.fromEntries((Object.keys(MODE_LABELS) as MapMode[]).map(m => [
        `map:mode-${m}`,
        {
            label: `Map mode: ${MODE_LABELS[m]}`,
            group: GROUP,
            defaultBindings: [MODE_KEYS[m]],
            keywords: m === "scatter" ? ["points", "scatter", "dots"] : [m],
            handler: () => s.setMode(m),
        },
    ]))
    const heats = Object.fromEntries((Object.keys(HEAT_LABELS) as HeatRender[]).map(hr => [
        `map:heat-${hr}`,
        {
            label: `Heatmap render: ${HEAT_LABELS[hr]}`,
            group: GROUP,
            keywords: ["heatmap", "render", "strategy", "density", hr],
            handler: () => { s.setMode("heatmap"); s.setHeatRender(hr) },
        },
    ]))
    const sevs = Object.fromEntries((Object.keys(SEV_LABELS) as Severity[]).map(sv => [
        `map:severity-${sv}`,
        {
            label: `${s.severities.has(sv) ? "Hide" : "Show"} ${SEV_LABELS[sv]} crashes`,
            group: GROUP,
            defaultBindings: [SEV_KEYS[sv]],
            keywords: ["severity", "filter", SEV_LABELS[sv]],
            handler: () => s.toggleSeverity(sv),
        },
    ]))

    const heatCActions = {
        "map:heat-sharper": {
            label: "Heatmap: sharper",
            group: GROUP,
            keywords: ["heatmap", "sigma", "kernel", "crisp"],
            handler: () => s.setHeatSig(orNull(sig / STEP, HEAT_C_SIGMA_FRAC)),
        },
        "map:heat-softer": {
            label: "Heatmap: softer",
            group: GROUP,
            keywords: ["heatmap", "sigma", "kernel", "blur", "smooth"],
            handler: () => s.setHeatSig(orNull(sig * STEP, HEAT_C_SIGMA_FRAC)),
        },
        "map:heat-finer": {
            label: "Heatmap: finer cells",
            group: GROUP,
            keywords: ["heatmap", "cell", "resolution"],
            handler: () => s.setHeatCpx(orNull(cpx / STEP, HEAT_C_PX_TARGET)),
        },
        "map:heat-coarser": {
            label: "Heatmap: coarser cells",
            group: GROUP,
            keywords: ["heatmap", "cell", "resolution"],
            handler: () => s.setHeatCpx(orNull(cpx * STEP, HEAT_C_PX_TARGET)),
        },
        "map:heat-opacity-up": {
            label: "Heatmap: more opaque",
            group: GROUP,
            keywords: ["heatmap", "opacity", "alpha"],
            handler: () => s.setHeatOp(orNull(clamp(op + 0.1, 0.1, 1), HEAT_C_OPACITY)),
        },
        "map:heat-opacity-down": {
            label: "Heatmap: more transparent",
            group: GROUP,
            keywords: ["heatmap", "opacity", "alpha", "translucent"],
            handler: () => s.setHeatOp(orNull(clamp(op - 0.1, 0.1, 1), HEAT_C_OPACITY)),
        },
        "map:heat-reset": {
            label: "Heatmap: reset tuning",
            group: GROUP,
            keywords: ["heatmap", "reset", "defaults"],
            handler: () => { s.setHeatSig(null); s.setHeatCpx(null); s.setHeatOp(null) },
        },
    }

    useActions({
        ...modes,
        ...heats,
        ...sevs,
        "map:toolbox": {
            label: `${s.drawerOpen ? "Close" : "Open"} map toolbox`,
            group: GROUP,
            defaultBindings: ["m t"],
            keywords: ["settings", "controls", "drawer"],
            handler: () => s.setDrawerOpen(!s.drawerOpen),
        },
        "map:debug": {
            label: `${s.debugOpen ? "Hide" : "Show"} map debug panel`,
            group: GROUP,
            defaultBindings: ["m d"],
            handler: () => s.setDebugOpen(!s.debugOpen),
        },
        "map:height-up": {
            label: "Taller bars",
            group: GROUP,
            keywords: ["height", "scale", "bars"],
            handler: () => s.setHeightScale(round(s.heightScale * STEP)),
        },
        "map:height-down": {
            label: "Shorter bars",
            group: GROUP,
            keywords: ["height", "scale", "bars"],
            handler: () => s.setHeightScale(round(s.heightScale / STEP)),
        },
        "map:cell-auto": {
            label: `${s.cellAuto ? "Disable" : "Enable"} adaptive cell size`,
            group: GROUP,
            keywords: ["cell", "size", "auto", "adaptive", "resolution"],
            handler: () => s.setCellAuto(!s.cellAuto),
        },
        "map:cells-coarser": {
            label: "Coarser cells",
            group: GROUP,
            keywords: ["cell", "size", "resolution", "bigger"],
            handler: () => { s.setCellAuto(false); s.setCellPxTarget(round(s.manualCellPx * STEP)) },
        },
        "map:cells-finer": {
            label: "Finer cells",
            group: GROUP,
            keywords: ["cell", "size", "resolution", "smaller"],
            handler: () => { s.setCellAuto(false); s.setCellPxTarget(round(s.manualCellPx / STEP)) },
        },
        // Strategy-C tuning: only registered while C is showing. `use-kbd`
        // re-registers on action-*set* changes but not on `enabled` flips, so
        // an `enabled: false` action would stay hidden after switching to C.
        ...(heatC ? heatCActions : {}),
    })
}

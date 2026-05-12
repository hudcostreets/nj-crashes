import { useEffect, useMemo, useState, useCallback, useRef } from "react"
import { useResetSolo } from "@/src/lib/ResetSoloContext"
import { EndYear, StartYear } from "@/src/constants"
import type { Layout, PlotData } from "plotly.js"
import { lightenColor, useTheme } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { useParquet } from "@/src/lib/useParquet"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import {
    YmsRow, YmccsRow, YmccmcsRow,
    Severity, Severities, SeverityLabels, SeverityDefs, SeverityColorsLight, SeverityColorsDark,
    Condition, Conditions, ConditionLabels, ConditionDefs, ConditionColors,
    VictimType, VictimTypes, VictimTypeLabels, VictimTypeDefs, VictimTypeColors,
    MeasureKind, MeasureKinds, MeasureKindLabels, MeasureKindDefs,
    vtcCol,
    Counties,
    StackBy,
    toYM,
} from "./data"
import { Checklist } from "./Checklist"
import { Radios } from "./Radios"
import { CountyDropdown } from "./CountyDropdown"
import { MunicipalityDropdown } from "./MunicipalityDropdown"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { Tooltip } from "@/src/tooltip"
import { ControlsGear } from "@/src/components/ControlsGear"
import css from "./controls.module.css"
import { useAnnotations } from "@/src/annotations/useAnnotations"
import { toPlotLayers, yearInAnyRange } from "@/src/annotations/plot"
import { AnnotationTrigger, AnnotationBody, useAnnotationOpenState } from "@/src/annotations/AnnotationDetails"

type CrashPlotProps = {
    /** Stack by dimension */
    stackBy?: StackBy
    /** Filter to specific severities */
    severities?: Severity[]
    /** Filter to specific county codes */
    counties?: number[]
    /** Filter to specific municipality code (within county) */
    mc?: number | null
    /** Time granularity */
    timeGranularity?: 'year' | 'month'
    /** Chart height */
    height?: number
    /** Show controls drawer */
    showControls?: boolean
    /** Start with controls open */
    controlsOpen?: boolean
}

const DEFAULT_HEIGHT = 550
const ALL_COUNTIES = Object.keys(Counties).map(Number)

export default function CrashPlot({
    stackBy: initialStackBy = 'severity',
    severities: initialSeverities = [...Severities],
    counties: initialCounties = ALL_COUNTIES,
    mc = null,
    timeGranularity: initialTimeGranularity = 'year',
    height = DEFAULT_HEIGHT,
    showControls = true,
    controlsOpen: initialControlsOpen = false,
}: CrashPlotProps) {
    // Measure radio: Crashes / People / Vehicles. `crashes` and `vehicles` map
    // to the `n` / `tv` columns; `people` sums the 25-cell VTC matrix filtered
    // by the active Condition + Victim Type selections.
    const [measure, setMeasure] = useSessionStorage<MeasureKind>('crashplot-measure-v2', 'crashes')
    const [stackBy, setStackBy] = useSessionStorage<StackBy>('crashplot-stackBy', initialStackBy)
    const [severities, setSeverities] = useSessionStorage<Severity[]>('crashplot-severities', initialSeverities)
    const [conditions, setConditions] = useSessionStorage<Condition[]>('crashplot-conditions', [...Conditions])
    const [victimTypes, setVictimTypes] = useSessionStorage<VictimType[]>('crashplot-victimTypes', [...VictimTypes])
    const [counties, setCounties] = useSessionStorage<number[]>('crashplot-counties', initialCounties)
    // Sync with external counties prop (geo filter)
    useEffect(() => { setCounties(initialCounties) }, [initialCounties.join(',')])
    const [timeGranularity, setTimeGranularity] = useSessionStorage<'year' | 'month'>('crashplot-timeGranularity', initialTimeGranularity)
    const [stackPercent, setStackPercent] = useSessionStorage('crashplot-stackPercent', false)
    const [show12moAvg, setShow12moAvg] = useSessionStorage('crashplot-show12moAvg', false)
    const [controlsOpen, setControlsOpen] = useSessionStorage('crashplot-controls-open', initialControlsOpen)

    const [activeTrace, setActiveTrace] = useState<string | null>(null)
    useResetSolo(useCallback(() => setActiveTrace(null), []))
    const { isDark } = useTheme()
    const SeverityColors = isDark ? SeverityColorsDark : SeverityColorsLight
    const plotColors = usePlotColors()

    const { cc2mc2mn } = useGeoFilter()
    const hasMuniFilter = mc !== null
    const isSingleCounty = counties.length === 1
    const annotationCc = isSingleCounty ? counties[0] : null
    const plotAnnotations = useAnnotations({ page: 'njdot-crash-plot', cc: annotationCc, mc })
    const [barHovered, setBarHovered] = useState(false)
    const annOpen = useAnnotationOpenState(barHovered)
    // Debounce unhover — when the cursor crosses between stacked bar segments,
    // Plotly fires unhover then hover back-to-back, which would otherwise cause
    // the annotation body to flicker closed-then-open.
    const unhoverTimerRef = useRef<number | null>(null)

    const handleHover = useCallback((ev: { points?: Array<{ x: number | string }> }) => {
        if (unhoverTimerRef.current !== null) {
            clearTimeout(unhoverTimerRef.current)
            unhoverTimerRef.current = null
        }
        if (!plotAnnotations.length) return
        const x = ev.points?.[0]?.x
        const year = typeof x === 'number' ? x : typeof x === 'string' ? parseInt(x) : NaN
        if (isFinite(year)) setBarHovered(yearInAnyRange(plotAnnotations, year))
    }, [plotAnnotations])

    const handleUnhover = useCallback(() => {
        if (unhoverTimerRef.current !== null) clearTimeout(unhoverTimerRef.current)
        unhoverTimerRef.current = window.setTimeout(() => {
            setBarHovered(false)
            unhoverTimerRef.current = null
        }, 150)
    }, [])

    // Municipality multi-select for county-level pages
    const mc2mn = isSingleCounty && cc2mc2mn?.[counties[0]]?.mc2mn || null
    const allMunis = useMemo(() => mc2mn ? Object.keys(mc2mn).map(Number) : [], [mc2mn])
    const [selectedMunis, setSelectedMunis] = useSessionStorage<number[]>('crashplot-selectedMunis', [])
    // Sync: reset to all munis when county changes or mc2mn loads
    useEffect(() => {
        if (allMunis.length > 0 && (selectedMunis.length === 0 || !allMunis.includes(selectedMunis[0]))) {
            setSelectedMunis(allMunis)
        }
    }, [allMunis.join(',')])
    // Municipality filter: disable county/muni stacking; single-county: disable
    // county stacking. Condition/Victim-Type only apply for measure='people';
    // fall back to 'none' otherwise.
    const peopleOnlyStack = stackBy === 'condition' || stackBy === 'victim_type'
    const effectiveStackBy = hasMuniFilter && (stackBy === 'county' || stackBy === 'municipality') ? 'none'
        : !isSingleCounty && stackBy === 'municipality' ? 'none'
        : peopleOnlyStack && measure !== 'people' ? 'none'
        : stackBy

    // Reset active trace when stacking mode changes
    useEffect(() => { setActiveTrace(null) }, [stackBy])

    // Municipality-level or muni stacking: use ymccmcs (per-county, has mc + severity)
    // County-level: use ymccs when filtering/stacking by county
    // State-level: use yms
    // Use muni-level data when: muni page, muni stacking, or county page with muni picker active
    const hasMuniPicker = !hasMuniFilter && isSingleCounty
    const needsMuniData = hasMuniFilter || (isSingleCounty && (effectiveStackBy === 'municipality' || (hasMuniPicker && selectedMunis.length < allMunis.length)))
    const needsCountyData = !needsMuniData && (stackBy === 'county' || counties.length < ALL_COUNTIES.length)
    const source = needsMuniData ? 'ymccmcs' : needsCountyData ? 'ymccs' : 'yms'

    type AnyRow = YmsRow | YmccsRow | YmccmcsRow
    // Municipality-level or muni stacking: load per-county split file
    const url = needsMuniData
        ? `/data/njdot/ymccmcs/${counties[0]}.parquet`
        : `/data/njdot/${source}.parquet`
    const { data, loading, error, timing } = useParquet<AnyRow>(url)

    // Helpers to get numeric values from rows (handles BigInt from parquet)
    const getCol = (row: AnyRow, key: string): number => {
        const val = (row as Record<string, unknown>)[key]
        if (val == null) return 0
        return typeof val === 'bigint' ? Number(val) : (val as number)
    }
    // `crashes` → `n`; `vehicles` → `tv`; `people` → sum of VTC cells filtered
    // by current Condition/VictimType selections. Severity (crash-level) is
    // applied at the row-filter stage (above), not here.
    const getVal = (row: AnyRow): number => {
        if (measure === 'crashes') return getCol(row, 'n')
        if (measure === 'vehicles') return getCol(row, 'tv')
        // people: sum vtcCol(vt, c) cells for selected types × conditions
        let total = 0
        for (const vt of victimTypes) {
            for (const c of conditions) {
                total += getCol(row, vtcCol(vt, c))
            }
        }
        return total
    }
    // For Stack By = Condition: pick only one Condition's cells per trace.
    const getValByCondition = (row: AnyRow, c: Condition): number => {
        let total = 0
        for (const vt of victimTypes) {
            total += getCol(row, vtcCol(vt, c))
        }
        return total
    }
    // For Stack By = Victim Type: pick only one VictimType's cells per trace.
    const getValByVictimType = (row: AnyRow, vt: VictimType): number => {
        let total = 0
        for (const c of conditions) {
            total += getCol(row, vtcCol(vt, c))
        }
        return total
    }
    const getYear = (row: AnyRow): number => {
        const val = row.y
        return typeof val === 'bigint' ? Number(val) : val
    }
    const getMonth = (row: AnyRow): number => {
        const val = row.m
        return typeof val === 'bigint' ? Number(val) : val
    }
    const getCc = (row: YmccsRow | YmccmcsRow): number => {
        const val = row.cc
        return typeof val === 'bigint' ? Number(val) : val
    }
    const getMc = (row: YmccmcsRow): number => {
        const val = row.mc
        return typeof val === 'bigint' ? Number(val) : Math.round(val)
    }

    // Build traces from data
    const { traces, layout } = useMemo(() => {
        if (!data || data.length === 0) return { traces: [], layout: {} }

        // Filter data by valid years, severity, county, and municipality
        let filtered: typeof data
        if (hasMuniFilter) {
            // Per-county ymccmcs data: already filtered to one county, just filter mc + severity
            filtered = data.filter(row => {
                if (getYear(row) > EndYear) return false
                const r = row as YmccmcsRow
                return getMc(r) === mc && severities.includes(r.s)
            })
        } else if (effectiveStackBy === 'municipality') {
            // Muni stacking at county level: ymccmcs data, filter severity + selected munis
            filtered = data.filter(row => {
                if (getYear(row) > EndYear) return false
                if (!('s' in row) || !severities.includes((row as YmccmcsRow).s)) return false
                return selectedMunis.length === 0 || selectedMunis.includes(getMc(row as YmccmcsRow))
            })
        } else {
            filtered = data.filter(row => 's' in row && severities.includes((row as YmsRow).s) && getYear(row) <= EndYear)
            // Only filter by county when NOT stacking by county
            const filterByCounty = counties.length < ALL_COUNTIES.length && effectiveStackBy !== 'county'
            if (filterByCounty && data.length > 0 && 'cc' in data[0]) {
                filtered = filtered.filter(row => counties.includes(getCc(row as YmccsRow)))
            }
            // Filter by selected munis when on county page with muni picker and ymccmcs data
            if (hasMuniPicker && needsMuniData && selectedMunis.length > 0 && data.length > 0 && 'mc' in data[0]) {
                filtered = filtered.filter(row => selectedMunis.includes(getMc(row as YmccmcsRow)))
            }
        }

        const traces: Partial<PlotData>[] = []

        // Format number with adaptive precision (2 significant figures)
        const formatK = (n: number): string => {
            if (n >= 10000) return `${Math.round(n / 1000)}k`
            if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
            return String(Math.round(n))
        }

        // Contrast-aware text color for inside-bar labels: pick black or white
        // based on the bar fill's perceptual luminance (WCAG-style).
        const contrastTextFor = (fill: string | undefined): string => {
            if (!fill) return plotColors.textColor
            const m = /^#?([0-9a-f]{6})$/i.exec(fill.replace('#', ''))
            if (!m) return plotColors.textColor
            const hex = m[1]
            const r = parseInt(hex.slice(0, 2), 16) / 255
            const g = parseInt(hex.slice(2, 4), 16) / 255
            const b = parseInt(hex.slice(4, 6), 16) / 255
            // Relative luminance (sRGB)
            const lin = (c: number) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
            const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
            return L > 0.5 ? '#111' : '#fff'
        }

        // Helper to build a trace from grouped data
        const isPercentMode = stackPercent && effectiveStackBy !== 'none'
        const buildTrace = (
            grouped: Map<string, number>,
            name: string,
            color?: string,
            originalGrouped?: Map<string, number>,  // Raw counts when in percent mode
        ): Partial<PlotData> => {
            const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            const ys = sorted.map(([, v]) => v)
            // Format text labels: percentages (rounded) or counts
            const textLabels = isPercentMode
                ? ys.map(v => `${Math.round(v)}%`)
                : ys.map(formatK)
            // Get original counts for hover display when in percent mode
            const originalCounts = originalGrouped
                ? sorted.map(([k]) => originalGrouped.get(k) || 0)
                : undefined
            const isStacking = effectiveStackBy !== 'none'
            // Inside-bar labels need contrast vs the bar fill; outside labels
            // sit on the plot bg so they use the theme font color.
            const labelColor = isStacking ? contrastTextFor(color) : plotColors.textColor
            return {
                x: sorted.map(([k]) => timeGranularity === 'month' ? k : parseInt(k)),
                y: ys,
                type: 'bar',
                name,
                // Inside-segment labels when stacking; outside-bar labels when single-series
                // (Plotly auto-extends y-axis to fit outside text, avoiding the dark-on-red
                // legibility problem when annotations get clipped onto the bar top.)
                text: timeGranularity === 'year' ? textLabels : undefined,
                textposition: isStacking ? 'inside' : 'outside',
                textangle: 0,
                textfont: { size: 9, color: labelColor },
                // Store original counts in customdata for hover display
                ...(originalCounts ? { customdata: originalCounts } : {}),
                hovertemplate: isPercentMode
                    ? `${name}: %{y:.1f}% (%{customdata:,})<extra></extra>`
                    : `${name}: %{y:,}<extra></extra>`,
                ...(color ? { marker: { color } } : {}),
            }
        }

        // Calculate totals per time period for percentage mode
        const totalsPerPeriod = new Map<string, number>()
        if (stackPercent && effectiveStackBy !== 'none') {
            for (const row of filtered) {
                const key = timeGranularity === 'month'
                    ? toYM(getYear(row), getMonth(row))
                    : String(getYear(row))
                const val = getVal(row)
                totalsPerPeriod.set(key, (totalsPerPeriod.get(key) || 0) + val)
            }
        }

        if (effectiveStackBy === 'none') {
            // Single trace, aggregate across all
            const grouped = new Map<string, number>()
            for (const row of filtered) {
                const key = timeGranularity === 'month'
                    ? toYM(getYear(row), getMonth(row))
                    : String(getYear(row))
                grouped.set(key, (grouped.get(key) || 0) + getVal(row))
            }
            traces.push(buildTrace(grouped, 'Total', '#636EFA'))
        } else if (effectiveStackBy === 'severity') {
            // Stack by severity (only show selected severities)
            const sevFiltered = filtered as (YmsRow | YmccsRow | YmccmcsRow)[]
            for (const sev of Severities) {
                if (!severities.includes(sev)) continue
                const sevData = sevFiltered.filter(row => row.s === sev)
                const grouped = new Map<string, number>()
                for (const row of sevData) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row))
                }
                // Save original counts for hover display before converting to percentages
                const originalGrouped = stackPercent ? new Map(grouped) : undefined
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, SeverityLabels[sev], SeverityColors[sev], originalGrouped))
            }
        } else if (effectiveStackBy === 'county') {
            // Stack by county (selected counties, sorted by total)
            // ymccs data always has cc column
            const countyTotals = new Map<number, number>()
            for (const row of filtered) {
                const cc = (row as any).cc
                if (cc !== undefined) {
                    const ccNum = typeof cc === 'bigint' ? Number(cc) : cc
                    // Only include selected counties
                    if (counties.includes(ccNum)) {
                        countyTotals.set(ccNum, (countyTotals.get(ccNum) || 0) + getVal(row))
                    }
                }
            }
            const sortedCounties = [...countyTotals.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([cc]) => cc)

            for (const cc of sortedCounties) {
                const ccData = filtered.filter(row => {
                    const rowCc = (row as any).cc
                    if (rowCc === undefined) return false
                    const rowCcNum = typeof rowCc === 'bigint' ? Number(rowCc) : rowCc
                    return rowCcNum === cc
                })
                const grouped = new Map<string, number>()
                for (const row of ccData) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row))
                }
                // Save original counts for hover display before converting to percentages
                const originalGrouped = stackPercent ? new Map(grouped) : undefined
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, Counties[cc] || `County ${cc}`, undefined, originalGrouped))
            }
        } else if (effectiveStackBy === 'municipality') {
            // Stack by municipality (single county, sorted by total)
            const mc2mn = cc2mc2mn?.[counties[0]]?.mc2mn || {}
            const muniTotals = new Map<number, number>()
            for (const row of filtered) {
                const mcVal = getMc(row as YmccmcsRow)
                muniTotals.set(mcVal, (muniTotals.get(mcVal) || 0) + getVal(row))
            }
            const sortedMunis = [...muniTotals.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([mcVal]) => mcVal)

            for (const mcVal of sortedMunis) {
                const mcData = filtered.filter(row => getMc(row as YmccmcsRow) === mcVal)
                const grouped = new Map<string, number>()
                for (const row of mcData) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row))
                }
                const originalGrouped = stackPercent ? new Map(grouped) : undefined
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                const muniName = mc2mn[mcVal] || `Muni ${mcVal}`
                traces.push(buildTrace(grouped, muniName, undefined, originalGrouped))
            }
        } else if (effectiveStackBy === 'condition') {
            // Stack by person-level injury condition (5 levels). Only valid
            // for measure='people'; the trace value sums VTC cells across
            // selected Victim Types for one Condition at a time.
            for (const c of Conditions) {
                if (!conditions.includes(c)) continue
                const grouped = new Map<string, number>()
                for (const row of filtered) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    grouped.set(key, (grouped.get(key) || 0) + getValByCondition(row, c))
                }
                const originalGrouped = stackPercent ? new Map(grouped) : undefined
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, ConditionLabels[c], ConditionColors[c], originalGrouped))
            }
        } else if (effectiveStackBy === 'victim_type') {
            // Stack by Victim Type (5 categories). Only valid for
            // measure='people'; the trace value sums VTC cells across
            // selected Conditions for one Victim Type at a time.
            for (const vt of VictimTypes) {
                if (!victimTypes.includes(vt)) continue
                const grouped = new Map<string, number>()
                for (const row of filtered) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    grouped.set(key, (grouped.get(key) || 0) + getValByVictimType(row, vt))
                }
                const originalGrouped = stackPercent ? new Map(grouped) : undefined
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, VictimTypeLabels[vt], VictimTypeColors[vt], originalGrouped))
            }
        }

        // Add 12month moving average lines for monthly view (when stack is none or severity)
        if (show12moAvg && timeGranularity === 'month' && (effectiveStackBy === 'none' || effectiveStackBy === 'severity')) {
            const firstTrace = traces[0]
            if (firstTrace && firstTrace.x) {
                const x = firstTrace.x as string[]

                // Compute 12mo avg helper
                const compute12moAvg = (ys: number[]): (number | null)[] => {
                    const avgY: (number | null)[] = []
                    for (let i = 0; i < ys.length; i++) {
                        if (i < 11) {
                            avgY.push(null)
                        } else {
                            const window = ys.slice(i - 11, i + 1)
                            avgY.push(window.reduce((a, b) => a + b, 0) / 12)
                        }
                    }
                    return avgY
                }

                // Add 12mo avg line for each bar trace
                const barTraces = traces.filter(t => t.type === 'bar' && t.y)
                for (const trace of barTraces) {
                    const ys = trace.y as number[]
                    const baseColor = trace.marker?.color as string || '#888'
                    const lineColor = lightenColor(baseColor)
                    traces.push({
                        x,
                        y: compute12moAvg(ys),
                        type: 'scatter',
                        mode: 'lines',
                        name: `${trace.name} (12mo)`,
                        legendgroup: trace.name,
                        showlegend: false,
                        line: { color: lineColor, width: 3.5 },
                        hovertemplate: `${trace.name} (12mo): %{y:,.0f}<extra></extra>`,
                    })
                }

                // Add total 12mo avg line if multiple traces
                if (barTraces.length > 1) {
                    const totals: number[] = new Array(x.length).fill(0)
                    for (const trace of barTraces) {
                        const ys = trace.y as number[]
                        for (let i = 0; i < ys.length; i++) {
                            totals[i] += ys[i] || 0
                        }
                    }
                    traces.push({
                        x,
                        y: compute12moAvg(totals),
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Total (12mo)',
                        showlegend: false,
                        line: { color: plotColors.textColor, width: 2.5 },
                        hovertemplate: 'Total (12mo): %{y:,.0f}<extra></extra>',
                    })
                }
            }
        }

        // Inject page-annotation shapes/icons (e.g. shade years with known data gaps)
        const { shapes: annShapes, annotations: annTextEls } = toPlotLayers(plotAnnotations)

        // Compute totals for annotations (only when few enough bars to label, not in percentage mode)
        const annotations: Layout['annotations'] = [...annTextEls]
        // Count unique x values to determine if we should annotate
        const uniqueXValues = new Set(traces.flatMap(t => t.x as (string | number)[] || []))
        // Outer annotations show stacked-bar TOTALS (single-series labels are
        // handled via trace.text 'outside' position above).
        const shouldAnnotate = !stackPercent && activeTrace === null && uniqueXValues.size <= 30 && effectiveStackBy !== 'none'
        if (shouldAnnotate) {
            // Sum across all traces for each x value
            const periodTotals = new Map<string | number, number>()
            for (const trace of traces) {
                if (!trace.x || !trace.y) continue
                const xs = trace.x as (string | number)[]
                const ys = trace.y as number[]
                for (let i = 0; i < xs.length; i++) {
                    const x = xs[i]
                    const y = ys[i] || 0
                    periodTotals.set(x, (periodTotals.get(x) || 0) + y)
                }
            }
            for (const [x, total] of periodTotals) {
                annotations.push({
                    x,
                    y: total,
                    text: formatK(total),
                    showarrow: false,
                    yshift: 10,
                    font: { color: plotColors.textColor, size: 10 },
                })
            }
        }

        const layout: Partial<Layout> = {
            barmode: effectiveStackBy !== 'none' ? 'stack' : undefined,
            barnorm: stackPercent && effectiveStackBy !== 'none' ? 'percent' : undefined,
            height,
            margin: { t: 20, b: 40, l: 60, r: 20 },
            xaxis: {
                showspikes: false,
                dtick: timeGranularity === 'year' ? 1 : undefined,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
                tickangle: -45,
                // Format years as 'yy when in year granularity; show all years in range
                // (including empty ones) so tick density is consistent across geos.
                ...(timeGranularity === 'year' ? (() => {
                    const years = Array.from(
                        { length: EndYear - StartYear + 1 },
                        (_, i) => StartYear + i,
                    )
                    return {
                        range: [StartYear - 0.5, EndYear + 0.5],
                        tickvals: years,
                        ticktext: years.map(y => `'${String(y).slice(2)}`),
                    }
                })() : {}),
            },
            yaxis: {
                gridcolor: plotColors.gridColor,
                tickfont: { color: plotColors.textColor },
                fixedrange: true,
            },
            dragmode: false,
            showlegend: true,
            legend: {
                orientation: 'h' as const,
                traceorder: 'reversed' as const,
                y: -0.08,
                x: 0.5,
                xanchor: 'center' as const,
                yanchor: 'top' as const,
                font: { color: plotColors.textColor },
            },
            hovermode: 'x unified',
            hoverlabel: {
                bgcolor: isDark ? 'rgba(20, 22, 34, 0.98)' : 'rgba(252, 252, 255, 0.98)',
                bordercolor: plotColors.gridColor,
                font: { color: plotColors.textColor, size: 13, family: 'system-ui, sans-serif' },
                align: 'left',
            },
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            annotations,
            shapes: annShapes,
        }

        // Solo mode: when a trace is click-pinned as active, hide others. This
        // is the "solo" behavior — only fires on click (hover uses pltly's
        // built-in opacity fade; the no-flicker fix is `boldWeight="normal"`
        // passed to PlotWrapper, which stops legend text from reflowing).
        if (activeTrace) {
            for (const trace of traces) {
                const isActive = trace.name === activeTrace || trace.legendgroup === activeTrace
                trace.visible = isActive ? true : 'legendonly'
            }
        }

        return { traces, layout }
    }, [data, effectiveStackBy, severities, conditions, victimTypes, measure, counties, mc, selectedMunis, timeGranularity, stackPercent, show12moAvg, height, needsCountyData, activeTrace, plotColors, isDark, cc2mc2mn, plotAnnotations])

    // Check if we're waiting for county data (need ymccs but have yms)
    const waitingForCountyData = needsCountyData && data && data.length > 0 && !('cc' in data[0])

    if (loading || waitingForCountyData) {
        return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Loading crash data...
        </div>
    }

    if (error) {
        return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'red' }}>
            Error: {error}
        </div>
    }

    // Check for empty selections - enumerate all empty facets
    const emptyFacets: string[] = []
    if (counties.length === 0) emptyFacets.push("counties")
    if (hasMuniPicker && selectedMunis.length === 0) emptyFacets.push("municipalities")
    if (severities.length === 0) emptyFacets.push("severity levels")
    const emptySelection = emptyFacets.length > 0
        ? `Select one or more ${emptyFacets.join(" and ")} to view data.`
        : null

    // Key forces remount when data source changes (include data length to wait for load)
    const plotKey = `${source}-${data?.length || 0}`

    return (
        <div>
            <div style={{ minHeight: height }}>
                {emptySelection ? (
                    <div style={{
                        height,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: plotColors.textColor,
                        fontSize: '1.1em',
                        opacity: 0.7,
                    }}>
                        {emptySelection}
                    </div>
                ) : (
                    <PlotWrapper
                        key={plotKey}
                        data={traces as PlotData[]}
                        layout={layout}
                        onActiveTrace={setActiveTrace}
                        onHover={handleHover}
                        onUnhover={handleUnhover}
                        onClickAnnotation={() => annOpen.setPinned(!annOpen.pinned)}
                        onHoverAnnotation={() => annOpen.setHovered(true)}
                        onUnhoverAnnotation={() => annOpen.setHovered(false)}
                        disableFade
                        boldWeight="normal"
                    />
                )}
            </div>
            {showControls && (
                <ControlsGear
                    open={controlsOpen}
                    onToggle={setControlsOpen}
                    contentClassName={css.controlsContent}
                    inlineWithLegend
                    extra={<AnnotationTrigger annotations={plotAnnotations} state={annOpen} />}
                >
                    <Radios
                        label="Measure"
                        name="measure"
                        options={MeasureKinds.map(m => ({
                            label: <Tooltip title={MeasureKindDefs[m]}><span>{MeasureKindLabels[m]}</span></Tooltip>,
                            data: m,
                        }))}
                        choice={measure}
                        cb={setMeasure}
                    />
                    <Radios
                        label="Stack By"
                        name="stackBy"
                        options={[
                            { label: 'None', data: 'none' as StackBy },
                            { label: 'Severity', data: 'severity' as StackBy },
                            { label: 'Condition', data: 'condition' as StackBy, disabled: measure !== 'people' },
                            { label: 'Victim Type', data: 'victim_type' as StackBy, disabled: measure !== 'people' },
                            ...(!hasMuniFilter ? [{ label: 'County', data: 'county' as StackBy }] : []),
                            ...(isSingleCounty && !hasMuniFilter ? [{ label: 'Municipality', data: 'municipality' as StackBy }] : []),
                        ]}
                        choice={stackBy}
                        cb={setStackBy}
                    />
                    <Radios
                        label="Time"
                        name="time"
                        options={[
                            { label: 'By Year', data: 'year' as const },
                            { label: 'By Month', data: 'month' as const },
                        ]}
                        choice={timeGranularity}
                        cb={setTimeGranularity}
                    />
                    <Checklist
                        label={<Tooltip title="Crash-level severity (NJTR-1 / AASHTO). Filters which crash rows are included for every measure."><span>Severity</span></Tooltip>}
                        data={Severities.map(s => ({
                            name: s,
                            label: <Tooltip title={SeverityDefs[s]}><span>{SeverityLabels[s]}</span></Tooltip>,
                            data: s,
                            checked: severities.includes(s),
                            // Only show color swatches when stacking by severity
                            ...(stackBy === 'severity' && { color: SeverityColors[s] }),
                        }))}
                        cb={setSeverities}
                    />
                    {measure === 'people' && (
                        <Checklist
                            label={<Tooltip title="Person-level injury severity (KABCO scale, per NJTR-1). Filters which cells of the victim-type × condition matrix are summed."><span>Condition</span></Tooltip>}
                            data={Conditions.map(c => ({
                                name: c,
                                label: <Tooltip title={ConditionDefs[c]}><span>{ConditionLabels[c]}</span></Tooltip>,
                                data: c,
                                checked: conditions.includes(c),
                                ...(stackBy === 'condition' && { color: ConditionColors[c] }),
                            }))}
                            cb={setConditions}
                        />
                    )}
                    {measure === 'people' && (
                        <Checklist
                            label={<Tooltip title="Who was involved. Filters the victim-type × condition matrix."><span>Victim Type</span></Tooltip>}
                            data={VictimTypes.map(vt => ({
                                name: vt,
                                label: <Tooltip title={VictimTypeDefs[vt]}><span>{VictimTypeLabels[vt]}</span></Tooltip>,
                                data: vt,
                                checked: victimTypes.includes(vt),
                                ...(stackBy === 'victim_type' && { color: VictimTypeColors[vt] }),
                            }))}
                            cb={setVictimTypes}
                        />
                    )}
                    {!hasMuniFilter && !isSingleCounty && (
                        <CountyDropdown
                            selected={counties}
                            onChange={setCounties}
                        />
                    )}
                    {!hasMuniFilter && isSingleCounty && mc2mn && (
                        <MunicipalityDropdown
                            mc2mn={mc2mn}
                            selected={selectedMunis}
                            onChange={setSelectedMunis}
                        />
                    )}
                    <div className={css.control}>
                        <div className={css.controlHeader}>Options</div>
                        <label className={css.nowrap}>
                            <input
                                type="checkbox"
                                checked={stackPercent}
                                onChange={(e) => setStackPercent(e.target.checked)}
                                disabled={stackBy === 'none'}
                            />
                            Stack %
                        </label>
                        <Tooltip title={timeGranularity !== 'month' ? "Only available in monthly view" : stackBy === 'county' ? "Not available when stacking by county" : undefined}>
                            <label className={css.nowrap}>
                                <input
                                    type="checkbox"
                                    checked={show12moAvg}
                                    onChange={(e) => setShow12moAvg(e.target.checked)}
                                    disabled={timeGranularity !== 'month' || (stackBy !== 'none' && stackBy !== 'severity')}
                                />
                                12mo avg
                            </label>
                        </Tooltip>
                    </div>
                </ControlsGear>
            )}
            <AnnotationBody annotations={plotAnnotations} state={annOpen} />
            {timing && (
                <div className={css.plotInfo}>
                    Loaded {data?.length.toLocaleString()} rows in {timing.totalMs.toFixed(0)}ms
                    ({(timing.bytes / 1024).toFixed(1)} KB)
                </div>
            )}
        </div>
    )
}

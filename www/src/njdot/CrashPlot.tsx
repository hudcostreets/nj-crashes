import { useEffect, useMemo, useState } from "react"
import { EndYear } from "@/src/constants"
import { Layout, PlotData } from "plotly.js"
import { lightenColor, useTheme } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { useParquet } from "@/src/lib/useParquet"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import {
    YmsRow, YmccsRow, YmccmcsRow,
    Severity, Severities, SeverityLabels, SeverityColorsLight, SeverityColorsDark,
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
    // Hard-coded to count crashes (not victims) for now
    // TODO: Add proper victim counting as a separate feature
    const measure = 'n' as const
    const [stackBy, setStackBy] = useSessionStorage<StackBy>('crashplot-stackBy', initialStackBy)
    const [severities, setSeverities] = useSessionStorage<Severity[]>('crashplot-severities', initialSeverities)
    const [counties, setCounties] = useSessionStorage<number[]>('crashplot-counties', initialCounties)
    // Sync with external counties prop (geo filter)
    useEffect(() => { setCounties(initialCounties) }, [initialCounties.join(',')])
    const [timeGranularity, setTimeGranularity] = useSessionStorage<'year' | 'month'>('crashplot-timeGranularity', initialTimeGranularity)
    const [stackPercent, setStackPercent] = useSessionStorage('crashplot-stackPercent', false)
    const [show12moAvg, setShow12moAvg] = useSessionStorage('crashplot-show12moAvg', false)
    const [controlsOpen, setControlsOpen] = useSessionStorage('crashplot-controls-open', initialControlsOpen)

    const [activeTrace, setActiveTrace] = useState<string | null>(null)
    const { isDark } = useTheme()
    const SeverityColors = isDark ? SeverityColorsDark : SeverityColorsLight
    const plotColors = usePlotColors()

    const { cc2mc2mn } = useGeoFilter()
    const hasMuniFilter = mc !== null
    const isSingleCounty = counties.length === 1

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
    // Municipality filter: disable county/muni stacking; single-county: disable county stacking
    const effectiveStackBy = hasMuniFilter && (stackBy === 'county' || stackBy === 'municipality') ? 'none'
        : !isSingleCounty && stackBy === 'municipality' ? 'none'
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
    const getVal = (row: AnyRow, key: 'n'): number => {
        const val = row[key]
        return typeof val === 'bigint' ? Number(val) : val
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
            return {
                x: sorted.map(([k]) => timeGranularity === 'month' ? k : parseInt(k)),
                y: ys,
                type: 'bar',
                name,
                // Only show inner-bar text when stacking (not for 'none' which has outer annotations)
                text: timeGranularity === 'year' && effectiveStackBy !== 'none' ? textLabels : undefined,
                textposition: 'inside',
                textangle: 0,
                textfont: { size: 9 },
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
                const val = getVal(row, measure)
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
                grouped.set(key, (grouped.get(key) || 0) + getVal(row, measure))
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
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row, measure))
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
                        countyTotals.set(ccNum, (countyTotals.get(ccNum) || 0) + getVal(row, measure))
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
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row, measure))
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
                muniTotals.set(mcVal, (muniTotals.get(mcVal) || 0) + getVal(row, measure))
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
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row, measure))
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

        // Compute totals for annotations (only when few enough bars to label, not in percentage mode)
        const annotations: Layout['annotations'] = []
        // Count unique x values to determine if we should annotate
        const uniqueXValues = new Set(traces.flatMap(t => t.x as (string | number)[] || []))
        const shouldAnnotate = !stackPercent && activeTrace === null && uniqueXValues.size <= 30
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
                // Format years as 'yy when in year granularity
                ...(timeGranularity === 'year' && traces.length > 0 && traces[0].x ? {
                    tickvals: traces[0].x as number[],
                    ticktext: (traces[0].x as number[]).map(y => `'${String(y).slice(2)}`),
                } : {}),
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
                traceorder: 'normal' as const,
                y: -0.08,
                x: 0.5,
                xanchor: 'center' as const,
                yanchor: 'top' as const,
                font: { color: plotColors.textColor },
            },
            hovermode: 'x unified',
            hoverlabel: {
                bgcolor: plotColors.legendBg,
                bordercolor: plotColors.gridColor,
                font: { color: plotColors.textColor },
            },
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            annotations,
        }

        return { traces, layout }
    }, [data, effectiveStackBy, severities, counties, mc, selectedMunis, timeGranularity, stackPercent, show12moAvg, height, needsCountyData, activeTrace, plotColors, isDark, cc2mc2mn])

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
                    />
                )}
            </div>
            {showControls && (
                <ControlsGear open={controlsOpen} onToggle={setControlsOpen} contentClassName={css.controlsContent} inlineWithLegend>
                    <Radios
                        label="Stack By"
                        name="stackBy"
                        options={[
                            { label: 'None', data: 'none' as StackBy },
                            { label: 'Severity', data: 'severity' as StackBy },
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
                        label="Severity"
                        data={Severities.map(s => ({
                            name: s,
                            label: SeverityLabels[s],
                            data: s,
                            checked: severities.includes(s),
                            // Only show color swatches when stacking by severity
                            ...(stackBy === 'severity' && { color: SeverityColors[s] }),
                        }))}
                        cb={setSeverities}
                    />
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
            {timing && (
                <div className={css.plotInfo}>
                    Loaded {data?.length.toLocaleString()} rows in {timing.totalMs.toFixed(0)}ms
                    ({(timing.bytes / 1024).toFixed(1)} KB)
                </div>
            )}
        </div>
    )
}

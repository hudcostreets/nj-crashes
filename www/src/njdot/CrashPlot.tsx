import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EndYear } from "@/src/constants"
import { Layout, PlotData } from "plotly.js"
import Plot from "react-plotly.js"
import { useParquet } from "@/src/lib/useParquet"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import {
    YmsRow, YmccsRow,
    Severity, Severities, SeverityLabels, SeverityColors,
    VictimType, VictimTypes, VictimTypeLabels, VictimTypeColors,
    Condition, Conditions, ConditionLabels, ConditionColors,
    VTC_COLS, vtcCol, VTCCol,
    Measure, MeasureLabels,
    Counties,
    StackBy,
    toYM,
} from "./data"
import { Checklist } from "./Checklist"
import { Radios } from "./Radios"
import { CountyDropdown } from "./CountyDropdown"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import css from "./controls.module.css"

type CrashPlotProps = {
    /** Measure to plot on Y-axis */
    measure?: Measure
    /** Stack by dimension */
    stackBy?: StackBy
    /** Filter to specific severities */
    severities?: Severity[]
    /** Filter to specific county codes */
    counties?: number[]
    /** Filter to specific victim types */
    victimTypes?: VictimType[]
    /** Filter to specific conditions */
    conditions?: Condition[]
    /** Time granularity */
    timeGranularity?: 'year' | 'month'
    /** Chart height */
    height?: number
    /** Show controls drawer */
    showControls?: boolean
    /** Start with controls open */
    controlsOpen?: boolean
}

const DEFAULT_HEIGHT = 450
const ALL_COUNTIES = Object.keys(Counties).map(Number)

export default function CrashPlot({
    measure: initialMeasure = 'n',
    stackBy: initialStackBy = 'severity',
    severities: initialSeverities = [...Severities],
    counties: initialCounties = ALL_COUNTIES,
    victimTypes: initialVictimTypes = [...VictimTypes],
    conditions: initialConditions = [...Conditions],
    timeGranularity: initialTimeGranularity = 'year',
    height = DEFAULT_HEIGHT,
    showControls = true,
    controlsOpen: initialControlsOpen = false,
}: CrashPlotProps) {
    // State for controls - persisted in sessionStorage
    const [measure, setMeasure] = useSessionStorage<Measure>('crashplot-measure', initialMeasure)
    const [stackBy, setStackBy] = useSessionStorage<StackBy>('crashplot-stackBy', initialStackBy)
    const [severities, setSeverities] = useSessionStorage<Severity[]>('crashplot-severities', initialSeverities)
    const [counties, setCounties] = useSessionStorage<number[]>('crashplot-counties', initialCounties)
    const [victimTypes, setVictimTypes] = useSessionStorage<VictimType[]>('crashplot-victimTypes', initialVictimTypes)
    const [conditions, setConditions] = useSessionStorage<Condition[]>('crashplot-conditions', initialConditions)
    const [timeGranularity, setTimeGranularity] = useSessionStorage<'year' | 'month'>('crashplot-timeGranularity', initialTimeGranularity)
    const [stackPercent, setStackPercent] = useSessionStorage('crashplot-stackPercent', false)
    const [show12moAvg, setShow12moAvg] = useSessionStorage('crashplot-show12moAvg', false)
    const [controlsOpen, setControlsOpen] = useSessionStorage('crashplot-controls-open', initialControlsOpen)

    // Legend interaction state
    const [soloTrace, setSoloTrace] = useState<string | null>(null)
    const [hoverTrace, setHoverTrace] = useState<string | null>(null)
    const activeTrace = hoverTrace ?? soloTrace
    const plotRef = useRef<HTMLDivElement>(null)
    const plotColors = usePlotColors()

    // Reset solo trace when stacking mode changes (trace names change)
    useEffect(() => {
        setSoloTrace(null)
        setHoverTrace(null)
    }, [stackBy])

    // Use yms for state-level, ymccs for county breakdowns
    const needsCountyData = stackBy === 'county' || counties.length < ALL_COUNTIES.length
    const source = needsCountyData ? 'ymccs' : 'yms'

    const url = `/data/njdot/${source}.parquet`
    const { data, loading, error, timing } = useParquet<YmsRow | YmccsRow>(url)

    // Helper to get numeric value from row (handles BigInt)
    const getVal = (row: YmsRow | YmccsRow, key: Measure): number => {
        const val = row[key]
        return typeof val === 'bigint' ? Number(val) : val
    }

    const getYear = (row: YmsRow | YmccsRow): number => {
        const val = row.y
        return typeof val === 'bigint' ? Number(val) : val
    }

    const getMonth = (row: YmsRow | YmccsRow): number => {
        const val = row.m
        return typeof val === 'bigint' ? Number(val) : val
    }

    const getCc = (row: YmccsRow): number => {
        const val = row.cc
        return typeof val === 'bigint' ? Number(val) : val
    }

    // Helper to get sum of selected VTC columns from a row
    const getVtcSum = (row: YmsRow | YmccsRow, vts: VictimType[], conds: Condition[]): number => {
        let sum = 0
        for (const vt of vts) {
            for (const c of conds) {
                const col = vtcCol(vt, c) as keyof typeof row
                const val = row[col]
                if (val !== undefined) {
                    sum += typeof val === 'bigint' ? Number(val) : (val as number)
                }
            }
        }
        return sum
    }

    // Build traces from data
    const { traces, layout } = useMemo(() => {
        if (!data || data.length === 0) return { traces: [], layout: {} }

        // Filter data by severity, county, and valid years
        let filtered = data.filter(row => severities.includes(row.s) && getYear(row) <= EndYear)
        // Only filter by county when NOT stacking by county (i.e., when filtering to specific counties)
        const filterByCounty = counties.length < ALL_COUNTIES.length && stackBy !== 'county'
        if (filterByCounty && data.length > 0 && 'cc' in data[0]) {
            filtered = filtered.filter(row => {
                return counties.includes(getCc(row as YmccsRow))
            })
        }

        const traces: Partial<PlotData>[] = []

        // Format number as "Xk" for thousands
        const formatK = (n: number): string => {
            if (n >= 1000) return `${Math.round(n / 1000)}k`
            return String(Math.round(n))
        }

        // Helper to build a trace from grouped data
        const buildTrace = (
            grouped: Map<string, number>,
            name: string,
            color?: string,
        ): Partial<PlotData> => {
            const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            // Apply visibility based on active trace (solo/hover)
            const visible = activeTrace === null || activeTrace === name ? true : 'legendonly'
            const ys = sorted.map(([, v]) => v)
            return {
                x: sorted.map(([k]) => timeGranularity === 'month' ? k : parseInt(k)),
                y: ys,
                type: 'bar',
                name,
                visible,
                // Only show inner-bar text when stacking (not for 'none' which has outer annotations)
                text: timeGranularity === 'year' && stackBy !== 'none' ? ys.map(formatK) : undefined,
                textposition: 'inside',
                textangle: 0,
                textfont: { size: 9 },
                hovertemplate: `${name}: %{y:,}<extra></extra>`,
                ...(color ? { marker: { color } } : {}),
            }
        }

        // Calculate totals per time period for percentage mode
        const totalsPerPeriod = new Map<string, number>()
        if (stackPercent && stackBy !== 'none') {
            for (const row of filtered) {
                const key = timeGranularity === 'month'
                    ? toYM(getYear(row), getMonth(row))
                    : String(getYear(row))
                // Use VTC sum for victim_type/condition stacking, otherwise use measure
                const val = (stackBy === 'victim_type' || stackBy === 'condition')
                    ? getVtcSum(row, victimTypes, conditions)
                    : getVal(row, measure)
                totalsPerPeriod.set(key, (totalsPerPeriod.get(key) || 0) + val)
            }
        }

        if (stackBy === 'none') {
            // Single trace, aggregate across all
            const grouped = new Map<string, number>()
            for (const row of filtered) {
                const key = timeGranularity === 'month'
                    ? toYM(getYear(row), getMonth(row))
                    : String(getYear(row))
                grouped.set(key, (grouped.get(key) || 0) + getVal(row, measure))
            }
            traces.push(buildTrace(grouped, 'Total', '#636EFA'))
        } else if (stackBy === 'severity') {
            // Stack by severity (only show selected severities)
            for (const sev of Severities) {
                if (!severities.includes(sev)) continue
                const sevData = filtered.filter(row => row.s === sev)
                const grouped = new Map<string, number>()
                for (const row of sevData) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    grouped.set(key, (grouped.get(key) || 0) + getVal(row, measure))
                }
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, SeverityLabels[sev], SeverityColors[sev]))
            }
        } else if (stackBy === 'county') {
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
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, Counties[cc] || `County ${cc}`))
            }
        } else if (stackBy === 'victim_type') {
            // Stack by victim type - sum VTC columns for selected conditions
            for (const vt of VictimTypes) {
                if (!victimTypes.includes(vt)) continue
                const grouped = new Map<string, number>()
                for (const row of filtered) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    // Sum all condition columns for this victim type
                    const val = getVtcSum(row, [vt], conditions)
                    grouped.set(key, (grouped.get(key) || 0) + val)
                }
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, VictimTypeLabels[vt], VictimTypeColors[vt]))
            }
        } else if (stackBy === 'condition') {
            // Stack by condition - sum VTC columns for selected victim types
            for (const c of Conditions) {
                if (!conditions.includes(c)) continue
                const grouped = new Map<string, number>()
                for (const row of filtered) {
                    const key = timeGranularity === 'month'
                        ? toYM(getYear(row), getMonth(row))
                        : String(getYear(row))
                    // Sum all victim type columns for this condition
                    const val = getVtcSum(row, victimTypes, [c])
                    grouped.set(key, (grouped.get(key) || 0) + val)
                }
                if (stackPercent) {
                    for (const [key, val] of grouped) {
                        const total = totalsPerPeriod.get(key) || 1
                        grouped.set(key, (val / total) * 100)
                    }
                }
                traces.push(buildTrace(grouped, ConditionLabels[c], ConditionColors[c]))
            }
        }

        // Add 12-month moving average lines for monthly view (when stack is none or severity)
        if (show12moAvg && timeGranularity === 'month' && (stackBy === 'none' || stackBy === 'severity')) {
            const firstTrace = traces[0]
            if (firstTrace && firstTrace.x) {
                const x = firstTrace.x as string[]

                // Compute 12-mo avg helper
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

                // Lighten color for 12-mo avg line
                const lightenColor = (hex: string): string => {
                    // Convert hex to RGB, lighten, convert back
                    const r = parseInt(hex.slice(1, 3), 16)
                    const g = parseInt(hex.slice(3, 5), 16)
                    const b = parseInt(hex.slice(5, 7), 16)
                    // Lighten by blending with white
                    const factor = 0.4
                    const lr = Math.round(r + (255 - r) * factor)
                    const lg = Math.round(g + (255 - g) * factor)
                    const lb = Math.round(b + (255 - b) * factor)
                    return `rgb(${lr}, ${lg}, ${lb})`
                }

                // Add 12-mo avg line for each bar trace
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
                        name: `${trace.name} (12-mo)`,
                        legendgroup: trace.name,
                        showlegend: false,
                        line: { color: lineColor, width: 3.5 },
                        visible: trace.visible,
                        hovertemplate: `${trace.name} (12-mo): %{y:,.0f}<extra></extra>`,
                    })
                }

                // Add total 12-mo avg line if multiple traces
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
                        name: 'Total (12-mo)',
                        line: { color: '#ffffff', width: 2.5 },
                        hovertemplate: 'Total (12-mo): %{y:,.0f}<extra></extra>',
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
                    text: total >= 1000 ? `${(total / 1000).toFixed(0)}k` : String(Math.round(total)),
                    showarrow: false,
                    yshift: 10,
                    font: { color: plotColors.textColor, size: 10 },
                })
            }
        }

        const layout: Partial<Layout> = {
            barmode: stackBy !== 'none' ? 'stack' : undefined,
            barnorm: stackPercent && stackBy !== 'none' ? 'percent' : undefined,
            height,
            margin: { t: 20, b: 60, l: 60, r: 20 },
            xaxis: {
                showspikes: false,
                dtick: timeGranularity === 'year' ? 1 : undefined,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
            },
            yaxis: {
                gridcolor: plotColors.gridColor,
                tickfont: { color: plotColors.textColor },
                fixedrange: true,
            },
            dragmode: false,
            legend: {
                orientation: 'h',
                y: -0.15,
                x: 0.5,
                xanchor: 'center',
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
    }, [data, measure, stackBy, severities, counties, victimTypes, conditions, timeGranularity, stackPercent, show12moAvg, height, needsCountyData, activeTrace, plotColors])

    // Check if we're waiting for county data (need ymccs but have yms)
    const waitingForCountyData = needsCountyData && data && data.length > 0 && !('cc' in data[0])

    // Legend click handler - toggle solo mode
    const onLegendClick = useCallback((e: any) => {
        const { curveNumber, data: plotData } = e
        const name = plotData[curveNumber]?.name
        if (!name) return true
        if (soloTrace === name) {
            setSoloTrace(null)
            setHoverTrace(null)
        } else {
            setSoloTrace(name)
        }
        return false  // prevent default Plotly behavior
    }, [soloTrace])

    // Legend double-click handler - reset to show all
    const onLegendDoubleClick = useCallback(() => {
        setSoloTrace(null)
        setHoverTrace(null)
        return false  // prevent default Plotly behavior
    }, [])

    // Set up legend hover events via DOM
    useEffect(() => {
        if (!plotRef.current) return

        const legend = plotRef.current.querySelector('.legend')
        if (!legend) return

        const groups = Array.from(legend.querySelectorAll('.traces'))
        const listeners: Array<{ element: Element; type: string; handler: () => void }> = []
        let mouseoutTimeout: ReturnType<typeof setTimeout> | null = null

        // Build set of valid trace names
        const traceNames = new Set(traces.map(t => t.name))

        groups.forEach((group) => {
            // Extract trace name from legend text, not index
            const textEl = group.querySelector('.legendtext')
            const traceName = textEl?.textContent?.trim()
            if (!traceName || !traceNames.has(traceName)) return

            const overHandler = () => {
                // Cancel pending mouseout
                if (mouseoutTimeout) {
                    clearTimeout(mouseoutTimeout)
                    mouseoutTimeout = null
                }
                setHoverTrace(traceName as string)
            }
            const outHandler = () => {
                // Delay mouseout to allow moving between legend items
                mouseoutTimeout = setTimeout(() => {
                    setHoverTrace(null)
                    mouseoutTimeout = null
                }, 100)
            }

            group.addEventListener('mouseover', overHandler)
            group.addEventListener('mouseout', outHandler)

            listeners.push({ element: group, type: 'mouseover', handler: overHandler })
            listeners.push({ element: group, type: 'mouseout', handler: outHandler })
        })

        return () => {
            if (mouseoutTimeout) clearTimeout(mouseoutTimeout)
            listeners.forEach(({ element, type, handler }) => {
                element.removeEventListener(type, handler)
            })
        }
    }, [traces])

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

    // Key forces remount when data source changes (include data length to wait for load)
    const plotKey = `${source}-${data?.length || 0}`


    return (
        <div ref={plotRef}>
            <Plot
              data={traces as PlotData[]}
              layout={layout}
              key={plotKey}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: '100%', height }}
              useResizeHandler
              onLegendClick={onLegendClick}
              onLegendDoubleClick={onLegendDoubleClick}
            />
            {showControls && (
                <details
                    className={css.controls}
                    open={controlsOpen}
                    onToggle={(e) => setControlsOpen((e.target as HTMLDetailsElement).open)}
                >
                    <summary><span className={css.settingsGear}>⚙️</span></summary>
                    <div className={css.controlsContent}>
                        <Radios
                            label="Measure"
                            name="measure"
                            options={[
                                { label: 'Crashes', data: 'n' as Measure },
                                { label: 'Fatalities', data: 'tk' as Measure },
                                { label: 'Injuries', data: 'ti' as Measure },
                                { label: 'Ped. Fatal', data: 'pk' as Measure },
                                { label: 'Ped. Injury', data: 'pi' as Measure },
                            ]}
                            choice={measure}
                            cb={setMeasure}
                        />
                        <Radios
                            label="Stack By"
                            name="stackBy"
                            options={[
                                { label: 'None', data: 'none' as StackBy },
                                { label: 'Severity', data: 'severity' as StackBy },
                                { label: 'County', data: 'county' as StackBy },
                                { label: 'Victim', data: 'victim_type' as StackBy },
                                { label: 'Condition', data: 'condition' as StackBy },
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
                                color: SeverityColors[s],
                            }))}
                            cb={setSeverities}
                        />
                        <Checklist
                            label="Victim Type"
                            data={VictimTypes.map(vt => ({
                                name: vt,
                                label: VictimTypeLabels[vt],
                                data: vt,
                                checked: victimTypes.includes(vt),
                                color: VictimTypeColors[vt],
                            }))}
                            cb={setVictimTypes}
                        />
                        <Checklist
                            label="Condition"
                            data={Conditions.map(c => ({
                                name: c,
                                label: ConditionLabels[c],
                                data: c,
                                checked: conditions.includes(c),
                                color: ConditionColors[c],
                            }))}
                            cb={setConditions}
                        />
                        <CountyDropdown
                            selected={counties}
                            onChange={setCounties}
                        />
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
                            <label className={css.nowrap}>
                                <input
                                    type="checkbox"
                                    checked={show12moAvg}
                                    onChange={(e) => setShow12moAvg(e.target.checked)}
                                    disabled={timeGranularity !== 'month' || (stackBy !== 'none' && stackBy !== 'severity')}
                                />
                                12-mo Avg
                            </label>
                        </div>
                    </div>
                </details>
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

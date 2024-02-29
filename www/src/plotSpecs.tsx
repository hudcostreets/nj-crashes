import React from "react";
import * as Plots from "@rdub/next-plotly/plot";
import A from "@rdub/next-base/a";
import { GitHub } from "./socials";
const { HalfRoundWiden, filterIdxs, filterValues } = Plots

export const curYear = (new Date().getFullYear())
export const prvYear = curYear - 1
export type Year = "2021" | "2022" | typeof prvYear | typeof curYear
export type YearTotalsMap = { [k in Year]: { total: number, projected: number } }
export type Data = {
    rundate: string
    yearTotalsMap: YearTotalsMap
}
export type PlotSpec = Plots.PlotSpec<Data>
export type Plot<TraceName extends string = string> = Plots.Plot<Data, TraceName>
export function Plot<TraceName extends string = string>(args: Plot<TraceName>) { return Plots.Plot<Data, TraceName>(args) }

export const EMPTY: PlotSpec[] = []
export const YM_SC_PID_SPECS: PlotSpec[] =
    EMPTY.concat(...['y', 'm'].map(my =>
        EMPTY.concat(...['s', 'c'].map(sc =>
            EMPTY.concat(...['d', 'i', 'p'].map(t => {
                const id = `${t}${sc}${my}`
                const name = `njdot/${id}`
                const region = { 's': 'State', 'c': 'County' }[sc]
                const freq = { 'y': 'Year', 'm': 'Month' }[my]
                const section = `${{ 's': 'State', 'c': 'Counties' }[sc]} x ${freq}s`
                const type = { 'i': 'Traffic Crash Injuries', 'p': 'Property Damage Crashes', 'd': 'Traffic Deaths' }[t]
                const menuName = { 'i': 'Injuries', 'p': 'Property Damage', 'd': 'Deaths' }[t]
                let title = region == 'State' ? `NJ ${type} per ${freq}` : `NJ ${type} per {${region}, ${freq}}`
                if (id == 'dcm') {
                    title += ` (12mo avgs)`
                }
                return {
                    id, name, title, menuName, dropdownSection: section,
                    style: region == 'County' && { height: 580 },
                } as PlotSpec
            }))
        ))
    ))

export const estimationHref = 'https://nbviewer.org/github/neighbor-ryan/nj-crashes/blob/main/njsp/update-projections.ipynb'

export function NjspChildren({ rundate, yearTotalsMap, includeWorstYearsBlurb }: Data & { includeWorstYearsBlurb?: boolean }) {
    const total2021 = yearTotalsMap["2021"].total
    const total2022 = yearTotalsMap["2022"].total
    const prvYearTotal = yearTotalsMap[prvYear].total
    const curYearMap = yearTotalsMap[curYear]
    if (!curYearMap) {
        console.warn(`NjspChildren: yearTotalsMap doesn't contain ${curYear}:`, yearTotalsMap)
        return null
    }
    const { total: curYearTotal, projected: curYearProjected } = curYearMap
    const curYearProjectedTotal = curYearTotal + curYearProjected
    const shortDate = new Date(rundate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: 'UTC' })
    return <>
        <p>Click/Double-click the legend labels to toggle or solo each type.</p>
        {includeWorstYearsBlurb !== false && <p>2021 and 2022 were the worst years in the NJSP record (since 2008), with {total2021} and {total2022} deaths, resp.</p>}
        <p><A href={`${GitHub.href}/commits/main`}>As of {shortDate}</A>, {curYear} has {curYearTotal} reported deaths, and <A href={estimationHref}>is on pace</A> for {curYearProjectedTotal}{curYearProjectedTotal > prvYearTotal ? `, exceeding ${prvYear}'s ${prvYearTotal}` : ""}.</p>
    </>
}

export const njspPlotSpec: PlotSpec = {
    title: "NJ Traffic Deaths per Year", id: "per-year", name: "fatalities_per_year_by_type",
    menuName: "Traffic Deaths / Year", dropdownSection: "NJSP",
    filter: filterValues({ mapRange: HalfRoundWiden }),
    children: NjspChildren,
}

export const plotSpecs: PlotSpec[] = [
    // {
    //     id: "crash-map",
    //     name: "njdot/hudson-pif-crashes",
    //     title: "Hudson County Crashes (2020)",
    //     //plot: crashMapPlot,
    //     //src: "",
    //     style: { height: 1100, },
    // },
    njspPlotSpec,
    {
        id: "ytd", name: "ytd-deaths", title: "NJ Traffic Deaths per Year", menuName: "YTD", dropdownSection: "NJSP",
        filter: filterIdxs,
        children: <>
            <p>Some data arrives weeks or months after the fact, so current year numbers are especially subject to change.</p>
        </>
    },
    {
        id: "vs-homicides", name: "crash_homicide_cmp", title: "NJ Traffic Deaths vs. Homicides", menuName: "vs. Homicides", dropdownSection: "NJSP",
        children: <>
            <p>Traffic crashes kill 1.5-2x as many people as homicides in NJ.</p>
            <p>Homicide data comes from <A href={"https://nj.gov/njsp/ucr/uniform-crime-reports.shtml"}>NJ State Police</A> and <A href={"https://www.disastercenter.com/crime/njcrimn.htm"}>Disaster Center</A>.</p>
        </>
    },
    { id: "per-month", name: "fatalities_per_month", title: "NJ Traffic Deaths per Month", menuName: "Per Month", dropdownSection: "NJSP", },
    { id: "per-month-type", name: "fatalities_per_month_by_type", title: "NJ Traffic Deaths per Month (by Victim Type)", menuName: "By Victim Type", dropdownSection: "NJSP", },
    { id: "by-month-bars", name: "fatalities_by_month_bars", title: "NJ Traffic Deaths, grouped by month", menuName: "Grouped by Month", dropdownSection: "NJSP", },
    ...YM_SC_PID_SPECS,
]

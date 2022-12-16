import React from "react";
import A from "next-utils/a";
import {GitHub} from "./socials";
import * as Plots from "./plot";

export type Year = "2021" | "2022"
export type YearTotals = { "Projected Total": number }
export type ProjectedTotals = { [k in Year]: YearTotals }
export type HasTotals = { projectedTotals: ProjectedTotals }

export type T = { rundate: string } & HasTotals
export type PlotSpec = Plots.PlotSpec<T>
export type Plot = Plots.Plot<T>
export const Plot = (args: Plot) => Plots.Plot<T>(args)

export const EMPTY: PlotSpec[] = []
export const YM_SC_PID_SPECS: PlotSpec[] =
    EMPTY.concat(...['y', 'm'].map(my =>
        EMPTY.concat(...['s', 'c'].map(sc =>
            EMPTY.concat(...['p', 'i', 'd'].map(t => {
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
                    /*, legend: "inherit",*/
                } as PlotSpec
            }))
        ))
    ))

export const plotSpecs: PlotSpec[] = [
    {
        id: "per-year", name: "fatalities_per_year_by_type", title: "NJ Traffic Deaths per Year", menuName: "Traffic Deaths / Year", dropdownSection: "NJSP",
        children: ({ rundate, projectedTotals }: { rundate: string, } & HasTotals) => {
            const total2021 = projectedTotals["2021"]["Projected Total"]
            const total2022 = projectedTotals["2022"]["Projected Total"]
            const shortDate = new Date(rundate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: 'UTC' })
            return <>
                <p>2021 was the worst year in the NJSP dataset (since 2008), with {total2021} deaths.</p>
                <p><A href={`${GitHub.href}/commits/main`}>As of {shortDate}</A>, 2022 is on pace {total2022 > total2021 ? `to exceed it, with` : `for`} {total2022}.</p>
                <p>Victim types have been published since 2020.</p>
            </>
        },
    },
    {
        id: "ytd", name: "ytd-deaths", title: "NJ Traffic Deaths per Year", menuName: "YTD", dropdownSection: "NJSP",
        children: <>
            <p>These are based on actual crash records in the NJSP data (which are ≈5% lower than the totals used in the first plot).</p>
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

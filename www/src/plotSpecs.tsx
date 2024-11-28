import React from "react";
import { filterIdxs, PlotSpec } from "@rdub/next-plotly/plot";
import A from "@rdub/next-base/a";
import { NjspSource } from "@/src/icons";
import css from "@/pages/index.module.scss"

export const curYear = (new Date().getFullYear())
export const prvYear = curYear - 1
export type Year = "2021" | "2022" | typeof prvYear | typeof curYear
export type YearTotalsMap = { [k in Year]: { total: number, projected: number } }
export type Data = {
    rundate: string
}

export const njspPlotSpec: PlotSpec = {
    id: "per-year", name: "fatalities_per_year_by_type",
    menuName: "Traffic Deaths / Year", dropdownSection: "NJSP",
}

export const plotSpecs: PlotSpec[] = [
    njspPlotSpec,
    {
        id: "ytd", name: "ytd-deaths", menuName: "YTD", dropdownSection: "NJSP",
        filter: filterIdxs,
        children: <NjspSource className={css.ytdFooter}>
            <p>Some data arrives weeks or months after the fact, so current year numbers are especially subject to change.</p>
        </NjspSource>
    },
    {
        id: "vs-homicides", name: "crash_homicide_cmp", title: "NJ Traffic Deaths vs. Homicides", menuName: "vs. Homicides", dropdownSection: "NJSP",
        children: <>
            <p>Car crashes kill twice as many people as homicides, in NJ.</p>
            <p>In 2022, crashes killed 2.4x as many people, the largest disparity on record.</p>
            <p>Homicide data comes from <A href={"https://nj.gov/njsp/ucr/uniform-crime-reports.shtml"}>NJ State Police</A>, <A href={"https://www.disastercenter.com/crime/njcrimn.htm"}>Disaster Center</A>.</p>
        </>
    },
    { id: "per-month", name: "fatalities_per_month", menuName: "Per Month", dropdownSection: "NJSP", },
    { id: "by-month-bars", name: "fatalities_by_month_bars", menuName: "Grouped by Month", dropdownSection: "NJSP", },
]

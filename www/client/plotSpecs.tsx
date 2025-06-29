import { filterIdxs, PlotSpec } from "@rdub/next-plotly/plot"
import React from "react"
import { NjspSource } from "@/client/icons"
import css from "@/pages/index.module.scss"

export const plotSpecs: PlotSpec[] = [
  {
    id: "ytd", name: "ytd-deaths", menuName: "YTD", dropdownSection: "NJSP",
    filter: filterIdxs,
    children: <NjspSource className={css.ytdFooter}>
      <p>Some data arrives weeks or months after the fact, so current year numbers are especially subject to change.</p>
    </NjspSource>
  },
  { id: "per-month", name: "fatalities_per_month", menuName: "Per Month", dropdownSection: "NJSP", },
  { id: "by-month-bars", name: "fatalities_by_month_bars", menuName: "Grouped by Month", dropdownSection: "NJSP", },
]

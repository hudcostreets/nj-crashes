import { fromEntries, sum } from "@rdub/base"
import { Annotations, PlotData } from "plotly.js"
import { ReactNode } from "react"
import * as Plotly from "react-plotly.js"
import { repoWithOwner } from "@/src/github"

export const curYear = (new Date().getFullYear())
export const prvYear = curYear - 1
export type Year = "2021" | "2022" | typeof prvYear | typeof curYear
export type YearTotalsMap = { [k in Year]: { total: number, projected: number } }
export type Data = {
  rundate: string
}
export const name = "fatalities_per_year_by_type"

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type HasCounty = {
  county: string | null
}

export type TypeCounts = {
  driver: number
  pedestrian: number
  cyclist: number
  passenger: number
}

export type Props = {
  initialPlot: PlotParams
  typeProjections: TypeCounts
  ytRows: YtRow[]
  county: string | null
  Counties: string[]
  title?: string
  heading?: ReactNode
} & Data

export type YtRow = {
  year: number
} & TypeCounts & {
  total: number
  projected: number
}

export function getPlotData({ ytRows, typeProjections, initialPlotData, types, showProjected, county, }: {
  ytRows: YtRow[]
  typeProjections: TypeCounts
  initialPlotData: PlotData[]
  types: Set<Type>
  showProjected: boolean
  county?: string | null
}): {
  rows: YtRow[]
  data: PlotData[]
  annotations: Annotation[]
  yearTotalsMap: YearTotalsMap
  maxY: number
} {
  // console.log("getPlotData: county", county)
  const typesArr = Array.from(types)
  const typesMap: { [k: string]: keyof TypeCounts } = {
    "Drivers": "driver",
    "Pedestrians": "pedestrian",
    "Cyclists": "cyclist",
    "Passengers": "passenger",
  }
  console.log("typeProjections:", typeProjections)
  const projectedTotal = sum(Types.map(type => {
    const col = typesMap[type] as keyof TypeCounts
    return col in typeProjections ? typeProjections[col] : 0
  }))
  const typesProjectedTotal = sum(typesArr.map(type => {
    const col = typesMap[type] as keyof TypeCounts
    return col in typeProjections ? typeProjections[col] : 0
  }))
  // console.log("ytRows:", ytRows)
  const last = { ...ytRows[ytRows.length - 1] }
  const rows = [ ...ytRows.slice(0, ytRows.length - 1), last ]
  const typeRows: YtRow[] = ytRows.map(({ year, ...row }) => {
    const total = sum(typesArr.map(type => row[typesMap[type]]))
    return { year, ...row, total, projected: 0 }
  })
  if (last.year == curYear) {
    const lastTotal = sum(Types.map(type => last[typesMap[type]]))
    console.log("projectedTotal:", projectedTotal, "lastTotal:", lastTotal, "original last:", ytRows[ytRows.length - 1])
    last.projected = projectedTotal - lastTotal
    if (showProjected) {
      const typesLastTotal = sum(typesArr.map(type => last[typesMap[type]]))
      typeRows[typeRows.length - 1].projected = typesProjectedTotal - typesLastTotal
    }
  } else {
    console.warn(`getPlotData: last year is not ${curYear}:`, last, ` (county: ${county})`, ytRows)
    rows.push({
      year: curYear,
      driver: 0,
      pedestrian: 0,
      cyclist: 0,
      passenger: 0,
      total: 0,
      projected: projectedTotal,
    })
  }
  const isSolo = types.size === 1
  // console.log("got ytc data:", rows, "isSolo:", isSolo)
  // console.log("getPlotData: types:", types)
  const data = initialPlotData.map(series => {
    const { name } = series
    const type = name as LegendType
    const col = name === "Projected" ? "projected" : typesMap[type]
    const newSeries: PlotData = { ...series }
    newSeries.x = typeRows.map(r => r.year)
    newSeries.y = typeRows.map(r => r[col])
    if (type === "Projected") {
      newSeries.visible = showProjected ? true : "legendonly"
    } else {
      newSeries.visible = types.has(type) ? true : "legendonly"
    }
    if (!isSolo) {
      newSeries.textposition = "inside"
    }
    return newSeries
  })
  const annotations: Annotation[] = typeRows.map(row => {
    const { year, projected } = row
    if (isSolo && (!showProjected || !projected)) return null
    const y = sum(typesArr.map(type => row[typesMap[type]])) + (showProjected ? projected : 0)
    const a: Annotation = {
      x: year,
      y,
      text: `${y}`,
      showarrow: false,
      yshift: 10,
    }
    return a
  }).filter((a): a is Annotation => a !== null)
  typeRows.forEach(row => {
    const { year, projected } = row
    if (isSolo || (!showProjected || !projected)) return
    const y = sum(typesArr.map(type => row[typesMap[type]]))
    if (projected / y > 0.1) {
      annotations.push({
        x: year,
        y,
        text: `${y}`,
        showarrow: false,
        yshift: 10,
      })
    }
  })
  const yearTotalsMap = fromEntries(
    rows.map(
      ({ year, total, projected }) =>
        [ year, { total, projected } ]
    )
  ) as YearTotalsMap

  const maxY = typeRows.map(({ total, projected, }) => total + (projected ?? 0)).reduce((a, b) => Math.max(a, b), 0)

  // console.log("annotations:", annotations)
  return { rows: typeRows, data, annotations, yearTotalsMap, maxY, }
}

export const DefaultTitle = "Car Crash Deaths"

export type Type = "Drivers" | "Pedestrians" | "Cyclists" | "Passengers"
export const Types: Type[] = ["Drivers", "Pedestrians", "Cyclists", "Passengers"]
export type LegendType = Type | "Projected"

export const estimationHref = `https://nbviewer.org/github/${repoWithOwner}/blob/main/njsp/update-projections.ipynb`

export type MoreInfoLink = {
  includeMoreInfoLink?: boolean
}

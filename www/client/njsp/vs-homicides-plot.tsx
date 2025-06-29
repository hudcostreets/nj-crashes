import { fromEntries, round, scan } from "@rdub/base"
import { Plot } from "@rdub/next-plotly/plot"
import { maxBy } from "lodash"
import { PlotData } from "plotly.js"
import { useMemo } from "react"
import { PlotParams } from "react-plotly.js"
import { Row } from "@/server/crime/vs-homicides"
import { Props as NjspProps } from "@/src/njsp/plot"

function bar(
  { name, color, years, y, }: {
    name: string
    color: string
    years: number[]
    y: number[]
  }
): Partial<PlotData> {
  return {
    marker: { color, },
    name,
    x: years,
    y,
    type: "bar",
    text: y.map(d => d.toString()),
    hovertemplate: "%{y}",
  }
}

function fmt(n: number, sigfigs: number = 2): string {
  if (n < 1) {
    return `${(n * 100).toPrecision(sigfigs)}%`
  }
  const i = round(n)
  const s = i.toString()
  if (s.length >= sigfigs) {
    return `${i.toLocaleString()}x`
  } else {
    return `${n.toPrecision(sigfigs).replace(/\.0+$/, '')}x`
  }
}

const gridcolor = "#ccc"

export function VsHomicidesPlot(
  { rows, ytRows, }: {
      rows: Row[]
  } & Pick<NjspProps, 'ytRows'>
) {
  const { years, homicides } = useMemo(() => ({
    years: rows.map(({ year }) => year),
    homicides: rows.map(({ homicides }) => homicides),
  }), [ rows ])
  const trafficDeathsMap = useMemo(() => fromEntries(
    ytRows.map(({ year, total }) => [ year, total ])
  ), [ ytRows ])
  const { trafficDeaths, ratios, max, overall, maxYear, } = useMemo(
    () => {
      const trafficDeaths = years.map(year => trafficDeathsMap[year] || 0)
      const ratios = years.map((year, i) => trafficDeaths[i] / homicides[i])
      const cumulativeRatios =
              scan<number, { cars: number, homs: number, n: number, year: number, ratio: number }>(
                [...years].reverse(),
                ({ cars, homs, n }, year) => {
                  cars += trafficDeaths[years.length - 1 - n]
                  homs += homicides[years.length - 1 - n]
                  return { cars, homs, n: n + 1, year, ratio: cars / homs, }
                },
                { cars: 0, homs: 0, n: 0, year: 0, ratio: NaN, },
              ).filter(({ ratio }) => !isNaN(ratio) && ratio !== Infinity)
      const max =
            maxBy(
              cumulativeRatios,
              ({ ratio }) => ratio,
            )!
      console.log("cumulativeRatios", cumulativeRatios)
      return {
        trafficDeaths,
        ratios,
        max,
        overall: cumulativeRatios.filter(({ year }) => year === 2018)[0],
        maxYear: years[years.length - 1],
      }
    },
    [ years ],
  )
  const params: PlotParams = {
    data: [
      bar({
        name: "Traffic deaths",
        color: "#b13258",
        years,
        y: trafficDeaths,
      }),
      bar({
        name: "Homicides",
        color: "#000004",
        years,
        y: homicides,
      }),
      {
        line: { color: "#f99708",  width: 6 },
        mode: "lines",
        name: "Ratio: Crashes / Homicides",
        x: years,
        xaxis: "x",
        y: ratios,
        yaxis: "y2",
        type: "scatter",
        hovertemplate: "%{y:.2g}",
      },
    ],
    layout: {
      hovermode: "x",
      legend: {
        orientation: "h",
        title: { text: "" },
        x: 0.5,
        xanchor: "center"
      },
      paper_bgcolor: "white",
      plot_bgcolor: "white",
      margin: { t:  0, r: 50, b:  0, l: 50, },
      xaxis: {
        anchor: "y",
        gridcolor,
        tickangle: -45,
        tickmode: "array",
        ticktext: years.map(year => year.toString()),
        tickvals: years,
      },
      yaxis: {
        title: { text: "Deaths" },
        tickcolor: "#ccc",
        gridcolor: "transparent",
        rangemode: "tozero",
      },
      yaxis2: {
        title: { text: "Ratio: Crashes / Homicides" },
        rangemode: "tozero",
        gridcolor,
        overlaying: "y",
        side: "right",
      },
    }
  }
  // console.log("VsHomicidesPlot rows", rows)
  return (
    <div>
      <Plot
        id={"vs-homicides"}
        name={"vs-homicides"}
        title={"Traffic Deaths vs. Homicides"}
        params={params}
      />
      <p>
              Car crashes killed
        {' '}<strong>{fmt(max.ratio)}</strong>
        {' '}as many people as murders
        {' '}{max.year == maxYear ? `in ${maxYear}` : `from ${max.year}–${maxYear}`}
        {max.year === overall.year ? `` : <>, and <strong>{fmt(overall.ratio)}</strong> since {overall.year}</>}.
      </p>
    </div>
  )
}

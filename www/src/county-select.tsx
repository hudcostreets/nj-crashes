import React, { Dispatch, useEffect, useMemo, useRef } from "react"
import css from "@/src/county-select.module.scss"

export const getTextWidth = (text: string, font: string) => {
  // Create a temporary span element
  const span = document.createElement('span')
  document.body.appendChild(span)

  // Set the same font styling as your select options
  span.style.font = font
  span.style.position = 'absolute' // Position off-screen
  span.style.height = 'auto'
  span.style.width = 'auto'
  span.style.whiteSpace = 'nowrap'
  span.textContent = text

  // Measure the width
  const width = Math.ceil(span.getBoundingClientRect().width)
  document.body.removeChild(span)
  return width
}

export const label = (county: string | null) => county ? `${county} County` : "NJ"
export const value = (county: string | null) => county || "NJ"

export function CountySelect({ county, setCounty, Counties }: {
    county: string | null
    setCounty: Dispatch<string | null>
    Counties: string[]  // TODO: move these out to a const somewhere
}) {
  const val = useMemo(() => value(county), [ county ])
  const selectRef = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (selectRef.current) {
      const { fontSize, fontWeight, fontFamily } = window.getComputedStyle(selectRef.current)
      const font = `${fontWeight} ${fontSize} ${fontFamily}`
      // console.log("width font:", font, region)
      const textWidth = getTextWidth(label(county), font)
      // console.log("setting width:", textWidth)
      selectRef.current.style.width = `${textWidth + 30}px` // Add some padding
    }
  }, [ county ])
  return (
    <select
      className={css.countySelect}
      ref={selectRef}
      value={val}
      onChange={e => {
        const value = e.target.value
        setCounty(value === "NJ" ? null : value)
      }}
    >
      <option value={"NJ"}>NJ</option>
      {Counties.map(cn => <option key={cn} value={cn}>{label(cn)}</option>)}
    </select>
  )
}

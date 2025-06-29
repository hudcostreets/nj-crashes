import React, { Dispatch, useEffect, useRef } from "react"
import { getTextWidth } from "@/client/county-select"
import css from "@/src/county-select.module.scss"

export default function CitySelect({ city, setCity, cities }: {
    city: string
    setCity: Dispatch<string>
    cities: string[]
}) {
  const selectRef = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (selectRef.current) {
      const { fontSize, fontWeight, fontFamily } = window.getComputedStyle(selectRef.current)
      const font = `${fontWeight} ${fontSize} ${fontFamily}`
      console.log("CitySelect font:", font, city)
      const textWidth = getTextWidth(city, font)
      console.log("CitySelect setting width:", textWidth)
      selectRef.current.style.width = `${textWidth + 30}px` // Add some padding
    }
  }, [ city ])
  return (
    <select
      className={css.countySelect}
      ref={selectRef}
      value={city}
      onChange={e => { setCity(e.target.value) }}
    >{
        cities.map(city => <option key={city} value={city}>{city}</option>)
      }</select>
  )
}

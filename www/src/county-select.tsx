import React, { useEffect, useRef } from "react";
import css from "@/src/county-select.module.scss";

export const getTextWidth = (text: string, font: string) => {
    // Create a temporary span element
    const span = document.createElement('span');
    document.body.appendChild(span);

    // Set the same font styling as your select options
    span.style.font = font;
    span.style.position = 'absolute'; // Position off-screen
    span.style.height = 'auto';
    span.style.width = 'auto';
    span.style.whiteSpace = 'nowrap';
    span.textContent = text;

    // Measure the width
    const width = Math.ceil(span.getBoundingClientRect().width);

    document.body.removeChild(span);

    return width;
};

export function CountySelect({ region, setRegion, counties }: {
    region: string
    setRegion: (region: string) => void
    counties: string[]
}) {
    const selectRef = useRef<HTMLSelectElement>(null)
    useEffect(() => {
        if (selectRef.current) {
            const { fontSize, fontWeight, fontFamily } = window.getComputedStyle(selectRef.current)
            const font = `${fontWeight} ${fontSize} ${fontFamily}`
            // console.log("width font:", font, region)
            const text = region === "NJ" ? "NJ" : `${region} County`
            const textWidth = getTextWidth(text, font)
            // console.log("setting width:", textWidth)
            selectRef.current.style.width = `${textWidth + 30}px` // Add some padding
        }
    }, [ region ])
    return (
        <select
            className={css.countySelect}
            ref={selectRef}
            value={region}
            onChange={e => {
                const select = e.target
                const region = select.value
                setRegion(region)
            }}
        >
            <option value={"NJ"}>NJ</option>
            {counties.map(cn => <option key={cn} value={cn}>{cn} County</option>)}
        </select>
    )
}

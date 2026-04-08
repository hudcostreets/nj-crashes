import { useMemo, useState } from "react"
import css from "./CountyPicker.module.scss"

// Generate distinct colors as HSL for N regions using golden angle hue spacing
function generateColors(names: string[]): Record<string, { h: number; s: number; l: number }> {
    const colors: Record<string, { h: number; s: number; l: number }> = {}
    const sorted = [...names].sort()
    sorted.forEach((name, i) => {
        const h = Math.round((i * 137.508) % 360)
        colors[name] = { h, s: 35, l: 40 }
    })
    return colors
}

function hsl({ h, s, l }: { h: number; s: number; l: number }): string {
    return `hsl(${h}, ${s}%, ${l}%)`
}

function brighten(c: { h: number; s: number; l: number }): string {
    return `hsl(${c.h}, ${Math.min(c.s + 20, 60)}%, ${Math.min(c.l + 25, 75)}%)`
}

export type RegionData = {
    viewBox: string
    regions: Record<string, { path: string; labelX: number; labelY: number }>
}

type Props = {
    data: RegionData
    selected: string | null
    onSelect: (name: string | null) => void
    allLabel?: string
}

export function RegionMapPicker({ data, selected, onSelect, allLabel = "All" }: Props) {
    const [hovered, setHovered] = useState<string | null>(null)
    const highlight = hovered ?? selected

    const regionNames = useMemo(() => Object.keys(data.regions).sort(), [data])
    const colors = useMemo(() => generateColors(regionNames), [regionNames])

    return (
        <div className={css.pickerLayout}>
            <div className={css.mapSide}>
                <svg viewBox={data.viewBox} className={css.map}>
                    {regionNames.map(name => {
                        const { path } = data.regions[name]
                        const c = colors[name]
                        const isHighlight = highlight === name
                        return (
                            <path
                                key={name}
                                d={path}
                                fill={isHighlight ? brighten(c) : hsl(c)}
                                stroke="rgba(255, 255, 255, 0.4)"
                                strokeWidth={isHighlight ? 2 : 1}
                                opacity={highlight && !isHighlight ? 0.4 : 1}
                                className={css.countyPath}
                                onClick={() => onSelect(name)}
                                onMouseEnter={() => setHovered(name)}
                                onMouseLeave={() => setHovered(null)}
                            />
                        )
                    })}
                </svg>
            </div>
            <div className={css.listSide}>
                <button
                    className={`${css.listItem} ${!selected ? css.active : ''}`}
                    onClick={() => onSelect(null)}
                    onMouseEnter={() => setHovered(null)}
                >
                    <span className={css.swatch} style={{ background: '#888' }} />
                    {allLabel}
                </button>
                {regionNames.map(name => {
                    const c = colors[name]
                    const isHighlight = highlight === name
                    return (
                        <button
                            key={name}
                            className={`${css.listItem} ${selected === name ? css.active : ''} ${isHighlight ? css.highlight : ''}`}
                            onClick={() => onSelect(name)}
                            onMouseEnter={() => setHovered(name)}
                            onMouseLeave={() => setHovered(null)}
                        >
                            <span className={css.swatch} style={{ background: isHighlight ? brighten(c) : hsl(c) }} />
                            {name}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

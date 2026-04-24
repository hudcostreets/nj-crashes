import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
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
    /** Route href for each option — when provided, items render as real `<Link>`s
     *  so meta/shift/middle-click follow native browser behaviour (open in new
     *  tab/window) instead of just firing `onSelect`. */
    hrefFor?: (name: string | null) => string
    allLabel?: string
}

export function RegionMapPicker({ data, selected, onSelect, hrefFor, allLabel = "All" }: Props) {
    const [hovered, setHovered] = useState<string | null>(null)
    const highlight = hovered ?? selected

    const regionNames = useMemo(() => Object.keys(data.regions).sort(), [data])
    const colors = useMemo(() => generateColors(regionNames), [regionNames])

    const handleClick = (name: string | null) => (e: React.MouseEvent) => {
        // If the item is a real link and the user holds a modifier, let the
        // browser handle it (open in new tab/window).
        if (hrefFor && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as React.MouseEvent<any>).button === 1)) return
        e.preventDefault()
        onSelect(name)
    }
    return (
        <div className={css.pickerLayout}>
            <div className={css.mapSide}>
                <svg viewBox={data.viewBox} className={css.map}>
                    {regionNames.map(name => {
                        const { path } = data.regions[name]
                        const c = colors[name]
                        const isHighlight = highlight === name
                        const pathEl = (
                            <path
                                d={path}
                                fill={isHighlight ? brighten(c) : hsl(c)}
                                stroke="rgba(255, 255, 255, 0.4)"
                                strokeWidth={isHighlight ? 2 : 1}
                                opacity={highlight && !isHighlight ? 0.4 : 1}
                                className={css.countyPath}
                                onMouseEnter={() => setHovered(name)}
                                onMouseLeave={() => setHovered(null)}
                            />
                        )
                        return hrefFor ? (
                            <a key={name} href={hrefFor(name)} onClick={handleClick(name)}>
                                {pathEl}
                            </a>
                        ) : (
                            <g key={name} onClick={() => onSelect(name)} style={{ cursor: "pointer" }}>
                                {pathEl}
                            </g>
                        )
                    })}
                </svg>
            </div>
            <div className={css.listSide}>
                {hrefFor ? (
                    <Link
                        to={hrefFor(null)}
                        onClick={handleClick(null)}
                        className={`${css.listItem} ${!selected ? css.active : ''}`}
                        onMouseEnter={() => setHovered(null)}
                    >
                        <span className={css.swatch} style={{ background: '#888' }} />
                        {allLabel}
                    </Link>
                ) : (
                    <button
                        className={`${css.listItem} ${!selected ? css.active : ''}`}
                        onClick={() => onSelect(null)}
                        onMouseEnter={() => setHovered(null)}
                    >
                        <span className={css.swatch} style={{ background: '#888' }} />
                        {allLabel}
                    </button>
                )}
                {regionNames.map(name => {
                    const c = colors[name]
                    const isHighlight = highlight === name
                    const className = `${css.listItem} ${selected === name ? css.active : ''} ${isHighlight ? css.highlight : ''}`
                    const swatch = <span className={css.swatch} style={{ background: isHighlight ? brighten(c) : hsl(c) }} />
                    const mouseHandlers = { onMouseEnter: () => setHovered(name), onMouseLeave: () => setHovered(null) }
                    return hrefFor ? (
                        <Link
                            key={name}
                            to={hrefFor(name)}
                            onClick={handleClick(name)}
                            className={className}
                            {...mouseHandlers}
                        >
                            {swatch}{name}
                        </Link>
                    ) : (
                        <button
                            key={name}
                            className={className}
                            onClick={() => onSelect(name)}
                            {...mouseHandlers}
                        >
                            {swatch}{name}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

import mapData from "@/src/nj-county-map.json"
import css from "./CountyPicker.module.scss"

const { viewBox, counties: countyMap } = mapData as {
    viewBox: string
    counties: Record<string, { path: string; labelX: number; labelY: number }>
}

type Props = {
    selected: string | null
    onSelect: (county: string | null) => void
}

export function CountyPicker({ selected, onSelect }: Props) {
    return (
        <div className={css.mapContainer}>
            <svg viewBox={viewBox} className={css.map}>
                {Object.entries(countyMap).map(([name, { path, labelX, labelY }]) => (
                    <g
                        key={name}
                        className={`${css.county} ${selected === name ? css.active : ''}`}
                        onClick={() => onSelect(name)}
                    >
                        <path d={path} />
                        <text x={labelX} y={labelY} className={css.countyLabel}>{name}</text>
                    </g>
                ))}
            </svg>
            <button
                className={`${css.njButton} ${!selected ? css.active : ''}`}
                onClick={() => onSelect(null)}
            >
                All NJ
            </button>
        </div>
    )
}

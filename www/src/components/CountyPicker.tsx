import { useMemo } from "react"
import countyShapes from "@/src/county-shapes.json"
import css from "./CountyPicker.module.scss"

type Props = {
    selected: string | null
    onSelect: (county: string | null) => void
}

function CountyIcon({ name, size = 32 }: { name: string; size?: number }) {
    const path = (countyShapes as Record<string, string>)[name]
    if (!path) return null
    return (
        <svg viewBox="0 0 40 40" width={size} height={size} className={css.icon}>
            <path d={path} />
        </svg>
    )
}

export function CountyPicker({ selected, onSelect }: Props) {
    const counties = useMemo(
        () => Object.keys(countyShapes as Record<string, string>).sort(),
        [],
    )

    return (
        <div className={css.picker}>
            <button
                className={`${css.item} ${!selected ? css.active : ''}`}
                onClick={() => onSelect(null)}
                title="All of New Jersey"
            >
                <svg viewBox="0 0 40 40" width={32} height={32} className={css.icon}>
                    {counties.map(name => (
                        <path key={name} d={(countyShapes as Record<string, string>)[name]} />
                    ))}
                </svg>
                <span className={css.label}>NJ</span>
            </button>
            {counties.map(name => (
                <button
                    key={name}
                    className={`${css.item} ${selected === name ? css.active : ''}`}
                    onClick={() => onSelect(name)}
                    title={`${name} County`}
                >
                    <CountyIcon name={name} />
                    <span className={css.label}>{name}</span>
                </button>
            ))}
        </div>
    )
}

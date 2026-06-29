import { useCallback, useEffect, useRef, useState } from "react"
import css from "./plot.module.scss"

export type VictimType = 'driver' | 'passenger' | 'pedestrian' | 'cyclist'
export const VICTIM_TYPES: VictimType[] = ['driver', 'passenger', 'pedestrian', 'cyclist']
export const VICTIM_LABELS: Record<VictimType, string> = {
    driver: 'Drivers',
    passenger: 'Passengers',
    pedestrian: 'Pedestrians',
    cyclist: 'Cyclists',
}

/** Lowercase singular labels for inline prose (e.g. subtitles). */
export const VICTIM_LABEL_SINGULAR: Record<VictimType, string> = {
    driver: 'driver',
    passenger: 'passenger',
    pedestrian: 'pedestrian',
    cyclist: 'cyclist',
}

/** Single-char codes used in the `nst` URL param; lookup-friendly + stable. */
export const VICTIM_CHAR: Record<VictimType, string> = { driver: 'd', passenger: 'p', pedestrian: 'e', cyclist: 'c' }
const CHAR_TO_TYPE: Record<string, VictimType> = Object.fromEntries(
    Object.entries(VICTIM_CHAR).map(([t, c]) => [c, t as VictimType]),
)

/** Encode a subset of victim types as a stable single-char string (`'dp'`,
 *  `'dpec'`, `''`). Same chars regardless of input order. */
export function encodeVictimTypes(types: VictimType[]): string {
    const set = new Set(types)
    return VICTIM_TYPES.filter(t => set.has(t)).map(t => VICTIM_CHAR[t]).join("")
}

export function decodeVictimTypes(s: string): VictimType[] {
    const types: VictimType[] = []
    for (const c of s) {
        const t = CHAR_TO_TYPE[c]
        if (t && !types.includes(t)) types.push(t)
    }
    return types
}

export function VictimTypeDropdown({ selected, onChange }: { selected: VictimType[], onChange: (types: VictimType[]) => void }) {
    const [isOpen, setIsOpen] = useState(false)
    const detailsRef = useRef<HTMLDetailsElement>(null)
    const suppressToggle = useRef(false)

    const allSelected = selected.length === VICTIM_TYPES.length
    const summaryText = allSelected
        ? "All Types"
        : selected.length === 1
            ? VICTIM_LABELS[selected[0]]
            : `${selected.length} Types`

    const stableOnChange = useCallback((types: VictimType[]) => {
        if (types.length === 0) return
        suppressToggle.current = true
        onChange(types)
        requestAnimationFrame(() => {
            if (detailsRef.current) detailsRef.current.open = true
            suppressToggle.current = false
        })
    }, [onChange])

    const toggleAll = () => stableOnChange(allSelected ? [VICTIM_TYPES[0]] : [...VICTIM_TYPES])
    const toggleType = (t: VictimType) => {
        if (selected.includes(t)) {
            if (selected.length > 1) stableOnChange(selected.filter(s => s !== t))
        } else {
            stableOnChange([...selected, t])
        }
    }
    const soloType = (t: VictimType) => {
        stableOnChange(selected.length === 1 && selected[0] === t ? [...VICTIM_TYPES] : [t])
    }

    useEffect(() => {
        if (!isOpen) return
        const handleClickOutside = (e: MouseEvent) => {
            if (detailsRef.current && !detailsRef.current.contains(e.target as Node)) {
                setIsOpen(false)
                detailsRef.current.open = false
            }
        }
        document.addEventListener('click', handleClickOutside)
        return () => document.removeEventListener('click', handleClickOutside)
    }, [isOpen])

    return (
        <details
            ref={detailsRef}
            className={css.victimTypeDropdown}
            open={isOpen}
            onToggle={e => {
                if (suppressToggle.current) { e.preventDefault(); return }
                setIsOpen((e.target as HTMLDetailsElement).open)
            }}
        >
            <summary>{summaryText}</summary>
            <div className={css.victimTypeList}>
                <label className={css.selectAll}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                    {allSelected ? "Deselect All" : "Select All"}
                </label>
                {VICTIM_TYPES.map(t => {
                    const isSolo = selected.length === 1 && selected[0] === t
                    return (
                        <div key={t} className={css.victimTypeRow}>
                            <label>
                                <input type="checkbox" checked={selected.includes(t)} onChange={() => toggleType(t)} />
                                {VICTIM_LABELS[t]}
                            </label>
                            <span
                                className={css.soloLink}
                                onClick={e => { e.preventDefault(); e.stopPropagation(); soloType(t) }}
                                title={isSolo ? "Show all" : `Only ${VICTIM_LABELS[t]}`}
                                aria-label={isSolo ? "Show all" : `Only ${VICTIM_LABELS[t]}`}
                            >
                                ◉
                            </span>
                        </div>
                    )
                })}
            </div>
        </details>
    )
}

import { useEffect, useMemo, useRef, useState } from "react"
import css from "./controls.module.css"

type MuniEntry = { code: number; name: string }

export function MunicipalityDropdown({
    mc2mn,
    selected,
    onChange,
}: {
    mc2mn: Record<number, string>
    selected: number[]
    onChange: (munis: number[]) => void
}) {
    const [isOpen, setIsOpen] = useState(false)
    const detailsRef = useRef<HTMLDetailsElement>(null)

    const muniEntries: MuniEntry[] = useMemo(
        () => Object.entries(mc2mn).map(([code, name]) => ({
            code: Number(code),
            name,
        })).sort((a, b) => a.name.localeCompare(b.name)),
        [mc2mn],
    )

    const allSelected = selected.length === muniEntries.length
    const noneSelected = selected.length === 0
    const summaryText = allSelected
        ? "All Municipalities"
        : noneSelected
            ? "No Municipalities"
            : selected.length === 1
                ? mc2mn[selected[0]] || `Muni ${selected[0]}`
                : `${selected.length} Municipalities`

    const toggleAll = () => {
        if (allSelected) {
            onChange([])
        } else {
            onChange(muniEntries.map(m => m.code))
        }
    }

    const toggleMuni = (code: number) => {
        if (selected.includes(code)) {
            onChange(selected.filter(c => c !== code))
        } else {
            onChange([...selected, code])
        }
    }

    // Close dropdown when clicking outside
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
        <div className={css.control}>
            <div className={css.controlHeader}>Municipalities</div>
            <details
                ref={detailsRef}
                className={css.countyDropdown}
                open={isOpen}
                onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
            >
                <summary>{summaryText}</summary>
                <div className={css.countyList}>
                    <label className={css.selectAll}>
                        <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                        />
                        {allSelected ? "Deselect All" : "Select All"}
                    </label>
                    {muniEntries.map(({ code, name }) => (
                        <label key={code}>
                            <input
                                type="checkbox"
                                checked={selected.includes(code)}
                                onChange={() => toggleMuni(code)}
                            />
                            {name}
                        </label>
                    ))}
                </div>
            </details>
        </div>
    )
}

import { useEffect, useRef, useState } from "react"
import { Counties } from "./data"
import css from "./controls.module.css"

const countyEntries = Object.entries(Counties).map(([code, name]) => ({
    code: Number(code),
    name,
})).sort((a, b) => a.name.localeCompare(b.name))

export function CountyDropdown({
    selected,
    onChange,
}: {
    selected: number[]
    onChange: (counties: number[]) => void
}) {
    const [isOpen, setIsOpen] = useState(false)
    const detailsRef = useRef<HTMLDetailsElement>(null)

    const allSelected = selected.length === countyEntries.length
    const noneSelected = selected.length === 0
    const summaryText = allSelected
        ? "All Counties"
        : noneSelected
            ? "No Counties"
            : selected.length === 1
                ? Counties[selected[0]]
                : `${selected.length} Counties`

    const toggleAll = () => {
        if (allSelected) {
            onChange([])
        } else {
            onChange(countyEntries.map(c => c.code))
        }
    }

    const toggleCounty = (code: number) => {
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
                // Stop propagation to prevent closing parent ControlsGear
                e.stopPropagation()
            }
        }

        // Use capture phase to handle before other handlers
        document.addEventListener('click', handleClickOutside, true)
        return () => document.removeEventListener('click', handleClickOutside, true)
    }, [isOpen])

    return (
        <div className={css.control}>
            <div className={css.controlHeader}>Counties</div>
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
                    {countyEntries.map(({ code, name }) => (
                        <label key={code}>
                            <input
                                type="checkbox"
                                checked={selected.includes(code)}
                                onChange={() => toggleCounty(code)}
                            />
                            {name}
                        </label>
                    ))}
                </div>
            </details>
        </div>
    )
}

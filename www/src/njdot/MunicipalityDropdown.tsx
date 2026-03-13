import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
    // Guard against onToggle firing during parent re-renders
    const suppressToggle = useRef(false)

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

    // Wrap onChange to suppress onToggle during re-render
    const stableOnChange = useCallback((munis: number[]) => {
        suppressToggle.current = true
        onChange(munis)
        // Re-force open after React re-renders
        requestAnimationFrame(() => {
            if (detailsRef.current) {
                detailsRef.current.open = true
            }
            suppressToggle.current = false
        })
    }, [onChange])

    const toggleAll = () => {
        stableOnChange(allSelected ? [] : muniEntries.map(m => m.code))
    }

    const toggleMuni = (code: number) => {
        if (selected.includes(code)) {
            stableOnChange(selected.filter(c => c !== code))
        } else {
            stableOnChange([...selected, code])
        }
    }

    const soloMuni = (code: number) => {
        if (selected.length === 1 && selected[0] === code) {
            // Already solo'd — restore all
            stableOnChange(muniEntries.map(m => m.code))
        } else {
            stableOnChange([code])
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
                onToggle={(e) => {
                    if (suppressToggle.current) {
                        // Force back open — this was a re-render artifact
                        e.preventDefault()
                        return
                    }
                    setIsOpen((e.target as HTMLDetailsElement).open)
                }}
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
                        <label key={code} className={css.muniRow}>
                            <input
                                type="checkbox"
                                checked={selected.includes(code)}
                                onChange={() => toggleMuni(code)}
                            />
                            <span
                                className={css.muniName}
                                onClick={(e) => {
                                    e.preventDefault()
                                    soloMuni(code)
                                }}
                                title={selected.length === 1 && selected[0] === code ? "Show all" : `Solo ${name}`}
                            >
                                {name}
                            </span>
                        </label>
                    ))}
                </div>
            </details>
        </div>
    )
}

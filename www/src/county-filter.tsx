import React, { Dispatch, useEffect, useMemo, useRef, useState } from "react"
import css from "./county-filter.module.scss"

// Simple fuzzy match: check if query chars appear in order in target
function fuzzyMatch(query: string, target: string): boolean {
    const q = query.toLowerCase()
    const t = target.toLowerCase()
    let qi = 0
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) qi++
    }
    return qi === q.length
}

// Score a fuzzy match (lower is better)
function fuzzyScore(query: string, target: string): number {
    const q = query.toLowerCase()
    const t = target.toLowerCase()

    // Exact prefix match gets best score
    if (t.startsWith(q)) return 0

    // Check for substring match
    const idx = t.indexOf(q)
    if (idx >= 0) return idx + 1

    // Fuzzy match: count gaps between matched chars
    let qi = 0
    let gaps = 0
    let lastMatch = -1
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            if (lastMatch >= 0) gaps += ti - lastMatch - 1
            lastMatch = ti
            qi++
        }
    }
    return qi === q.length ? 100 + gaps : Infinity
}

export function CountyFilter({
    county,
    setCounty,
    Counties,
    placeholder = "Search county...",
}: {
    county: string | null
    setCounty: Dispatch<string | null>
    Counties: string[]
    placeholder?: string
}) {
    const [query, setQuery] = useState("")
    const [isOpen, setIsOpen] = useState(false)
    const [highlightIdx, setHighlightIdx] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLUListElement>(null)

    // Filter and sort counties by fuzzy match
    const filtered = useMemo(() => {
        if (!query) return Counties
        return Counties
            .filter(c => fuzzyMatch(query, c))
            .sort((a, b) => fuzzyScore(query, a) - fuzzyScore(query, b))
    }, [query, Counties])

    // Reset highlight when filtered list changes
    useEffect(() => {
        setHighlightIdx(0)
    }, [filtered])

    // Scroll highlighted item into view
    useEffect(() => {
        if (listRef.current && isOpen) {
            const item = listRef.current.children[highlightIdx] as HTMLElement
            item?.scrollIntoView({ block: "nearest" })
        }
    }, [highlightIdx, isOpen])

    const handleSelect = (value: string | null) => {
        setCounty(value)
        setQuery("")
        setIsOpen(false)
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault()
                setHighlightIdx(i => Math.min(i + 1, filtered.length))  // +1 for "All NJ" option
                break
            case "ArrowUp":
                e.preventDefault()
                setHighlightIdx(i => Math.max(i - 1, 0))
                break
            case "Enter":
                e.preventDefault()
                if (highlightIdx === 0) {
                    handleSelect(null)
                } else {
                    handleSelect(filtered[highlightIdx - 1])
                }
                break
            case "Escape":
                setIsOpen(false)
                setQuery("")
                break
        }
    }

    const displayValue = county ? `${county} County` : "NJ"

    return (
        <div className={css.container}>
            <input
                ref={inputRef}
                type="text"
                className={css.input}
                placeholder={isOpen ? placeholder : displayValue}
                value={isOpen ? query : ""}
                onChange={e => setQuery(e.target.value)}
                onFocus={() => setIsOpen(true)}
                onBlur={() => setTimeout(() => setIsOpen(false), 150)}
                onKeyDown={handleKeyDown}
            />
            {!isOpen && (
                <button
                    className={css.displayButton}
                    onClick={() => {
                        setIsOpen(true)
                        inputRef.current?.focus()
                    }}
                >
                    {displayValue}
                </button>
            )}
            {isOpen && (
                <ul ref={listRef} className={css.dropdown}>
                    <li
                        className={`${css.option} ${highlightIdx === 0 ? css.highlighted : ""}`}
                        onMouseDown={() => handleSelect(null)}
                        onMouseEnter={() => setHighlightIdx(0)}
                    >
                        All NJ
                    </li>
                    {filtered.map((c, i) => (
                        <li
                            key={c}
                            className={`${css.option} ${highlightIdx === i + 1 ? css.highlighted : ""}`}
                            onMouseDown={() => handleSelect(c)}
                            onMouseEnter={() => setHighlightIdx(i + 1)}
                        >
                            {c} County
                        </li>
                    ))}
                    {filtered.length === 0 && query && (
                        <li className={css.noResults}>No matches</li>
                    )}
                </ul>
            )}
        </div>
    )
}

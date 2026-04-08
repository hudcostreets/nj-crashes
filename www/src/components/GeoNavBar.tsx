import { useMemo, useState, useRef, useEffect } from "react"
import { Link } from "react-router-dom"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"
import { CountyPicker } from "./CountyPicker"
import css from "./GeoNavBar.module.scss"

export function GeoNavBar() {
    const { countyName, municipalityName, cc, cc2mc2mn, setCounty, setMunicipality } = useGeoFilter()
    const [showPicker, setShowPicker] = useState(false)
    const pickerRef = useRef<HTMLDivElement>(null)

    // Close picker on click outside
    useEffect(() => {
        if (!showPicker) return
        const handler = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
                setShowPicker(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [showPicker])

    const municipalities = useMemo(() => {
        if (!cc2mc2mn || cc === null) return []
        const { mc2mn } = cc2mc2mn[cc]
        return Object.values(mc2mn).sort()
    }, [cc2mc2mn, cc])

    return (
        <nav className={css.geoNav}>
            <div className={css.breadcrumb}>
                {countyName ? <Link to="/">NJ</Link> : <span className={css.current}>NJ</span>}
                {countyName && <>
                    <span className={css.sep}>/</span>
                    {municipalityName
                        ? <Link to={`/c/${normalize(countyName)}`}>{countyName}</Link>
                        : <span className={css.current}>{countyName}</span>
                    }
                </>}
                {municipalityName && <>
                    <span className={css.sep}>/</span>
                    <span className={css.current}>{municipalityName}</span>
                </>}
            </div>
            <div className={css.selectors} ref={pickerRef}>
                <button
                    className={css.pickerToggle}
                    onClick={() => setShowPicker(!showPicker)}
                    title="Browse counties"
                >
                    {countyName ?? "All counties"} ▾
                </button>
                {countyName && municipalities.length > 0 && (
                    <select
                        className={css.geoSelect}
                        value={municipalityName ?? ""}
                        onChange={e => setMunicipality(e.target.value || null)}
                    >
                        <option value="">All municipalities</option>
                        {municipalities.map(mn => <option key={mn} value={mn}>{mn}</option>)}
                    </select>
                )}
                {showPicker && (
                    <div className={css.pickerDropdown}>
                        <CountyPicker
                            selected={countyName}
                            onSelect={(name) => {
                                setCounty(name)
                                setShowPicker(false)
                            }}
                        />
                    </div>
                )}
            </div>
        </nav>
    )
}

import { useMemo, useState, useRef, useEffect } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"
import { CountyPicker } from "./CountyPicker"
import css from "./GeoNavBar.module.scss"

export function GeoNavBar() {
    const { countyName, municipalityName, cc, cc2mc2mn, setCounty, setMunicipality } = useGeoFilter()
    const [showPicker, setShowPicker] = useState(false)
    const pickerRef = useRef<HTMLDivElement>(null)

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
                {/* NJ — link home or show as current */}
                <button
                    className={`${css.crumb} ${!countyName ? css.current : ''}`}
                    onClick={() => setCounty(null)}
                    title="New Jersey (statewide)"
                >
                    NJ
                </button>

                {/* County — dropdown trigger with picker */}
                <span className={css.sep}>/</span>
                <div className={css.crumbDropdown} ref={pickerRef}>
                    <button
                        className={`${css.crumb} ${countyName && !municipalityName ? css.current : ''}`}
                        onClick={() => setShowPicker(!showPicker)}
                    >
                        {countyName ?? 'County'} <span className={css.caret}>▾</span>
                    </button>
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

                {/* Municipality — dropdown (only when county is selected) */}
                {countyName && <>
                    <span className={css.sep}>/</span>
                    <select
                        className={`${css.crumb} ${css.muniSelect} ${municipalityName ? css.current : ''}`}
                        value={municipalityName ?? ""}
                        onChange={e => setMunicipality(e.target.value || null)}
                    >
                        <option value="">Municipality</option>
                        {municipalities.map(mn => <option key={mn} value={mn}>{mn}</option>)}
                    </select>
                </>}
            </div>
        </nav>
    )
}

import { useMemo, useState, useRef, useEffect } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { CountyPicker } from "./CountyPicker"
import { MuniPicker } from "./MuniPicker"
import css from "./GeoNavBar.module.scss"

type PickerOpen = 'county' | 'muni' | null

export function GeoNavBar() {
    const { countyName, municipalityName, setCounty, setMunicipality } = useGeoFilter()
    const [openPicker, setOpenPicker] = useState<PickerOpen>(null)
    const countyRef = useRef<HTMLDivElement>(null)
    const muniRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!openPicker) return
        const handler = (e: MouseEvent) => {
            const ref = openPicker === 'county' ? countyRef : muniRef
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpenPicker(null)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [openPicker])

    return (
        <nav className={css.geoNav}>
            <div className={css.breadcrumb}>
                <button
                    className={`${css.crumb} ${!countyName ? css.current : ''}`}
                    onClick={() => { setCounty(null); setOpenPicker(null) }}
                    title="New Jersey (statewide)"
                >
                    NJ
                </button>

                <span className={css.sep}>/</span>
                <div className={css.crumbDropdown} ref={countyRef}>
                    <button
                        className={`${css.crumb} ${countyName && !municipalityName ? css.current : ''}`}
                        onClick={() => setOpenPicker(openPicker === 'county' ? null : 'county')}
                    >
                        {countyName ?? 'County'} <span className={css.caret}>▾</span>
                    </button>
                    {openPicker === 'county' && (
                        <div className={css.pickerDropdown}>
                            <CountyPicker
                                selected={countyName}
                                onSelect={(name) => {
                                    setCounty(name)
                                    setOpenPicker(null)
                                }}
                            />
                        </div>
                    )}
                </div>

                {countyName && <>
                    <span className={css.sep}>/</span>
                    <div className={css.crumbDropdown} ref={muniRef}>
                        <button
                            className={`${css.crumb} ${municipalityName ? css.current : ''}`}
                            onClick={() => setOpenPicker(openPicker === 'muni' ? null : 'muni')}
                        >
                            {municipalityName ?? 'Municipality'} <span className={css.caret}>▾</span>
                        </button>
                        {openPicker === 'muni' && (
                            <div className={css.pickerDropdown}>
                                <MuniPicker
                                    county={countyName}
                                    selected={municipalityName}
                                    onSelect={(name) => {
                                        setMunicipality(name)
                                        setOpenPicker(null)
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </>}
            </div>
        </nav>
    )
}

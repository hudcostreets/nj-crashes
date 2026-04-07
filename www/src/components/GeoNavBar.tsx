import { useMemo } from "react"
import { Link } from "react-router-dom"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"
import css from "./GeoNavBar.module.scss"

export function GeoNavBar() {
    const { countyName, municipalityName, cc, cc2mc2mn, setCounty, setMunicipality } = useGeoFilter()

    const counties = useMemo(() => {
        if (!cc2mc2mn) return []
        return Object.values(cc2mc2mn).map(c => c.cn).sort()
    }, [cc2mc2mn])

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
            <div className={css.selectors}>
                <select
                    className={css.geoSelect}
                    value={countyName ?? ""}
                    onChange={e => setCounty(e.target.value || null)}
                >
                    <option value="">All counties</option>
                    {counties.map(cn => <option key={cn} value={cn}>{cn}</option>)}
                </select>
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
            </div>
        </nav>
    )
}

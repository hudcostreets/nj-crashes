import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"
import { Link } from "react-router-dom"

export function Breadcrumbs() {
    const { countyName, municipalityName } = useGeoFilter()
    if (!countyName) return null
    return (
        <nav style={{ fontSize: '0.9em', opacity: 0.8, marginBottom: '0.5em' }}>
            <Link to="/">New Jersey</Link>
            {countyName && (
                <>
                    {' > '}
                    {municipalityName ? (
                        <Link to={`/c/${normalize(countyName)}`}>{countyName} County</Link>
                    ) : (
                        <span>{countyName} County</span>
                    )}
                </>
            )}
            {municipalityName && (
                <>
                    {' > '}
                    <span>{municipalityName}</span>
                </>
            )}
        </nav>
    )
}

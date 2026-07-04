import { useMemo } from "react"
import muniMaps from "@/src/muni-maps.json"
import { RegionMapPicker, type RegionData } from "./RegionMapPicker"
import { canonicalMuniHref, normalize } from "@/src/county"
import { useGeoFilter } from "@/src/GeoFilterContext"

const allMuniMaps = muniMaps as Record<string, RegionData>

type Props = {
    county: string
    selected: string | null
    onSelect: (muni: string | null) => void
}

export function MuniPicker({ county, selected, onSelect }: Props) {
    const data = useMemo(() => allMuniMaps[county] ?? null, [county])
    const { cc2mc2mn } = useGeoFilter()
    if (!data) return null

    const countySlug = normalize(county)
    return (
        <RegionMapPicker
            data={data}
            selected={selected}
            onSelect={onSelect}
            hrefFor={name => name ? canonicalMuniHref(county, name, cc2mc2mn) : `/c/${countySlug}`}
            allLabel={`All ${county}`}
        />
    )
}

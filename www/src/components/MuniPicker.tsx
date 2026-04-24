import { useMemo } from "react"
import muniMaps from "@/src/muni-maps.json"
import { RegionMapPicker, type RegionData } from "./RegionMapPicker"
import { normalize } from "@/src/county"

const allMuniMaps = muniMaps as Record<string, RegionData>

type Props = {
    county: string
    selected: string | null
    onSelect: (muni: string | null) => void
}

export function MuniPicker({ county, selected, onSelect }: Props) {
    const data = useMemo(() => allMuniMaps[county] ?? null, [county])
    if (!data) return null

    const countySlug = normalize(county)
    return (
        <RegionMapPicker
            data={data}
            selected={selected}
            onSelect={onSelect}
            hrefFor={name => name ? `/c/${countySlug}/${normalize(name)}` : `/c/${countySlug}`}
            allLabel={`All ${county}`}
        />
    )
}

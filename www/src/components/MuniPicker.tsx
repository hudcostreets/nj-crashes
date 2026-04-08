import { useMemo } from "react"
import muniMaps from "@/src/muni-maps.json"
import { RegionMapPicker, type RegionData } from "./RegionMapPicker"

const allMuniMaps = muniMaps as Record<string, RegionData>

type Props = {
    county: string
    selected: string | null
    onSelect: (muni: string | null) => void
}

export function MuniPicker({ county, selected, onSelect }: Props) {
    const data = useMemo(() => allMuniMaps[county] ?? null, [county])
    if (!data) return null

    return (
        <RegionMapPicker
            data={data}
            selected={selected}
            onSelect={onSelect}
            allLabel={`All ${county}`}
        />
    )
}

import mapData from "@/src/nj-county-map.json"
import { RegionMapPicker, type RegionData } from "./RegionMapPicker"

const raw = mapData as { viewBox: string; counties: RegionData['regions'] }
const countyMapData: RegionData = { viewBox: raw.viewBox, regions: raw.counties }

type Props = {
    selected: string | null
    onSelect: (county: string | null) => void
}

export function CountyPicker({ selected, onSelect }: Props) {
    return (
        <RegionMapPicker
            data={countyMapData}
            selected={selected}
            onSelect={onSelect}
            allLabel="All NJ"
        />
    )
}

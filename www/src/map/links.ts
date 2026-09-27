/** Links into the full-screen crash map (`/map`, view in the `llz` param). */
import { viewStateParam } from "use-prms"

const llzParam = viewStateParam({ default: null })

/** `/map` centred on `[lat, lon]` (top-down), optionally with a road entity selected (`?road=`). */
export function mapViewHref({ lat, lon, zoom, road }: { lat: number; lon: number; zoom: number; road?: number | null }): string {
    const llz = llzParam.encode({ latitude: lat, longitude: lon, zoom, pitch: 0, bearing: 0 })
    const params = new URLSearchParams({ llz: llz! })
    if (road != null) params.set("road", String(road))
    return `/map?${params}`
}

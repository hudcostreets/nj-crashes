import { GeoFilterProvider, GeoScopeOverride } from "@/src/GeoFilterContext"
import { useGeoActions } from "@/src/components/GeoOmnibar"
import Home from "./Home"

/** Register geo actions inside GeoFilterProvider. */
function GeoActionsRegistrar() {
    useGeoActions()
    return null
}

/** `Home` wrapped in `GeoFilterProvider`. Used by the standard `/c/...`
 *  routes (no override — params drive scope) and by `MuniSlugRoute` for
 *  the short-slug canonical case (override drives scope). */
export default function GeoHome({ override }: { override?: GeoScopeOverride }) {
    return (
        <GeoFilterProvider override={override}>
            <GeoActionsRegistrar />
            <Home />
        </GeoFilterProvider>
    )
}

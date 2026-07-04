import { CC2MC2MN, canonicalMuniSlug } from "@/src/county"
import { Link } from "react-router-dom"

export default function CityLink({ cc, mc, cc2mc2mn, }: {
    cc: number
    mc: number
    cc2mc2mn: CC2MC2MN
}) {
    const county = cc2mc2mn[cc]
    const { mc2mn } = county
    const mn = mc2mn[mc]
    // Prefer the canonical short slug (`/hopewell-boro`) over
    // `/c/{county}/{muni}` so links don't redirect-flash on click.
    const short = canonicalMuniSlug(cc, mc, cc2mc2mn)
    return <Link to={short ? `/${short}` : `#`}>{mn}</Link>
}

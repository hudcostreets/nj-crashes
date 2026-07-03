/** Full-screen crash-map route.
 *
 *  Renders the shared <CrashMapSection> in full-screen mode — the same
 *  cells-api backend, controls, Legend, and debug panel as the homepage
 *  `#map` embed. The two surfaces are one component; this route just
 *  resolves the URL's county/muni into `(cc, mc)` and supplies the scope
 *  label + drill-down navigation.
 *
 *  URL: /map  ·  /map/:county  ·  /map/:county/:muni
 *       (also /map/c/:county[/:muni] — disambiguation form)
 *  Query params: `llz` (view, owned by CrashMapSection) + `yr` (years,
 *  owned by the shared PageFiltersProvider — same param as the plots +
 *  tables on the homepage).
 */
import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { CrashMapSection } from "@/src/map/CrashMapSection"
import { PageFiltersProvider } from "@/src/PageFiltersContext"
import { normalize } from "@/src/county"
import { RegionNotFound } from "@/src/components/RegionNotFound"

// Local county-name → cc map (subset; full table in nj_crashes data files).
const COUNTY_NAMES: Record<string, number> = {
    atlantic: 1, bergen: 2, burlington: 3, camden: 4, capemay: 5, "cape-may": 5,
    cumberland: 6, essex: 7, gloucester: 8, hudson: 9, hunterdon: 10, mercer: 11,
    middlesex: 12, monmouth: 13, morris: 14, ocean: 15, passaic: 16, salem: 17,
    somerset: 18, sussex: 19, union: 20, warren: 21,
}

function countyFromParam(param?: string): number | undefined {
    if (!param) return undefined
    const k = param.toLowerCase().replace(/\s+/g, "-")
    return COUNTY_NAMES[k]
}

type Cc2Mc2Mn = Record<string, { cn: string; mc2mn: Record<string, string> }>

function muniFromParam(cc: number | undefined, muni: string | undefined, lookup: Cc2Mc2Mn | null): number | undefined {
    if (!cc || !muni || !lookup) return undefined
    const mc2mn = lookup[String(cc)]?.mc2mn
    if (!mc2mn) return undefined
    const norm = muni.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim()
    for (const [mc, name] of Object.entries(mc2mn)) {
        if (name.toLowerCase() === norm) return Number(mc)
    }
    return undefined
}

function titleCase(s: string): string {
    return s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

export default function CrashMapPage() {
    const params = useParams()
    const navigate = useNavigate()
    const [cc2mc2mn, setCc2mc2mn] = useState<Cc2Mc2Mn | null>(null)
    useEffect(() => {
        fetch("/njdot/cc2mc2mn.json").then(r => r.json()).then(setCc2mc2mn).catch(() => {})
    }, [])
    const cc = countyFromParam(params.county)
    const mc = muniFromParam(cc, params.muni, cc2mc2mn)
    // Distinguish "no muni segment in URL" (params.muni undefined → county
    // view) from "muni segment present but didn't resolve" (mc undefined
    // after lookup). Only the latter triggers a not-found panel; the
    // former is the intended county-view flow.
    const countyUnresolved = params.county !== undefined && cc === undefined
    const muniUnresolved = cc !== undefined && params.muni !== undefined && cc2mc2mn !== null && mc === undefined

    const onOutlineClick = useCallback((feature: any) => {
        const name: string | undefined = feature?.properties?.name
        if (!name) return
        // Statewide → drill into the clicked county. (Muni-level drill
        // needs sharded muni-boundary geojson; not wired yet.)
        if (cc === undefined) navigate(`/map/${normalize(name)}`)
    }, [cc, navigate])

    const muniName = params.muni ? titleCase(params.muni) : undefined
    const countyName = params.county ? titleCase(params.county) : undefined
    const title = cc === undefined
        ? "NJ Crash Map"
        : mc !== undefined
            ? `${muniName}, ${countyName} County Crash Map`
            : `${countyName} County Crash Map`
    const scopeLabel = mc !== undefined
        ? `${muniName}, ${countyName} County`
        : cc !== undefined
            ? `${countyName} County`
            : undefined
    const detailsHref = params.muni
        ? `/c/${params.county}/${params.muni}`
        : params.county
            ? `/c/${params.county}`
            : "/"

    if (countyUnresolved) {
        // `cc2mc2mn` (from public JSON) may still be loading — the
        // component's own render handles that by not showing suggestions.
        // Cast: local shape is a subset of `CC2MC2MN`.
        return (
            <PageFiltersProvider>
                <Head title="Not found — NJ Crash Map" description="Unknown county" url={url} />
                <RegionNotFound kind="county" slug={params.county!} cc2mc2mn={cc2mc2mn as any} />
            </PageFiltersProvider>
        )
    }
    if (muniUnresolved) {
        const mc2mn = cc2mc2mn?.[String(cc)]?.mc2mn as Record<number, string> | undefined
        return (
            <PageFiltersProvider>
                <Head title={`Not found — ${countyName} County Crash Map`} description="Unknown municipality" url={url} />
                <RegionNotFound
                    kind="muni"
                    slug={params.muni!}
                    countyName={countyName}
                    countySlug={params.county!}
                    mc2mn={mc2mn}
                />
            </PageFiltersProvider>
        )
    }
    return (
        <PageFiltersProvider>
            <Head title={title} description="Interactive crash map" url={url} />
            {params.muni && !cc2mc2mn ? (
                <div style={{ padding: "1em" }}>Loading map…</div>
            ) : (
                <CrashMapSection
                    key={`map-${cc ?? ""}-${mc ?? ""}`}
                    cc={cc ?? null}
                    mc={mc ?? null}
                    fullScreen
                    scopeLabel={scopeLabel}
                    detailsHref={detailsHref}
                    onOutlineClick={cc === undefined ? onOutlineClick : undefined}
                />
            )}
        </PageFiltersProvider>
    )
}

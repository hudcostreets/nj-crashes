/** Hidden `/dev/ab` route: side-by-side algo A/B for map-viz tuning.
 *
 *  Renders a grid of iframes across a curated viewport list, each row
 *  showing the same viewport under two different viz modes (or, more
 *  generally, two different `?...` query strings) so the user can
 *  eyeball the visual + bytes tradeoff without hand-flipping URLs.
 *
 *  Default: `hex` vs `circle` across the curated `SCENARIOS` list.
 *
 *  Overrides via URL params:
 *    - `a=<query>` — extra query params for the left column
 *    - `b=<query>` — extra query params for the right column
 *    - `only=<comma-separated scenario names>` — filter the list
 *
 *  Example:
 *    /dev/ab?a=viz=hex&b=viz=circle       (default)
 *    /dev/ab?a=viz=circle&b=viz=circle&only=state-z10-bergen
 *
 *  This route is deliberately not linked from anywhere in the app —
 *  it's a dev tool, discoverable via specs / `git grep DevAb` only.
 */
import { useSearchParams } from "react-router-dom"
import { useState } from "react"

type Scenario = {
    name: string
    /** Relative URL under www root (e.g. "/", "/jersey-city"). */
    path: string
    /** `lat_lon_zoom_pitch_bearing`, `_`-delimited (converted to `+` on
     *  the wire since `llz` uses `+` as a delimiter). */
    llz: string
}

/** Kept in sync with `www/e2e/map-viz-matrix.spec.ts` — same list is
 *  used both for CI screenshot regression and live A/B eval. Change one,
 *  change the other. */
const SCENARIOS: Scenario[] = [
    { name: "state-z07-overview",   path: "/",             llz: "40.20_-74.50_7.5_0_0" },
    { name: "state-z08-southern",   path: "/",             llz: "39.89_-74.90_8.3_0_0" },
    { name: "state-z10-central",    path: "/",             llz: "40.49_-74.43_10.0_0_0" },
    { name: "state-z10-bergen",     path: "/",             llz: "40.79_-74.06_10.94_17_10" },
    { name: "state-z11-newark",     path: "/",             llz: "40.74_-74.17_11.5_0_0" },
    { name: "hudson-z12",           path: "/c/hudson",     llz: "40.71_-74.09_12.0_0_0" },
    { name: "mercer-z11",           path: "/c/mercer",     llz: "40.27_-74.65_11.0_0_0" },
    { name: "jersey-city-z13",     path: "/jersey-city",   llz: "40.72_-74.06_13.0_0_0" },
    { name: "jersey-city-z14",     path: "/jersey-city",   llz: "40.7251_-74.0467_13.81_17_-4" },
    { name: "union-city-z15",      path: "/union-city",    llz: "40.7691_-74.0331_15.00_26_3" },
    { name: "downtown-jc-z17",     path: "/",              llz: "40.7262_-74.0524_16.91_17_-4" },
    { name: "raritan-circle-z18",  path: "/",              llz: "40.5757_-74.6293_17.20_31_-1" },
    { name: "somerville-circle-z20", path: "/",            llz: "40.5755_-74.6294_20.00_31_-1" },
]

function urlFor(sc: Scenario, extraQuery: string): string {
    const q = new URLSearchParams()
    q.set("llz", sc.llz.replace(/_/g, "+"))
    // Append user-supplied params. Format: `viz=circle&x=1&y=2`.
    for (const kv of extraQuery.split("&")) {
        if (!kv) continue
        const [k, v = ""] = kv.split("=")
        if (k) q.set(k, v)
    }
    // `#map` to auto-scroll to the map panel inside GeoHome / muni pages.
    return `${sc.path}?${q.toString()}#map`
}

export default function DevAb() {
    const [params, setParams] = useSearchParams()
    const a = params.get("a") ?? "viz=hex"
    const b = params.get("b") ?? "viz=circle"
    const only = params.get("only")
    const [aInput, setAInput] = useState(a)
    const [bInput, setBInput] = useState(b)

    const scenarios = only
        ? SCENARIOS.filter(s => only.split(",").includes(s.name))
        : SCENARIOS

    const apply = () => {
        const next = new URLSearchParams(params)
        next.set("a", aInput)
        next.set("b", bInput)
        setParams(next, { replace: true })
    }

    return (
        <div style={{ padding: 12, fontFamily: "system-ui" }}>
            <h1 style={{ fontSize: "1.2em", margin: "4px 0" }}>Map viz A/B</h1>
            <p style={{ opacity: 0.8, fontSize: "0.9em", marginTop: 0 }}>
                Side-by-side viewport rows; left column = <code>a</code>, right = <code>b</code>.
                Each cell is an <code>iframe</code> to the real app under those params.
                Edit the query strings below and hit Apply.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, fontSize: "0.85em" }}>
                <label>A: <input value={aInput} onChange={e => setAInput(e.target.value)} style={{ width: 180 }} /></label>
                <label>B: <input value={bInput} onChange={e => setBInput(e.target.value)} style={{ width: 180 }} /></label>
                <button onClick={apply}>Apply</button>
                {only && <span style={{ opacity: 0.6 }}>filtered to: {only}</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {scenarios.map(sc => (
                    <div key={sc.name}>
                        <div style={{ fontSize: "0.85em", fontWeight: 600, marginBottom: 4 }}>
                            {sc.name} <span style={{ opacity: 0.5, fontWeight: 400 }}>· {sc.path} @ {sc.llz}</span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                            <iframe
                                src={urlFor(sc, a)}
                                title={`${sc.name}-a`}
                                style={{ width: "100%", height: 560, border: "1px solid #333", borderRadius: 4 }}
                            />
                            <iframe
                                src={urlFor(sc, b)}
                                title={`${sc.name}-b`}
                                style={{ width: "100%", height: 560, border: "1px solid #333", borderRadius: 4 }}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

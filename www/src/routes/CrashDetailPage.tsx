import { useEffect, useMemo, useState } from "react"
import { useParams, Link } from "react-router-dom"
import moment from "moment-timezone"
import { Head } from "@/src/lib/head"
import { url as siteUrl } from "@/src/site"
import { apiUrl } from "@/src/api"
import { CC2MC2MN, normalize } from "@/src/county"
import { loadCC2MC2MN } from "@/src/lib/data"
import { ConditionMap } from "@/src/use-njdot-crashes"
import css from "@/src/home.module.scss"

type Crash = {
    id: number
    year: number
    cc: number
    mc: number
    case: string
    dt: string
    severity: string
    road?: string | null
    cross_street?: string | null
    route?: number | null
    sri?: string | null
    mp?: number | null
    speed_limit?: number | null
    speed_limit_cross?: number | null
    light_condition?: number | null
    surface_condition?: number | null
    env_condition?: number | null
    road_surface?: number | null
    road_divided?: number | null
    alcohol?: boolean | number | null
    hazmat?: boolean | number | null
    cell_phone?: boolean | number | null
    pdn?: string | null
    olat?: number | null
    olon?: number | null
    ilat?: number | null
    ilon?: number | null
    tk?: number | null
    ti?: number | null
    pk?: number | null
    pi?: number | null
    tv?: number | null
    occ?: number | null
}

type Vehicle = {
    id: number
    crash_id: number
    vn: number | null
    make?: string | null
    model?: string | null
    vy?: number | null
    color?: string | null
    type?: number | null
    damage?: number | null
    damage_loc?: number | null
    impact_loc?: number | null
    departure?: number | null
    dir?: number | null
    hit_run?: boolean | number | null
}

type Occupant = {
    crash_id: number
    vehicle_id: number | null
    pos: number | null
    condition: number | null
    eject: number | null
    age: number | null
    sex: string | null
    inj_loc: number | null
    inj_type: number | null
}

type Pedestrian = {
    crash_id: number
    pn: number | null
    condition: number | null
    age: number | null
    sex: string | null
    inj_loc: number | null
    inj_type: number | null
    cyclist: boolean | number | null
}

type CrashDetailResponse = {
    crash: Crash
    vehicles: Vehicle[]
    occupants: Occupant[]
    pedestrians: Pedestrian[]
}

const SEVERITY_LABEL: Record<string, string> = { f: "Fatal", i: "Injury", p: "Property Damage Only" }

// NJDOT code maps. Sourced from NJDOT 2017 user manual + visual inspection
// of common values. Where unknown, fall back to "code N".
const LIGHT_CONDITION: Record<number, string> = {
    1: "Daylight", 2: "Dawn", 3: "Dusk",
    4: "Dark (lit)", 5: "Dark (unlit)", 6: "Dark (unknown lighting)",
    99: "Unknown",
}
const SURFACE_CONDITION: Record<number, string> = {
    1: "Dry", 2: "Wet", 3: "Snowy", 4: "Icy", 5: "Slush", 6: "Water (standing/moving)",
    7: "Sand", 8: "Oil", 9: "Mud, dirt, gravel", 99: "Unknown",
}
const ENV_CONDITION: Record<number, string> = {
    1: "Clear", 2: "Rain", 3: "Snow", 4: "Fog/smog/smoke", 5: "Sleet/hail/freezing rain",
    6: "Severe crosswinds", 7: "Blowing sand/dirt/snow", 99: "Unknown",
}
const VEHICLE_TYPE: Record<number, string> = {
    1: "Passenger car", 2: "Light truck/van", 3: "Sport utility",
    4: "Cargo van", 5: "Truck (heavy)", 6: "Bus", 7: "Motorcycle",
    8: "Bicycle", 9: "Other", 99: "Unknown",
}
const DAMAGE: Record<number, string> = {
    0: "Unknown", 1: "None", 2: "Minor", 3: "Moderate", 4: "Disabled",
}

function fmtCode<T extends number>(code: T | null | undefined, map: Record<number, string>): string {
    if (code == null) return "—"
    return map[code] ?? `code ${code}`
}

function fmtBool(v: boolean | number | null | undefined): string {
    if (v == null) return "—"
    return v ? "Yes" : "No"
}

function fmtVehicleHeader(v: Vehicle): string {
    const parts: string[] = []
    if (v.vy) parts.push(String(v.vy))
    if (v.make) parts.push(v.make)
    if (v.model) parts.push(v.model)
    return parts.length ? parts.join(" ") : "Unknown vehicle"
}

export default function CrashDetailPage() {
    const params = useParams<{ year: string; cc: string; mc: string; case: string }>()
    const year = Number(params.year)
    const cc = Number(params.cc)
    const mc = Number(params.mc)
    const caseStr = params.case ? decodeURIComponent(params.case) : ""

    const [data, setData] = useState<CrashDetailResponse | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [cc2mc2mn, setCc2mc2mn] = useState<CC2MC2MN | null>(null)

    useEffect(() => {
        loadCC2MC2MN().then(setCc2mc2mn).catch(() => { /* names stay numeric */ })
    }, [])

    useEffect(() => {
        if (!Number.isFinite(year) || !Number.isFinite(cc) || !Number.isFinite(mc) || !caseStr) {
            setError("Invalid crash URL")
            return
        }
        let cancelled = false
        setData(null); setError(null)
        const u = apiUrl("/njdot/crash", { year, cc, mc, case: caseStr })
        fetch(u)
            .then(r => {
                if (r.status === 404) throw new Error("Crash not found")
                if (!r.ok) throw new Error(`API ${r.status}`)
                return r.json() as Promise<CrashDetailResponse>
            })
            .then(d => { if (!cancelled) setData(d) })
            .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
        return () => { cancelled = true }
    }, [year, cc, mc, caseStr])

    const occByVehicle = useMemo(() => {
        const m = new Map<number | null, Occupant[]>()
        for (const o of data?.occupants ?? []) {
            const k = o.vehicle_id ?? null
            const list = m.get(k) ?? []
            list.push(o)
            m.set(k, list)
        }
        return m
    }, [data?.occupants])

    if (error) {
        return <div className={css.container}>
            <main className={css.main}>
                <Head title="Crash not found" description="" url={siteUrl} />
                <h1>Crash not found</h1>
                <p>{error}</p>
                <p>URL: <code>{`${year}/${cc}/${mc}/${caseStr}`}</code></p>
            </main>
        </div>
    }
    if (!data) {
        return <div className={css.container}>
            <main className={css.main}><p>Loading…</p></main>
        </div>
    }

    const { crash, vehicles, pedestrians } = data
    const dt = moment.tz(crash.dt, "America/New_York")
    const dateLabel = dt.format("ddd MMM D, YYYY · h:mm A")
    const sevLabel = SEVERITY_LABEL[crash.severity] ?? crash.severity
    const county = cc2mc2mn?.[crash.cc]
    const countyName = county?.cn
    const muniName = county?.mc2mn?.[crash.mc]
    const lat = crash.ilat ?? crash.olat ?? null
    const lon = crash.ilon ?? crash.olon ?? null
    const title = `Crash · ${dt.format("YYYY-MM-DD")} · ${muniName ?? `cc${crash.cc}/mc${crash.mc}`}`

    return <div className={css.container}>
        <Head title={title} description={`${sevLabel} crash, ${dateLabel}`} url={siteUrl} />
        <main className={css.main}>
            <p style={{ fontSize: "0.85em" }}>
                {countyName && <Link to={`/c/${normalize(countyName)}`}>{countyName} County</Link>}
                {muniName && countyName && <> · <Link to={`/c/${normalize(countyName)}/${normalize(muniName)}`}>{muniName}</Link></>}
            </p>
            <h1 style={{ marginBottom: "0.2em" }}>{sevLabel} crash · {dt.format("MMM D, YYYY")}</h1>
            <p style={{ marginTop: 0, color: "#888" }}>{dateLabel} · case <code>{crash.case}</code></p>

            <h2 id="location">Location</h2>
            <ul>
                {crash.road && <li><b>Road:</b> {crash.road}{crash.route ? ` (Route ${crash.route})` : ""}</li>}
                {crash.cross_street && <li><b>Cross street:</b> {crash.cross_street}</li>}
                {crash.mp != null && <li><b>Milepost:</b> {crash.mp.toFixed(2)}</li>}
                {crash.speed_limit != null && <li><b>Speed limit:</b> {crash.speed_limit}</li>}
                {crash.pdn && <li><b>Reporting agency:</b> {crash.pdn}</li>}
                {lat != null && lon != null && (
                    <li>
                        <b>Coordinates:</b>{" "}
                        <a href={`https://www.google.com/maps/?q=${lat},${lon}`} target="_blank" rel="noreferrer">
                            {lat.toFixed(5)}, {lon.toFixed(5)}
                        </a>
                    </li>
                )}
            </ul>

            <h2 id="conditions">Conditions</h2>
            <ul>
                <li><b>Light:</b> {fmtCode(crash.light_condition, LIGHT_CONDITION)}</li>
                <li><b>Surface:</b> {fmtCode(crash.surface_condition, SURFACE_CONDITION)}</li>
                <li><b>Environment:</b> {fmtCode(crash.env_condition, ENV_CONDITION)}</li>
                <li><b>Alcohol involved:</b> {fmtBool(crash.alcohol)}</li>
                <li><b>Cell phone involved:</b> {fmtBool(crash.cell_phone)}</li>
                {crash.hazmat ? <li><b>Hazmat:</b> Yes</li> : null}
            </ul>

            <h2 id="casualties">Casualties</h2>
            <ul>
                {crash.tk ? <li>Total killed: {crash.tk}</li> : null}
                {crash.ti ? <li>Total injured: {crash.ti}</li> : null}
                {crash.pk ? <li>Pedestrians killed: {crash.pk}</li> : null}
                {crash.pi ? <li>Pedestrians injured: {crash.pi}</li> : null}
                {!(crash.tk || crash.ti || crash.pk || crash.pi) && <li>No reported casualties</li>}
            </ul>

            <h2 id="vehicles">Vehicles ({vehicles.length})</h2>
            {vehicles.length === 0
                ? <p>No vehicle records.</p>
                : <ul>
                    {vehicles.map(v => {
                        const occs = occByVehicle.get(v.id) ?? []
                        return (
                            <li key={v.id} style={{ marginBottom: "0.5em" }}>
                                <b>#{v.vn ?? "?"}</b>: {fmtVehicleHeader(v)}
                                {v.color ? <> ({v.color})</> : null}
                                {" · "}{fmtCode(v.type, VEHICLE_TYPE)}
                                {" · "}damage {fmtCode(v.damage, DAMAGE)}
                                {v.hit_run ? <> · <span style={{ color: "#d00" }}>hit-and-run</span></> : null}
                                {occs.length > 0 && (
                                    <ul>
                                        {occs.map((o, i) => {
                                            const cond = o.condition ?? 0
                                            const condStr = ConditionMap[cond]?.txt ?? `condition ${cond}`
                                            const role = o.pos === 1 ? "Driver" : "Passenger"
                                            const ageSex = `${o.age ?? ""}${o.sex === "M" || o.sex === "F" ? o.sex : ""}`
                                            return <li key={i}>{role}{ageSex ? `, ${ageSex}` : ""} — {condStr}</li>
                                        })}
                                    </ul>
                                )}
                            </li>
                        )
                    })}
                </ul>
            }

            {pedestrians.length > 0 && <>
                <h2 id="pedestrians">Pedestrians & cyclists ({pedestrians.length})</h2>
                <ul>
                    {pedestrians.map((p, i) => {
                        const cond = p.condition ?? 0
                        const condStr = ConditionMap[cond]?.txt ?? `condition ${cond}`
                        const role = p.cyclist ? "Cyclist" : "Pedestrian"
                        const ageSex = `${p.age ?? ""}${p.sex === "M" || p.sex === "F" ? p.sex : ""}`
                        return <li key={i}>{role}{ageSex ? `, ${ageSex}` : ""} — {condStr}</li>
                    })}
                </ul>
            </>}
        </main>
    </div>
}

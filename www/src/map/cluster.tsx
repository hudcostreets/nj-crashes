import { Crash } from "@/src/map/types";
import { Dispatch, ReactNode, useEffect, useMemo, useRef } from "react";
import singleton from "@rdub/base/singleton";
import { LeafletEventHandlerFnMap } from "leaflet"
import { Circle, Popup } from "react-leaflet"
import strftime from 'strftime'
import css from './cluster.module.scss'

const { sqrt } = Math

export type Cluster = {
    key: string
    lon: number
    lat: number
    tk: number
    ti: number
    tv: number
    pk: number
    pi: number
    crashes: Omit<Crash, 'lat' | 'lon'>[]
}

export type Props = {
    cluster: Cluster
    baseRadius: number
    hoveredClusterKey: string | undefined
    setHoveredClusterKey: Dispatch<string | undefined>
    selectedClusterKey: string | undefined
    setSelectedClusterKey: Dispatch<string | undefined>
}

export function Cluster(
    {
        cluster: { key, lat, lon, tk, ti, tv, crashes, },
        baseRadius,
        hoveredClusterKey,
        setHoveredClusterKey,
        selectedClusterKey,
        setSelectedClusterKey,
    }: Props
) {
    const numCrashes = crashes.length
    const showPopup = key === hoveredClusterKey || key === selectedClusterKey
    const ref = useRef<any | null>(null)
    const radius = baseRadius * sqrt(numCrashes)
    const color = crashes[0].severity === 'f' ? 'red' : crashes[0].severity === 'i' ? 'orange' : 'yellow'
    const popupContent = useMemo(
        () => {
            if (!showPopup) return null
            const SRI = singleton(crashes.map(({ sri }) => sri))
            const MP = SRI && singleton(crashes.map(({ mp }) => mp))
            let metadata: ReactNode = null
            if (SRI) {
                if (MP !== null) {
                    metadata = <span>SRI {SRI}, MP {MP}</span>
                } else {
                    metadata = <span>SRI {SRI}</span>
                }
            }
            const hasFatal = tk > 0
            const hasInjuries = ti > 0
            const stats: string[] = []
            if (tk) stats.push(`${tk} killed`)
            if (ti) stats.push(`${ti} injured`)
            if (tv) stats.push(`${tv} vehicles`)
            const statsStr = stats.length ? `: ${stats.join(", ")}` : ``

            // const crashEmoji = "💥".repeat(numCrashes)
            // const fatalEmjoi = "☠️".repeat(tk)
            // const injuryEmoji = "🏥".repeat(ti)
            // const vehicleEmoji = "🚗".repeat(tv)
            // const emoji = [ crashEmoji, fatalEmjoi, injuryEmoji, vehicleEmoji ].filter(s => s).map((s, idx) => <div key={idx}>{s}</div>)
            return <>
                <div>{numCrashes} {numCrashes > 1 ? "crashes" : "crash"}{statsStr}</div>
                {/*<div className={css.clusterIcon}>{emoji}</div>*/}
                <table className={css.clusterTable}>
                    <thead>
                    <tr>
                        <th colSpan={3}>Date</th>
                        <th>Time</th>
                        {hasFatal ? <th>Killed</th> : null}
                        {hasInjuries ? <th>Injured</th> : null}
                        <th>Vehicles</th>
                        {SRI ? null : <th>SRI</th>}
                        {MP !== null ? null : <th>MP</th>}
                    </tr>
                    </thead>
                    <tbody>{
                        crashes.map(({ dt, tk, ti, tv, sri, mp, }, idx) => {
                            const year = dt.getFullYear()
                            const month = dt.getMonth()
                            const date = dt.getDate()
                            let yearStr = year.toString()
                            let monthStr = dt.toLocaleString('en-US', { month: 'short' })
                            let dateStr = date.toString()
                            const { dt: prev } = idx > 0 ? crashes[idx - 1] : { dt: null }
                            if (prev) {
                                if (prev.getFullYear() === year) yearStr = ""
                                if (prev.getMonth() === month) monthStr = ""
                                if (prev.getDate() === date) dateStr = ""
                            }
                            const fatalEmjoi = "☠️".repeat(tk)
                            const injuryEmoji = "🏥".repeat(ti)
                            const vehicleEmoji = "🚗".repeat(tv)
                            return <tr key={idx}>
                                <td>{yearStr}</td>
                                <td>{monthStr}</td>
                                <td>{dateStr}</td>
                                <td>{strftime('%H:%M', dt)}</td>
                                {/*{hasFatal ? <td>{tk ? tk : ""}</td> : null}*/}
                                {/*<td>{ti ? ti : ""}</td>*/}
                                {/*<td>{tv ? tv : ""}</td>*/}
                                {hasFatal ? <td>{tk ? fatalEmjoi : ""}</td> : null}
                                <td>{ti ? injuryEmoji : ""}</td>
                                <td>{tv ? vehicleEmoji : ""}</td>
                                {SRI ? null : <td>{sri}</td>}
                                {MP !== null ? null : <td>{mp}</td>}
                            </tr>
                        })
                    }</tbody>
                </table>
                <details>
                    <summary>Location</summary>
                    <div className={css.llDetails}>{lat}, {lon}</div>
                    <div>{metadata}</div>
                </details>
            </>
        },
        [ showPopup, crashes, lat, lon, numCrashes, ti, tk, tv, ]
    )
    useEffect(
        () => {
            if (!popupContent) {
                ref.current?.closePopup()
                return
            } else {
                ref.current?.openPopup()
            }
        },
        [ popupContent ]
    )
    // const r = 7
    // const circles = Array(numCrashes).fill(0).map((_, idx) =>
    //     `<rect width=${r} height=${r} x=${1.2*r*idx} y=${0} fill="orange"></rect>`
    //     //`<circle r=${r} cx=${2*r*idx} fill="orange"></circle>`
    // ).join("")
    const eventHandlers: LeafletEventHandlerFnMap = useMemo(
        () => ({
            mouseover: e => {
                console.log("mouseover", e)
                setHoveredClusterKey(key)
            },
            mouseout: e => {
                console.log("mouseout", e)
                // setHoveredClusterKey(undefined)
            },
            click: e => {
                console.log("click", e)
                setSelectedClusterKey(key)
            },
        }),
        [ key, setHoveredClusterKey, setSelectedClusterKey, ]
    )
    const markerProps = { ref, key, eventHandlers }
    // const emoji = useMemo(
    //     () => {
    //         const crashEmoji = "💥".repeat(numCrashes)
    //         const fatalEmjoi = "☠️".repeat(tk)
    //         const injuryEmoji = "🏥".repeat(ti)
    //         const vehicleEmoji = "🚗".repeat(tv)
    //         const emoji = [ crashEmoji, fatalEmjoi, injuryEmoji, vehicleEmoji ].filter(s => s).map(s => `<div>${s}</div>`).join("")
    //         return emoji
    //     },
    //     [ numCrashes, tk, ti, tv ]
    // )
    // const emojiMarker = useMemo(
    //     () => {
    //         // if (!showPopup) return null
    //         const marker =
    //             <Marker
    //                 position={[lat, lon]}
    //                 icon={L.divIcon({
    //                     className: css.clusterIcon,
    //                     html: `<div class="${css.cluster}" style="margin-top: 5px;">${emoji}</div>`,
    //                     // html: `<svg>${circles}</svg>`,
    //                     iconSize: [ 40, 40 ],
    //                 })}
    //                 // {...markerProps}
    //             >
    //             </Marker>
    //         return marker
    //     },
    //     [ lat, lon, emoji ]
    // )
    return <>
        <Circle
            center={[lat, lon]}
            radius={radius}
            color={color}
            {...markerProps}
        >
            <Popup keepInView={false}>{popupContent}</Popup>
        </Circle>
        {/*{emojiMarker}*/}
    </>
}

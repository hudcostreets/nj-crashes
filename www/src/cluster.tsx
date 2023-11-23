import { Crash } from "../pages/map";
import { Dispatch, ReactNode, useEffect, useMemo, useRef } from "react";
import singleton from "next-utils/singleton";
import * as ReactLeaflet from "react-leaflet"
const { sqrt } = Math
import strftime from 'strftime'
import css from './map.module.scss'

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
    RL: Pick<typeof ReactLeaflet, 'Circle' | 'Popup'>
    baseRadius: number
    hoveredClusterKey: string | undefined
    setHoveredClusterKey: Dispatch<string | undefined>
    selectedClusterKey: string | undefined
    setSelectedClusterKey: Dispatch<string | undefined>
}

export function Cluster(
    {
        cluster: { key, lat, lon, tk, ti, tv, crashes, },
        RL: { Circle, Popup, },
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
            const SRI = singleton(crashes.map(({ sri }) => sri))
            const MP = SRI && singleton(crashes.map(({ mp }) => mp))
            let metadata: ReactNode = null
            if (SRI) {
                if (MP) {
                    metadata = <span>SRI {SRI}, MP {MP}</span>
                } else {
                    metadata = <span>SRI {SRI}</span>
                }
            }
            const hasFatal = tk > 0
            const hasInjuries = ti > 0
            if (!showPopup) return null
            return <>
                <div>{numCrashes} {numCrashes > 1 ? "crashes" : "crash"}: {tk ? `${tk} killed, ` : ""}{ti} injured, {tv} vehicles</div>
                <table className={css.clusterTable}>
                    <thead>
                    <tr>
                        <th colSpan={4}>Date</th>
                        {hasFatal ? <th>Killed</th> : null}
                        {hasInjuries ? <th>Injured</th> : null}
                        <th>Vehicles</th>
                        {SRI ? null : <th>SRI</th>}
                        {MP ? null : <th>MP</th>}
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
                            return <tr key={idx}>
                                <td>{yearStr}</td>
                                <td>{monthStr}</td>
                                <td>{dateStr}</td>
                                <td>{strftime('%H:%M', dt)}</td>
                                {hasFatal ? <td>{tk ? tk : ""}</td> : null}
                                <td>{ti ? ti : ""}</td>
                                <td>{tv ? tv : ""}</td>
                                <td>{SRI ? null : sri}</td>
                                <td>{MP ? null : mp}</td>
                            </tr>
                        })
                    }</tbody>
                </table>
                <details>
                    <summary>Location</summary>
                    <div>{lat}, {lon}</div>
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
    );
    return <Circle
        ref={ref}
        key={key}
        center={[lat, lon]}
        radius={radius}
        color={color}
        eventHandlers={{
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
        }}
    >
        <Popup keepInView={false}>{popupContent}</Popup>
    </Circle>
}

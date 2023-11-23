import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMapEvents } from "react-leaflet"
const { sqrt } = Math
import * as ReactLeaflet from "react-leaflet";
import strftime from 'strftime'
import css from './map.module.scss'

import 'leaflet/dist/leaflet.css';
import { Crash } from "../pages/map";
import { Dispatch, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { entries } from "next-utils/objs";
import { LL } from "next-utils/params";
import singleton from "next-utils/singleton";
import { useMetersPerPixel } from "next-utils/map/mPerPx";
const { max, min, log2 } = Math

export const MAPS = {
    openstreetmap: {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "&copy; <a href=&quot;http://osm.org/copyright&quot;>OpenStreetMap</a> contributors",
    },
    alidade_smooth_dark: {
        url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors',
    },
}

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

export default function MapBody(
    {TileLayer, Marker, Circle, CircleMarker, Polyline, Pane, Popup, Tooltip, useMapEvents, useMap }: typeof ReactLeaflet,
    { crashes, setLL, setZoom }: {
        crashes: Crash[]
        setLL: Dispatch<LL>
        setZoom: Dispatch<number>
    },
) {
    const { url, attribution } = MAPS['alidade_smooth_dark']
    const [ hoveredClusterKey, setHoveredClusterKey ] = useState<string>()
    const [ selectedClusterKey, setSelectedClusterKey ] = useState<string>()

    // const { url, attribution } = MAPS['openstreetmap']
    const map = useMap()
    const zoom = map.getZoom()
    const mPerPx = useMetersPerPixel(map, zoom)
    console.log("MapBody render", zoom)
    useMapEvents({
        movestart: () => {
            // setHoveredClusterKey(undefined)
            // setSelectedClusterKey(undefined)
        },
        moveend: () => setLL(map.getCenter()),
        zoom: () => setZoom(map.getZoom()),
        tooltipopen: e => console.log("tooltipopen", e),
        mouseover: e => console.log("mouseover", e),
        click: () => {
            console.log("click")
            setHoveredClusterKey(undefined)
            setSelectedClusterKey(undefined)
        },
        mousemove: e => {
            // console.log("mousemove", e)
            // setHoveredClusterKey(undefined)
        },
    })

    const baseRadius = useMemo(
        () => {
            const [ minZoom, maxZoom ] = [ 12, 18 ]
            const [ minSize, maxSize ] = [ 1, 2 ]
            const baseRadius = minSize + max(0, zoom - minZoom) * (maxSize - minSize) / (maxZoom - minZoom)
            // const baseRadius = 1
            console.log("baseRadius", baseRadius, "mPerPx", mPerPx, "zoom", zoom,)
            return baseRadius
        },
        [ mPerPx, zoom ]
    )
    // const [ baseRadius, setBaseRadius ] = useState(5)

    const clusters: Cluster[] = useMemo(
        () => {
            const clusters: { [ll: string]: Crash[] } = {}
            crashes.forEach(crash => {
                const { lat, lon } = crash
                const key = `${lat},${lon}`
                if (!(key in clusters)) {
                    clusters[key] = []
                }
                clusters[key].push(crash)
            })
            return entries(clusters).map(([ key, crashes ]) => {
                const { lon, lat } = crashes[0]
                const trimmedCrashes = crashes.map(({ lon, lat, ...crash }) => crash)
                trimmedCrashes.sort((a, b) => a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0)
                let tk = 0, ti = 0, tv = 0, pk = 0, pi = 0
                trimmedCrashes.forEach(({ tk: _tk, ti: _ti, tv: _tv, pk: _pk, pi: _pi }) => {
                    if (_tk) tk += _tk
                    if (_ti) ti += _ti
                    if (_tv) tv += _tv
                    if (_pk) pk += _pk
                    if (_pi) pi += _pi
                })
                return {
                    key, lat, lon,
                    tk, ti, tv, pk, pi,
                    crashes: trimmedCrashes,
                }
            })
        },
        [ crashes ]
    )

    return <>
        <TileLayer url={url} attribution={attribution} />
        {
            clusters.map(({ key, lat, lon, tk, ti, tv, crashes, }, idx) => {
                const color = crashes[0].severity === 'f' ? 'red' : crashes[0].severity === 'i' ? 'orange' : 'yellow'
                const numCrashes = crashes.length
                const radius = baseRadius * sqrt(numCrashes)
                const showPopup = key === hoveredClusterKey || key === selectedClusterKey
                const ref = useRef<any | null>(null)
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
                const popupContent = useMemo(
                    () => {
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
                    [ showPopup ]
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
                    <Popup style={{ transition: "none", }} keepInView={false}>{popupContent}</Popup>
                </Circle>
            })
        }
    </>
}

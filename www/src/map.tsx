import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMapEvents } from "react-leaflet"
import {MapContainerProps} from "react-leaflet/lib/MapContainer"
import L from 'leaflet';
import MarkerIcon from 'leaflet/dist/images/marker-icon.png';
import MarkerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import MarkerShadow from 'leaflet/dist/images/marker-shadow.png';
const { sqrt } = Math
import * as ReactLeaflet from "react-leaflet";

import 'leaflet/dist/leaflet.css';
import { Crash } from "../pages/map";
import { Dispatch, useMemo, useState } from "react";
import { entries } from "next-utils/objs";
import { LL } from "next-utils/params";

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
    lon: number
    lat: number
    crashes: Crash[]
}

export default function MapBody(
    {TileLayer, Marker, Circle, CircleMarker, Polyline, Pane, Tooltip, useMapEvents, useMap }: typeof ReactLeaflet,
    { crashes, setLL, setZoom }: {
        crashes: Crash[]
        setLL: Dispatch<LL>
        setZoom: Dispatch<number>
    },
) {
    const { url, attribution } = MAPS['alidade_smooth_dark']
    // const { url, attribution } = MAPS['openstreetmap']
    const map = useMap()
    const zoom = map.getZoom()
    console.log("MapBody render", zoom)
    useMapEvents({
        moveend: () => setLL(map.getCenter()),
        zoom: () => setZoom(map.getZoom()),
        // click: () => { setSelectedStationId(undefined) },
    })

    const [ baseRadius, setBaseRadius ] = useState(5)

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
                return { lat, lon, crashes, }
            })
        },
        [ crashes ]
    )

    return <>
            <TileLayer url={url} attribution={attribution} />
            {
                clusters.map(({ lat, lon, crashes, }, idx) => {
                    const color = crashes[0].severity === 'f' ? 'red' : crashes[0].severity === 'i' ? 'orange' : 'yellow'
                    const numCrashes = crashes.length
                    const radius = baseRadius * sqrt(numCrashes)
                    return <Circle key={idx} center={[ lat, lon ]} radius={radius} color={color}>
                            <Tooltip>{numCrashes} crashes</Tooltip>
                        </Circle>
                })
            }
    </>
}

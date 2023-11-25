import { Crash } from "../pages/map";
import { Dispatch, useMemo, useState } from "react";
import { LL } from "next-utils/params";
import { useMap, useMapEvents } from "react-leaflet";
import { useMetersPerPixel } from "next-utils/map/mPerPx";
import { Cluster } from "./cluster";
import { entries } from "next-utils/objs";
import * as cluster from "./cluster";
import L from "leaflet";

const { max } = Math

export type Props = {
    crashes: Crash[]
    setLL: Dispatch<LL>
    setZoom: Dispatch<number>
}

export function Clusters({ crashes, setLL, setZoom }: Props) {
    const [ hoveredClusterKey, setHoveredClusterKey ] = useState<string>()
    const [ selectedClusterKey, setSelectedClusterKey ] = useState<string>()
    const [ tolerance, setTolerance ] = useState(12)

    // const { url, attribution } = MAPS['openstreetmap']
    const map = useMap()
    const canvas = useMemo(() => L.canvas({ tolerance }), [ tolerance ])
    const zoom = map.getZoom()
    const mPerPx = useMetersPerPixel(map, zoom)
    console.log("Clusters render", zoom)
    useMapEvents({
        movestart: () => {
            // setHoveredClusterKey(undefined)
            // setSelectedClusterKey(undefined)
        },
        moveend: () => setLL(map.getCenter()),
        zoom: () => setZoom(map.getZoom()),
        // tooltipopen: e => console.log("tooltipopen", e),
        // mouseover: e => console.log("mouseover", e),
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
    const clustersElem = useMemo(
        () => {
            console.log("clustersElem")
            const clusterProps: Omit<cluster.Props, 'cluster'> = {
                canvas,
                baseRadius,
                hoveredClusterKey,
                setHoveredClusterKey,
                selectedClusterKey,
                setSelectedClusterKey,
            }
            return <>{
                clusters.map((cluster) =>
                    <Cluster key={cluster.key} cluster={cluster} {...clusterProps} />
                )
            }</>
        },
        [
            clusters,
            baseRadius,
            hoveredClusterKey,
            setHoveredClusterKey,
            selectedClusterKey,
            setSelectedClusterKey,
        ]
    )
    return clustersElem
}

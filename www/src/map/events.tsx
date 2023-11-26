import React, { Dispatch, ReactNode, useMemo, useState } from "react";
import L, { LatLng } from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";
import { CanvasContext } from "@/src/map/canvas";

export type Props = {
    setLL: Dispatch<LatLng>
    setZoom: Dispatch<number>
    children: ReactNode
}

export default function MapEvents({ setLL, setZoom, children }: Props) {
    const [ tolerance, setTolerance ] = useState(12)
    const map = useMap()
    const canvas = useMemo(() => L.canvas({ tolerance, padding: 0.5, }), [ tolerance ])
    useMapEvents({
        moveend: () => setLL(map.getCenter()),
        zoom: () => setZoom(map.getZoom()),
    })
    return <CanvasContext.Provider value={canvas}>{
        children
    }</CanvasContext.Provider>
}

import React, { Dispatch, ReactNode } from "react";
import { LatLng } from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

export type Props = {
    setLL: Dispatch<LatLng>
    setZoom: Dispatch<number>
    children: ReactNode
}

export default function MapEvents({ setLL, setZoom, children }: Props) {
    const map = useMap()
    useMapEvents({
        moveend: () => setLL(map.getCenter()),
        zoom: () => setZoom(map.getZoom()),
    })
    return <>{children}</>
}

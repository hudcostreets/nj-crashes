import React, { Dispatch, ReactNode } from "react";
import { LatLng, LeafletMouseEvent } from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

export type OnClick = {
    onClick?: (e: LeafletMouseEvent) => void
}

export type Props = OnClick & {
    setLL: Dispatch<LatLng>
    setZoom: Dispatch<number>
    children: ReactNode
}

export default function MapEvents({ setLL, setZoom, onClick, children }: Props) {
    const map = useMap()
    useMapEvents({
        click: e => {
            console.log("leaflet click:", e)
            if (onClick) {
                onClick(e)
            }
        },
        moveend: () => setLL(map.getCenter()),
        zoom: () => setZoom(map.getZoom()),
    })
    return <>{children}</>
}

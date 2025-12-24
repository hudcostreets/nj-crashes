import * as clusters from "@/src/map/clusters"
import { Clusters } from "@/src/map/clusters"
import React, { useEffect } from "react"
import { MapContainer, TileLayer, GeoJSON, useMap, useMapEvents } from "react-leaflet"
import type { MapContainerProps } from "react-leaflet"
import type { FeatureCollection } from "geojson"
import { LL } from "@/src/map/types"
import "leaflet/dist/leaflet.css"

export type Props = Omit<MapContainerProps, 'center'> & clusters.Props & {
    hudco: FeatureCollection
    center: LL
    setCenter?: (ll: LL) => void
    setZoom?: (z: number) => void
    onClick?: () => void
}

function MapEvents({ setCenter, setZoom, onClick }: {
    setCenter?: (ll: LL) => void
    setZoom?: (z: number) => void
    onClick?: () => void
}) {
    const map = useMap()

    useMapEvents({
        moveend: () => {
            if (setCenter) {
                const center = map.getCenter()
                setCenter({ lat: center.lat, lng: center.lng })
            }
            if (setZoom) {
                setZoom(map.getZoom())
            }
        },
        click: () => {
            if (onClick) onClick()
        },
    })

    return null
}

export default function Map({ crashes, hudco, center, setCenter, setZoom, onClick, ...mapProps }: Props) {
    return (
        <MapContainer
            center={[center.lat, center.lng]}
            {...mapProps}
        >
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <GeoJSON data={hudco} style={{
                fillColor: "yellow",
                color: "yellow",
                opacity: 0.5,
                fillOpacity: 0,
            }} />
            <Clusters crashes={crashes} />
            <MapEvents setCenter={setCenter} setZoom={setZoom} onClick={onClick} />
        </MapContainer>
    )
}

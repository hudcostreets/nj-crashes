import * as clusters from "@/src/map/clusters"
import { Clusters } from "@/src/map/clusters"
import React, { useEffect } from "react"
import { MapContainer, TileLayer, GeoJSON, useMap, useMapEvents } from "react-leaflet"
import type { MapContainerProps } from "react-leaflet"
import type { FeatureCollection } from "geojson"
import { LL } from "@/src/map/types"
import "leaflet/dist/leaflet.css"

// Tile styles for light/dark modes (using Stadia Maps)
const TILE_STYLES = {
    dark: {
        url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    light: {
        url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
}

export type Props = Omit<MapContainerProps, 'center'> & clusters.Props & {
    hudco: FeatureCollection
    center: LL
    setCenter?: (ll: LL) => void
    setZoom?: (z: number) => void
    onClick?: () => void
    theme?: 'light' | 'dark'
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

export default function Map({ crashes, hudco, center, setCenter, setZoom, onClick, theme = 'dark', ...mapProps }: Props) {
    const tileStyle = TILE_STYLES[theme]
    // Adjust county boundary color for visibility on different tile styles
    const boundaryColor = theme === 'dark' ? 'yellow' : '#cc8800'

    return (
        <MapContainer
            center={[center.lat, center.lng]}
            {...mapProps}
        >
            <TileLayer
                attribution={tileStyle.attribution}
                url={tileStyle.url}
            />
            <GeoJSON data={hudco} style={{
                fillColor: boundaryColor,
                color: boundaryColor,
                opacity: 0.5,
                fillOpacity: 0,
            }} />
            <Clusters crashes={crashes} />
            <MapEvents setCenter={setCenter} setZoom={setZoom} onClick={onClick} />
        </MapContainer>
    )
}

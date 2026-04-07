import { Circle, GeoJSON, Polyline, MapContainer, TileLayer, useMapEvents, useMap } from "react-leaflet"
import type { MapContainerProps } from "react-leaflet"
import { CrashDiff, LL } from "@/src/map/types";
import { Fragment } from "react";
import { FeatureCollection, MultiPolygon } from "geojson";
import "leaflet/dist/leaflet.css"

export type Props = Omit<MapContainerProps, 'center'> & {
    crashes: CrashDiff[]
    hudco: FeatureCollection<MultiPolygon>
    center: LL
    setCenter?: (ll: LL) => void
    setZoom?: (z: number) => void
}

function MapEvents({ setCenter, setZoom }: {
    setCenter?: (ll: LL) => void
    setZoom?: (z: number) => void
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
    })

    return null
}

export default function Map({ crashes, hudco, center, setCenter, setZoom, ...mapProps }: Props) {
    return (
        <MapContainer
            center={[center.lat, center.lng]}
            {...mapProps}
        >
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {
                crashes.map(({ lat, lon, oilat, oilon }, idx) => {
                    return <Fragment key={idx}>
                        <Polyline
                            positions={[[lat, lon], [oilat, oilon]]}
                            weight={1}
                            opacity={0.5}
                            color={"orange"}
                        />
                        <Circle color={"red"} fillColor={"red"} center={[lat, lon]} radius={5} />
                        <Circle color={"blue"} fillColor={"blue"} center={[oilat, oilon]} radius={5} />
                    </Fragment>
                })
            }
            <GeoJSON data={hudco} style={{
                fillColor: "yellow",
                color: "yellow",
                opacity: 0.5,
                fillOpacity: 0,
            }} />
            <MapEvents setCenter={setCenter} setZoom={setZoom} />
        </MapContainer>
    )
}

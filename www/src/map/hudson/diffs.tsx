import { Circle, GeoJSON, Polyline } from "react-leaflet"
import { MapContainerProps } from "react-leaflet/lib/MapContainer";
import MapContainer from "@/src/map/container";

import 'leaflet/dist/leaflet.css';
import { Crash } from "@/pages/map/hudson/diffs";
import { Fragment } from "react";
import { FeatureCollection, MultiPolygon } from "geojson";

export type Props = MapContainerProps & {
    crashes: Crash[]
    hudson: FeatureCollection<MultiPolygon>
}

export default function Map({ crashes, hudson, ...mapProps }: Props) {
    // const [ feature ] = hudco.features
    // const [ lineStrings ] = feature.geometry.coordinates
    // console.log(`${lineStrings.length} linestrings:`, lineStrings)
    return <MapContainer {...mapProps}>
        {
            crashes.map(({ oilat, oilon, ilat, ilon }, idx) => {
                return <Fragment key={idx}>
                    <Polyline
                        positions={[ [ oilat, oilon ], [ ilat, ilon ] ]}
                        weight={1}
                        opacity={0.5}
                        color={"orange"}
                        // fillColor={"red"}
                    />
                    <Circle color={"red"} fillColor={"red"} center={[ oilat, oilon ]} radius={5} />
                    <Circle color={"blue"} fillColor={"blue"} center={[ ilat, ilon ]} radius={5} />
                </Fragment>
            })
        }
        <GeoJSON data={hudson} style={{
            fillColor: "yellow",
            color: "yellow",
            opacity: 0.5,
            fillOpacity: 0,
        }} />
    </MapContainer>
}

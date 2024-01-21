import { MapContainerProps } from "react-leaflet/lib/MapContainer";

import * as clusters from "@/src/map/clusters";
import { Clusters } from "@/src/map/clusters";
import React from "react";
import MapContainer from "@/src/map/container";
import { GeoJSON } from "react-leaflet";
import { OnClick } from "@/src/map/events";

export type Props = MapContainerProps & clusters.Props & OnClick & {
    hudco: GeoJSON.FeatureCollection
}

export default function Map({ crashes, hudco, ...mapProps }: Props) {
    return <MapContainer {...mapProps}>
        <GeoJSON data={hudco} style={{
            fillColor: "yellow",
            color: "yellow",
            opacity: 0.5,
            fillOpacity: 0,
            // fill: false,  // I wanted this to make the GeoJSON interior not have `cursor: pointer`, but it doesn't
        }} />
        <Clusters crashes={crashes} />
    </MapContainer>
}

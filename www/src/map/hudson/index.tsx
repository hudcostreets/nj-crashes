import { MapContainerProps } from "react-leaflet/lib/MapContainer";

import * as clusters from "@/src/map/clusters";
import { Clusters } from "@/src/map/clusters";
import React from "react";
import 'leaflet/dist/leaflet.css';
import MapContainer from "@/src/map/container";

export type Props = MapContainerProps & clusters.Props

export default function Map({ crashes, ...mapProps }: Props) {
    return <MapContainer {...mapProps}>
        <Clusters crashes={crashes} />
    </MapContainer>
}

import MapContainer from "@rdub/next-leaflet/container"
import React from "react"
import { GeoJSON } from "react-leaflet"
import * as clusters from "@/client/map/clusters"
import { Clusters } from "@/client/map/clusters"
import type { MapContainerProps } from "@rdub/next-leaflet/container"

export type Props = MapContainerProps & clusters.Props & {
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

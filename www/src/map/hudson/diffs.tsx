import MapContainer from "@rdub/next-leaflet/container"
import { FeatureCollection, MultiPolygon } from "geojson"
import { Fragment } from "react"
import { Circle, GeoJSON, Polyline } from "react-leaflet"
import { Crash } from "@/pages/map/hudson/diffs"
import type { MapContainerProps } from "@rdub/next-leaflet/container"

export type Props = MapContainerProps & {
    crashes: Crash[]
    hudco: FeatureCollection<MultiPolygon>
}

export default function Map({ crashes, hudco, ...mapProps }: Props) {
  // const [ feature ] = hudco.features
  // const [ lineStrings ] = feature.geometry.coordinates
  // console.log(`${lineStrings.length} linestrings:`, lineStrings)
  return <MapContainer {...mapProps}>
    {
      crashes.map(({ lat, lon, oilat, oilon }, idx) => {
        return <Fragment key={idx}>
          <Polyline
            positions={[ [ lat, lon ], [ oilat, oilon ] ]}
            weight={1}
            opacity={0.5}
            color={"orange"}
            // fillColor={"red"}
          />
          <Circle color={"red"} fillColor={"red"} center={[ lat, lon ]} radius={5} />
          <Circle color={"blue"} fillColor={"blue"} center={[ oilat, oilon ]} radius={5} />
        </Fragment>
      })
    }
    {/*{*/}
    {/*    lineStrings.map((positions: Position[], idx: number) => {*/}
    {/*        return <Polyline*/}
    {/*            key={idx}*/}
    {/*            positions={positions.map(([ lat, lon ]) => [ lat, lon ])}*/}
    {/*            // weight={1}*/}
    {/*            // opacity={0.5}*/}
    {/*            color={"yellow"}*/}
    {/*            fillColor={"red"}*/}
    {/*        />*/}
    {/*    })*/}
    {/*}*/}
    <GeoJSON data={hudco} style={{
      fillColor: "yellow",
      color: "yellow",
      opacity: 0.5,
      fillOpacity: 0,
    }} />
    {/*<Clusters crashes={crashes} setLL={setLL} setZoom={setZoom} />*/}
  </MapContainer>
}

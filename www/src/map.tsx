import { MapContainer, TileLayer } from "react-leaflet"
import { MapContainerProps } from "react-leaflet/lib/MapContainer";

import 'leaflet/dist/leaflet.css';
import { Clusters } from "./clusters";
import * as clusters from "./clusters";

export const MAPS = {
    openstreetmap: {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "&copy; <a href=&quot;http://osm.org/copyright&quot;>OpenStreetMap</a> contributors",
    },
    alidade_smooth_dark: {
        url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors',
    },
}

export default function Map({ crashes, setLL, setZoom, ...mapProps }: clusters.Props & MapContainerProps) {
    const { url, attribution } = MAPS['alidade_smooth_dark']
    return <MapContainer {...mapProps}>
        <TileLayer url={url} attribution={attribution} />
        <Clusters crashes={crashes} setLL={setLL} setZoom={setZoom} />
    </MapContainer>
}

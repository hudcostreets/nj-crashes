import { TileLayer as LeafletTileLayer } from 'leaflet'
import { createElementObject, createTileLayerComponent, updateGridLayer, withPane } from "@react-leaflet/core";
import { TileLayer as RLTileLayer, TileLayerProps } from "react-leaflet";

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

export const BufferedTileLayer = createTileLayerComponent<
    LeafletTileLayer,
    TileLayerProps & { edgeBufferTiles?: number }
>(
    function createTileLayer({ url, ...options }, context) {
        const layer = new LeafletTileLayer(url, withPane(options, context))
        return createElementObject(layer, context)
    },
    function updateTileLayer(layer, props, prevProps) {
        updateGridLayer(layer, props, prevProps)

        const { url } = props
        if (url != null && url !== prevProps.url) {
            layer.setUrl(url)
        }
    },
)

export type Props = Omit<TileLayerProps, 'url' | 'attribution' | 'map'> & {
    map?: keyof typeof MAPS
    edgeBufferTiles?: number
}

export function TileLayer(
    {
        map = 'alidade_smooth_dark',
        edgeBufferTiles = 2,
        ...props
    }: Props
) {
    const { url, attribution } = MAPS[map]
    return <RLTileLayer url={url} attribution={attribution} />
    // Getting a "Error: No context provided: useLeafletContext() can only be used in a descendant of <MapContainer>" from this, it used to work, not sure why
    // return <BufferedTileLayer url={url} attribution={attribution} {...props} />
}

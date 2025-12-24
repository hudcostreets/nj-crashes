import { useState } from "react";
import { useUrlParam, floatParam } from "@rdub/use-url-params";
import css from "./map.module.scss";
import { LL } from "@/src/map/types";

export const defaults = {
    ll: { lat: 40.73, lng: -74.08 },
    zoom: 12,
}

export function useMapState() {
    const [lat, setLat] = useUrlParam('lat', floatParam(defaults.ll.lat))
    const [lng, setLng] = useUrlParam('lng', floatParam(defaults.ll.lng))
    const [zoom, setZoom] = useUrlParam('z', floatParam(defaults.zoom))

    const center: LL = { lat, lng }
    const setCenter = (ll: LL) => {
        setLat(ll.lat)
        setLng(ll.lng)
    }

    const [tolerance, setTolerance] = useState(12)

    return {
        center,
        setCenter,
        zoom,
        setZoom,
        tolerance,
        setTolerance,
        className: css.map,
        maxZoom: 18,
    }
}

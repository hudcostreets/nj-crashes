import { useState } from "react";
import { useUrlState, floatParam } from "use-prms";
import css from "./map.module.scss";
import { LL } from "@/src/map/types";

export const defaults = {
    ll: { lat: 40.73, lng: -74.08 },
    zoom: 12,
}

export function useMapState() {
    const [lat, setLat] = useUrlState('lat', floatParam(defaults.ll.lat))
    const [lng, setLng] = useUrlState('lng', floatParam(defaults.ll.lng))
    const [zoom, setZoom] = useUrlState('z', floatParam(defaults.zoom))

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

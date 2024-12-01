import { useEffect, useMemo, useState } from "react";
import { floatParam, llParam } from "@rdub/next-params/params";
import { parseHashParams, updateHashParams } from "@rdub/next-params/hash";
import { LL, Param } from "@rdub/next-params/params";
import css from "@/pages/map/map.module.scss";

export type Params = {
    ll: Param<LL>
    z: Param<number>
}

export const defaults = {
    ll: { lat: 40.73, lng: -74.08 },
    zoom: 12,
}

export function useMapState() {
    const params: Params = useMemo(() => ({
        ll: llParam({ init: defaults.ll, places: 4, }),
        z: floatParam(defaults.zoom, false),
    }), [])
    const {
        ll: [ center, setCenter ],
        z: [ zoom, setZoom, ],
    } = parseHashParams({ params })

    useEffect(
        () => {
            updateHashParams(
                params,
                { ll: center, z: zoom },
                { push: false, log: true },
            )
        },
        [ params, center, zoom ]
    )
    const [ tolerance, setTolerance ] = useState(12)
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

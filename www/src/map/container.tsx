import { MapContainerProps } from "react-leaflet/lib/MapContainer";
import React, { useEffect, useMemo, useState } from "react";
import * as ReactLeaflet from "react-leaflet";
import MapEvents, { OnClick } from "@/src/map/events";
import { floatParam, llParam, parseHashParams, updateHashParams } from "next-utils/params";
import { DEFAULT_CENTER, DEFAULT_ZOOM, Params, ParsedParams } from "@/src/map/params";
import { TileLayer } from "@/src/map/tiles";
import L from "leaflet";

export type Props = MapContainerProps & OnClick

export default function MapContainer({ children, onClick, ...mapProps }: Props) {
    const params: Params = useMemo(() => ({
        ll: llParam({ init: DEFAULT_CENTER, places: 4, }),
        z: floatParam(DEFAULT_ZOOM, false),
    }), [])
    const {
        ll: [ { lat, lng }, setLL ],
        z: [ zoom, setZoom, ],
    }: ParsedParams = parseHashParams({ params })

    useEffect(
        () => {
            updateHashParams(
                params,
                { ll: { lat, lng }, z: zoom },
                { push: false, log: true },
            )
        },
        [ params, lat, lng, zoom ]
    )
    const [ tolerance, setTolerance ] = useState(12)
    const canvas = useMemo(() => L.canvas({ tolerance, padding: 0.5, }), [ tolerance, ])
    return <ReactLeaflet.MapContainer {...mapProps} zoom={zoom} center={[ lat, lng ]} renderer={canvas}>
        <MapEvents setLL={setLL} setZoom={setZoom} onClick={onClick}>
            <TileLayer />
            {children}
        </MapEvents>
    </ReactLeaflet.MapContainer>
}

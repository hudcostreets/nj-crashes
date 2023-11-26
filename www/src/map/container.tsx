import { MapContainerProps } from "react-leaflet/lib/MapContainer";
import React, { useEffect } from "react";
import * as ReactLeaflet from "react-leaflet";
import MapEvents from "@/src/map/events";
import { floatParam, llParam, parseHashParams, updateHashParams } from "next-utils/params";
import { DEFAULT_CENTER, DEFAULT_ZOOM, Params, ParsedParams } from "@/src/map/params";
import { TileLayer } from "@/src/map/tiles";

export default function MapContainer({ children, ...mapProps }: MapContainerProps) {
    const params: Params = {
        ll: llParam({ init: DEFAULT_CENTER, places: 4, }),
        z: floatParam(DEFAULT_ZOOM, false),
    }
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
        [ lat, lng, zoom ]
    )
    return <ReactLeaflet.MapContainer {...mapProps} zoom={zoom} center={[ lat, lng ]}>
        <MapEvents setLL={setLL} setZoom={setZoom}>
            <TileLayer />
            {children}
        </MapEvents>
    </ReactLeaflet.MapContainer>
}

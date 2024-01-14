import {Map} from 'react-map-gl';
import maplibregl from 'maplibre-gl';
import DeckGL from '@deck.gl/react/typed';
import {ScatterplotLayer} from '@deck.gl/layers/typed';
import {Layer} from '@deck.gl/core/typed';
import { getDuckDb, runQuery } from "next-utils/parquet";
import { useEffect, useState } from "react";
import { getBasePath } from "next-utils/basePath";
import type { Map as MapboxMap } from "mapbox-gl";
import { MapLib } from "react-map-gl/dist/esm/types/lib";

const MALE_COLOR = [0, 128, 255];
const FEMALE_COLOR = [255, 0, 128];

// Source data CSV
const DATA_URL =
    'https://raw.githubusercontent.com/visgl/deck.gl-data/master/examples/scatterplot/manhattan.json'; // eslint-disable-line

const INITIAL_VIEW_STATE = {
    longitude: -74,
    latitude: 40.7,
    zoom: 11,
    maxZoom: 16,
    pitch: 0,
    bearing: 0
};

export type Crash<T = Date> = {
    id: number
    dt: T
    lat: number
    lon: number
    severity: 'p' | 'i' | 'f'
}

export default function App(
    {
        // data = DATA_URL,
        radius = 10,
        maleColor = MALE_COLOR,
        femaleColor = FEMALE_COLOR,
        // mapStyle = 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json'
        mapStyle = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json',
    }
) {
    const [ crashes, setCrashes ] = useState<Crash[]>([])
    const [ hoveredId, setHoveredId ] = useState<number | null>(null)
    useEffect(
        () => {
            const { protocol, host } = window.location
            const basePath = getBasePath()
            const url = `${protocol}//${host}${basePath}/njdot/hudson-2017:-pif.parquet`
            // console.log("host:", host, "url:", url, protocol)
            const fetchData = async () => {
                console.log("getting db")
                const db = await getDuckDb()
                console.log("got db")
                const crashes = (await runQuery<Crash<number>>(db, `
                    SELECT id, dt, ilat as lat, ilon as lon, severity
                    FROM '${url}'
                `)).map(
                    ({ dt, ...rest }) =>
                        ({ dt: new Date(dt), ...rest })
                )
                console.log("got crashes:", crashes)
                setCrashes(crashes)
            }
            fetchData()
        },
        []
    )

    const colors: { [k: string]: [ number, number, number ] } = {
        // yellow
        'p': [ 255, 255, 0 ],
        // orange
        'i': [ 255, 128, 0 ],
        // red
        'f': [ 255, 0, 0 ],
    }
    if (!crashes.length) return null
    const layers = [
        new ScatterplotLayer<Crash>({
            id: 'scatter-plot',
            data: crashes, //.slice(0, 100),
            pickable: true,
            radiusScale: 5,
            radiusMinPixels: 1,
            // onClick: (info, event) => {
            //     console.log("layer click info:", info, "event:", event)
            // },
            getPosition: ({ lat, lon }) => [ lon, lat, 0, ],
            getFillColor: ({ severity }) => {
                return colors[severity] ?? [ 255, 255, 255 ]
            },
            getRadius: 1,
            updateTriggers: {
                getFillColor: [maleColor, femaleColor]
            }
        })
    ];

    console.log("hovered id:", hoveredId)
    return (
        <DeckGL
            layers={layers}
            initialViewState={INITIAL_VIEW_STATE}
            controller={true}
            getTooltip={({ object }) => {
                if (!object) return null
                console.log("object:", object)
                setHoveredId(object.id)
                // const { id, dt, severity } = object as Crash
                return {
                    html: `
                        <div>yay</div>
                    `
                }
            }}
            pickingRadius={10}
            // onClick={(info, event) => {
            //     console.log("map click info:", info, "event:", event)
            // }}
            onDragEnd={(info, event) => {
                const { coordinate } = info
                if (!coordinate) return
                const [ lon, lat ] = coordinate
                console.log("dragEnd:", lon, lat)
            }}
        >
            <Map
                reuseMaps
                mapLib={maplibregl as any as MapLib<MapboxMap>}
                mapStyle={mapStyle}
                // preventStyleDiffing={true}
            />
        </DeckGL>
    );
}

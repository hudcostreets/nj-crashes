import dynamic from "next/dynamic";
const Map = dynamic(() => import("../../../../src/map/hudson/ddb/map"), { ssr: false })

export type Color = [ number, number, number ];
export const MALE_COLOR: Color = [0, 128, 255];
export const FEMALE_COLOR: Color = [255, 0, 128];

// Source data CSV
const DATA_URL =
    'https://raw.githubusercontent.com/visgl/deck.gl-data/master/examples/scatterplot/manhattan.json'; // eslint-disable-line

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
    return <Map
        radius={radius}
        maleColor={maleColor}
        femaleColor={femaleColor}
        mapStyle={mapStyle}
    />
}

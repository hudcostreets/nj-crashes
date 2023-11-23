import dynamic from "next/dynamic"
import css from "./map.module.scss"
import fs from "fs"
import * as ReactLeaflet from "react-leaflet";
import { join, resolve } from "path"
import { cwd } from "process"
import { decode, Encoded } from "../src/indexed-json";
import React, { useMemo } from "react";
import { floatParam, LL, llParam, Param, ParsedParam, parseQueryParams } from "next-utils/params";
import MapBody from '../src/map'

const Map = dynamic(() => import('next-utils/map'), { ssr: false });

const publicDir = resolve(cwd(), 'public');
const plotsDir = join(publicDir, 'plots')
const njdotDir = join(plotsDir, 'njdot')

export type Crash = {
    dt: Date
    sri: string
    mp: number
    lon: number
    lat: number
    city: string
    tk: number
    ti: number
    pk: number
    pi: number
    severity: 'p' | 'i' | 'f'
    tv: number
}

export type Props = {
    crashes: Crash[]
}
export function getStaticProps() {
    const path = join(njdotDir, 'hudson-5yr-lls-if.json')
    const encodedCrashes = JSON.parse(fs.readFileSync(path).toString()) as Encoded
    return { props: { encodedCrashes } }
}

type Params = {
    ll: Param<LL>
    z: Param<number>
    // ym: Param<string>
}

type ParsedParams = {
    ll: ParsedParam<LL>
    z: ParsedParam<number>
    // ym: ParsedParam<string>
}

const DEFAULT_CENTER = { lat: 40.725527, lng: -74.042037 }
const DEFAULT_ZOOM = 11

export default function Page({ encodedCrashes }: { encodedCrashes: Encoded }) {
    const crashes = useMemo(
        () => {
            const crashes = decode<Crash>(encodedCrashes)
            console.log(crashes.slice(0, 100))
            return crashes
        },
        [encodedCrashes]
    )

    const params: Params = {
        ll: llParam({ init: DEFAULT_CENTER, places: 3, }),
        z: floatParam(DEFAULT_ZOOM, false),
        // ym: ymParam(defaults.ym),
    }
    const {
        ll: [ { lat, lng }, setLL ],
        z: [ zoom, setZoom, ],
        // ym: [ ym, setYM ],
    }: ParsedParams = parseQueryParams({ params })

    return <div className={css.container}>
        <Map className={css.map} center={{ lat, lng }} maxZoom={18} zoom={zoom} >{
            (RL: typeof ReactLeaflet) => <div>{
                MapBody(RL, { crashes, setLL, setZoom })
            }</div>
        }</Map>
    </div>
}

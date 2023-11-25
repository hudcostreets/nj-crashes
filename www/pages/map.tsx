import dynamic from "next/dynamic"
import css from "./map.module.scss"
import fs from "fs"
import { join, resolve } from "path"
import { cwd } from "process"
import { decode, Encoded } from "../src/indexed-json";
import React, { useEffect, useMemo } from "react";
import { floatParam, LL, llParam, Param, ParsedParam, parseHashParams, parseQueryParams, updateHashParams } from "next-utils/params";

const Map = dynamic(() => import('../src/map'), { ssr: false });

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
            // console.log(crashes.slice(0, 100))
            return crashes
        },
        [encodedCrashes]
    )

    const params: Params = {
        ll: llParam({ init: DEFAULT_CENTER, places: 4, }),
        z: floatParam(DEFAULT_ZOOM, false),
        // ym: ymParam(defaults.ym),
    }
    const {
        ll: [ { lat, lng }, setLL ],
        z: [ zoom, setZoom, ],
        // ym: [ ym, setYM ],
    }: ParsedParams = parseHashParams({ params })

    const mapProps = useMemo(() => ({
        className: css.map,
        center: { lat, lng },
        zoom,
        maxZoom: 18,
    }), [ lat, lng, zoom ])
    const clustersProps = useMemo(() => ({
        crashes,
        setLL,
        setZoom,
    }), [ crashes, setLL, setZoom ])
    const map = useMemo(
        () => {
            console.log("page render map:", clustersProps, mapProps)
            return <Map
                {...clustersProps}
                {...mapProps}
            />
        },
        [ mapProps, clustersProps ]
    )
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
    return <div className={css.container}>{
        map
    }</div>
}

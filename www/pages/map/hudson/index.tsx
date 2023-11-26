import dynamic from "next/dynamic"
import css from "@/pages/map/map.module.scss"
import fs from "fs"
import { join } from "path"
import { decode, Encoded } from "@/src/indexed-json";
import React, { useMemo } from "react";
import { njdotDir } from "@/src/dirs";

export const Map = dynamic(() => import('@/src/map/hudson'), { ssr: false });

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

export default function Page({ encodedCrashes }: { encodedCrashes: Encoded }) {
    const crashes = useMemo(
        () => {
            const crashes = decode<Crash>(encodedCrashes) //.slice(0, 100)
            // console.log(crashes.slice(0, 100))
            return crashes
        },
        [encodedCrashes]
    )

    const map = useMemo(
        () => {
            console.log("page render map")
            return <Map
                className={css.map}
                maxZoom={18}
                crashes={crashes}
            />
        },
        [ crashes ]
    )

    return <div className={css.container}>{map}</div>
}

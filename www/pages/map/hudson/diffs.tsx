import dynamic from "next/dynamic"
import css from "../map.module.scss"
import fs from "fs"
import { join } from "path"
import { decode, Encoded } from "src/indexed-json";
import React, { useMemo } from "react";
import * as Hudson from "@/pages/map/hudson";
import { njdotDir, publicDir } from "@/src/dirs";
import { FeatureCollection, MultiPolygon } from "geojson";

export const Map = dynamic(() => import('@/src/map/hudson/diffs'), { ssr: false });

export type Crash = Hudson.Crash & {
    oilon: number
    oilat: number
}

export type Props = {
    encodedCrashes: Encoded
    hudco: FeatureCollection<MultiPolygon>
}

export function getStaticProps() {
    const path = join(njdotDir, 'hudson-5yr-lls-if-diffs.json')
    const encodedCrashes = JSON.parse(fs.readFileSync(path).toString()) as Encoded
    const hudcoPath = join(publicDir, 'hudson.geojson')
    const hudco = JSON.parse(fs.readFileSync(hudcoPath).toString())
    return { props: { encodedCrashes, hudco } }
}

export default function Page({ encodedCrashes, hudco }: Props) {
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
                hudco={hudco}
            />
        },
        [ crashes, hudco ]
    )

    return <div className={css.container}>{map}</div>
}

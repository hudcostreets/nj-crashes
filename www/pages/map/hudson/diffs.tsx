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

export type Crash = Omit<Hudson.Crash, 'lat' | 'lon'> & {
    oilon: number
    oilat: number
    ilon: number
    ilat: number
}

export type Props = {
    encodedCrashes: Encoded
    hudson: FeatureCollection<MultiPolygon>
}

export function getStaticProps() {
    const path = join(njdotDir, 'hudson-5yr-lls-if-diffs.json')
    const encodedCrashes = JSON.parse(fs.readFileSync(path).toString()) as Encoded
    const hudsonPath = join(publicDir, 'hudson.geojson')
    const hudson = JSON.parse(fs.readFileSync(hudsonPath).toString())
    return { props: { encodedCrashes, hudson } }
}

export default function Page({ encodedCrashes, hudson }: Props) {
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
                hudson={hudson}
            />
        },
        [ crashes, hudson ]
    )

    return <div className={css.container}>{map}</div>
}

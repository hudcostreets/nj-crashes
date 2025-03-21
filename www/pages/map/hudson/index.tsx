import fs from "fs"
import { join } from "path"
import { faInfo } from '@fortawesome/free-solid-svg-icons'
import { SettingsGear } from "@rdub/next-leaflet/map/settings"
import dynamic from "next/dynamic"
import React, { useMemo, useState } from "react"
import { Props } from "@/pages/map/hudson/diffs"
import css from "@/pages/map/map.module.scss"
import { njdotDir, publicDir } from "@/src/dirs"
import * as github from "@/src/github"
import { decode, Encoded } from "@/src/indexed-json"
import { useMapState } from "@/src/map/hudson/state"
import classes from "./index.module.scss"
import vcss from "./index.module.scss"

export const Map = dynamic(() => import('@/src/map/hudson'), { ssr: false })

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

export function getStaticProps() {
  const path = join(njdotDir, 'hudson-5yr-lls-if.json')
  const encodedCrashes = JSON.parse(fs.readFileSync(path).toString()) as Encoded
  const hudcoPath = join(publicDir, 'hudson.geojson')
  const hudco = JSON.parse(fs.readFileSync(hudcoPath).toString())
  return { props: { encodedCrashes, hudco, } }
}

export default function Page({ encodedCrashes, hudco, }: Props) {
  const mapState = useMapState()
  const crashes = useMemo(
    () => {
      const crashes = decode<Crash>(encodedCrashes) //.slice(0, 100)
      // console.log(crashes.slice(0, 100))
      return crashes
    },
    [encodedCrashes]
  )

  const [ initialSettingsShown, setInitialSettingsShown] = useState(true)
  const map = useMemo(
    () => {
      console.log("page render map")
      return <Map
        {...mapState}
        crashes={crashes}
        hudco={hudco}
        onClick={() => setInitialSettingsShown(false)}
      />
    },
    [ crashes, hudco ]
  )

  // `Hudson Crashes.ipynb`
  const numKsiCrashes = 15_983
  const numPropCrashes = 73_697
  const { tk, ti, tv } = {
    tk: 127,
    ti: 21_112,
    tv: 178_093,
  }

  return <div className={css.container}>
    {map}
    <SettingsGear
      icon={faInfo}
      show={
        // initialSettingsShown ?
        [ initialSettingsShown, setInitialSettingsShown ]
        // : undefined
      }
      className={vcss.settings}
      classes={classes}
      icons={[
        { href: github.url, alt: "View source code on GitHub", src: "logos/gh.png", },
        { href: "/", alt: "Graphs of NJ crash data", src: "plots/crash_homicide_cmp.png", },
        { href: "https://hudcostreets.org", alt: "Hudson County Complete Streets", src: "logos/hccs.png", },
      ]}
    >
      <div className={css.info}>
        <p className={css.heading}>Hudson County fatal / serious injury crashes, 2017-2021</p>
        <p>{numKsiCrashes.toLocaleString()} KSI crashes, {crashes.length.toLocaleString()} with approximate locations plotted above</p>
        <p>Not pictured: {numPropCrashes.toLocaleString()} property damage crashes.</p>
        <p>Total: {tk.toLocaleString()} killed, {ti.toLocaleString()} injured, {tv.toLocaleString()} vehicles</p>
        <p>1 death / 2 weeks</p>
        <p>11 injuries / day</p>
        <p>98 vehicles / day</p>
      </div>
    </SettingsGear>
  </div>
}

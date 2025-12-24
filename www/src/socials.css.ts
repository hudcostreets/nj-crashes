import { globalStyle } from '@vanilla-extract/css'
import * as css from "@/src/lib/socials.css"

export const svg = css.svg
export const socials = css.socials
export const logo = css.logo

globalStyle(`.${css.socials} path, .${css.socials} polygon`, {
    fill: "black",
    "@media": {
        "(prefers-color-scheme: dark)": {
            fill: "black",  // no dark mode implemented yet, need this to still be black since page background is white
        }
    }
})

globalStyle(socials, {
    marginTop: "0.3em",
})

globalStyle(`${socials} .${logo}`, {
    width: "4em",
})

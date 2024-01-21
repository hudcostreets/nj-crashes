import {globalStyle} from '@vanilla-extract/css'
import * as css from "@rdub/next-base/socials.css";

export const svg = css.svg
globalStyle(`.${css.socials} path, .${css.socials} polygon`, {
    fill: "black",
    "@media": {
        "(prefers-color-scheme: dark)": {
            fill: "black",  // no dark mode implemented yet, need this to still be black since page background is white
        }
    }
})

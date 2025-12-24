import { globalStyle, style } from '@vanilla-extract/css'

export const socials = style({
    listStyle: "none",
    display: "inline-block",
    padding: 0,
})

export const social = "social"

globalStyle(`${socials} .${social}`, {
    display: "inline-block",
    margin: "0 0.3em",
})

export const logo = "logo"

globalStyle(`${socials} .${logo}`, {
    width: "3em",
})

export const svg = "svg"

globalStyle(`${socials} .${svg}`, {
    width: "3em",
})

globalStyle(`.${socials} path, .${socials} polygon`, {
    fill: "black",
    "@media": {
        "(prefers-color-scheme: dark)": {
            fill: "white",
        }
    }
})

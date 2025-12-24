import { style, globalStyle } from "@vanilla-extract/css";

export const settings = style({
    fontSize: "0.8em",
    bottom: "1.5em",
})

export const icon = style({
    marginLeft: "0.3em",
    marginRight: "0.3em",
    maxHeight: "2em",
})

export const menu = style({
    minWidth: "14em",
    padding: "0.3em 0.4em 0.2em",
})

const exports = { settings, icon, menu }
export default exports

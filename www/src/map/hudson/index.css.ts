import { style, globalStyle } from "@vanilla-extract/css";
import { icon, menu } from "@rdub/next-leaflet/map/settings.css";

export const settings = style({
    fontSize: "0.8em",
    bottom: "1.5em",
})

globalStyle(`${settings} .${icon}`, {
    marginLeft: "0.3em",
    marginRight: "0.3em",
    maxHeight: "2em",
})

globalStyle(`${settings} .${menu}`, {
    minWidth: "14em",
    padding: "0.3em 0.4em 0.2em",
})

const exports = { settings, }
export default exports

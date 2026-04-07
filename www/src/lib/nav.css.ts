import { globalStyle, style } from '@vanilla-extract/css'
import { vars } from "./contract.css"

export const absolute = "absolute"
export const active = "active"
export const dropbtn = "dropbtn"
export const dropdown = "dropdown"
export const dropdownContent = "dropdown-content"
export const hamburger = "hamburger"
export const menu = "menu"
export const open = "open"
export const hover = "hover"
export const logo = "logo"

export const topnav = style({
    backgroundColor: vars.backgroundColor,
    color: vars.color,
    position: "fixed",
    top: 0,
    width: "100%",
    transition: "top 0.3s",
    zIndex: 10,
})

function media(selector: string, rule: Record<string, string | number>) {
    globalStyle(`${topnav}${selector}`, {
        '@media': {
            "screen and (max-width: 800px)": rule
        }
    })
    globalStyle(`${topnav}.collapsed${selector}`, rule)
}

media(``, {
    width: "auto",
    maxHeight: "100vh",
    overflowY: "auto",
})

globalStyle(`${topnav} .${logo}`, {
    maxWidth: "2em",
    padding: "0.2em 0",
})

media(` .${logo}`, {
    maxWidth: "3em",
    paddingTop: "0",
    paddingLeft: "0.5em",
    paddingBottom: "0.5em",
})

media(` .${hamburger}`, {
    fontSize: "2.2em",
    padding: "0.2em 0.3em",
    display: "block",
})

media(` > .${menu}`, {
    display: "none",
})

media(`.${open} > .${menu}`, {
    textAlign: "left",
    display: "block",
    float: "none",
})

globalStyle(`${topnav}.${absolute}`, {
    position: "absolute"
})

globalStyle(`${topnav} a, ${topnav} button`, {
    float: "left",
    display: "block",
    color: vars.linkColor,
    backgroundColor: "transparent",
    border: 0,
    textAlign: "center",
    padding: "14px 16px",
    textDecoration: "none",
    fontSize: "1.3em",
})

media(`${topnav} a, ${topnav} button`, {
    float: "none",
})

globalStyle(`${topnav} .${active}`, {
    backgroundColor: "#04AA6D",
    color: "white",
})

globalStyle(`${topnav} .${hamburger}`, {
    display: "none",
})

globalStyle(`${topnav} .${dropdown}`, {
    float: "left",
})

globalStyle(`${topnav} .${dropdown} .${dropbtn}`, {
    border: "none",
    outline: "none",
    backgroundColor: "inherit",
    fontFamily: "inherit",
    margin: "0",
})

globalStyle(`${topnav} .${dropdownContent}`, {
    display: "none",
    position: "absolute",
    backgroundColor: "#f9f9f9",
    minWidth: "160px",
    boxShadow: "0px 8px 16px 0px rgba(0,0,0,0.2)",
    zIndex: "1",
})

globalStyle(`${topnav} .${dropdownContent} a`, {
    float: "none",
    color: "black",
    padding: "12px 16px",
    textDecoration: "none",
    display: "block",
    textAlign: "left",
})

globalStyle(`${topnav} a:hover, .${dropdown}.${open} .${dropbtn}, .${dropdown}.${hover} .${dropbtn}`, {
    backgroundColor: "#555",
    color: "white",
})

globalStyle(`${topnav} .${dropdownContent} a:hover`, {
    backgroundColor: "#ddd",
    color: "black",
})

globalStyle(`${topnav} .${dropdown}.${open} .${dropdownContent}`, {
    display: "block",
})

const module = { absolute, active, dropbtn, dropdown, dropdownContent, hamburger, hover, logo, menu, open, topnav }
export default module

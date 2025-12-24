import { createTheme, createThemeContract } from '@vanilla-extract/css'

export const vars = createThemeContract({
    color: null,
    linkColor: null,
    backgroundColor: null
})

export const dark = createTheme(vars, {
    color: "white",
    linkColor: "#f2f2f2",
    backgroundColor: "black",
})

export const light = createTheme(vars, {
    color: "black",
    linkColor: "#222",
    backgroundColor: "white",
})

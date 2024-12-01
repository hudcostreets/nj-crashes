import { createContext } from "react"

export type Cookies = Record<string, string | undefined>

export const CookiesContext = createContext({} as Cookies)

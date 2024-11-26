import { useCallback } from "react"
import { useCookies } from "react-cookie"

export function useCookie(key: string): [ string | undefined, (v: string | undefined) => void ] {
  const [ cookies, _setCookie, _removeCookie, ] = useCookies([ key ])
  const cookie = cookies[key]
  const setCookie = useCallback(
    (value: string | undefined) => {
      // console.log(`setcookie ${key}:`, value)
      if (value === undefined) {
        _removeCookie(key, { path: "/" })
      } else {
        _setCookie(key, value, { path: "/" })
      }
    },
    [ _setCookie, _removeCookie, key ]
  )
  // console.log("useCookie got:", cookie)
  return [ cookie, setCookie, ]
}

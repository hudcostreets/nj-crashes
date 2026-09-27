/** Feeds the feedback action log (`actionLog.ts`) from app-wide events:
 *  route changes, query-param changes (map selections like `?road=`,
 *  filters, …), clicks on controls, and `<select>` changes. Renders nothing. */
import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"
import { describeControl, describeSelectChange, logAction, paramDiff } from "./actionLog"

/** Dispatched by `use-prms` after every `history.pushState`/`replaceState`
 *  (it patches both), so param writes that bypass react-router land here too. */
const USE_PRMS_LOCATION_CHANGE = "use-prms:locationchange"

export function ActionLogRecorder() {
    const location = useLocation()
    const prev = useRef<{ pathname: string; search: string } | null>(null)

    const check = useRef(() => {
        const { pathname, search } = window.location
        const p = prev.current
        if (p && p.pathname === pathname && p.search === search) return
        if (!p || p.pathname !== pathname) {
            logAction("nav", `${pathname}${search}`)
        } else {
            for (const [key, label] of paramDiff(p.search, search)) {
                logAction("param", label, `param:${key}`)
            }
        }
        prev.current = { pathname, search }
    }).current

    useEffect(check, [location.pathname, location.search, check])

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (!(e.target instanceof Element)) return
            const desc = describeControl(e.target)
            if (desc) logAction("click", desc)
        }
        const onChange = (e: Event) => {
            if (!(e.target instanceof Element)) return
            const desc = describeSelectChange(e.target)
            if (desc) logAction("change", desc)
        }
        document.addEventListener("click", onClick, true)
        document.addEventListener("change", onChange, true)
        window.addEventListener(USE_PRMS_LOCATION_CHANGE, check)
        window.addEventListener("popstate", check)
        return () => {
            document.removeEventListener("click", onClick, true)
            document.removeEventListener("change", onChange, true)
            window.removeEventListener(USE_PRMS_LOCATION_CHANGE, check)
            window.removeEventListener("popstate", check)
        }
    }, [check])

    return null
}

import { useEffect, useState } from "react"

/** Shared persisted "toolbox open" state for the map embed and the
 *  full-screen `/map` page. Uses `sessionStorage` so the state follows the
 *  user across navigations within the tab but doesn't leak between sessions. */
const KEY = "hccs.crashmap.toolboxOpen"

export function useToolboxOpen(defaultOpen: boolean) {
    const [open, setOpen] = useState<boolean>(() => {
        try {
            const v = sessionStorage.getItem(KEY)
            return v === null ? defaultOpen : v === "1"
        } catch { return defaultOpen }
    })
    useEffect(() => {
        try { sessionStorage.setItem(KEY, open ? "1" : "0") } catch {}
    }, [open])
    return [open, setOpen] as const
}

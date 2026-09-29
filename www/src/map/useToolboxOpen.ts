import { useEffect } from "react"
import useSessionStorageState from "use-session-storage-state"

/** `?st=1` / `?st=0` in the page URL at load: open / close the settings drawer, overriding the
 *  session's last state and the width-based default. */
export function toolboxOpenFromUrl(search: string): boolean | null {
    const st = new URLSearchParams(search).get("st")
    return st === "1" ? true : st === "0" ? false : null
}

/** Shared persisted "toolbox open" state for the map embed and the
 *  full-screen `/map` page. */
export function useToolboxOpen(defaultOpen: boolean) {
    const fromUrl = typeof window === "undefined" ? null : toolboxOpenFromUrl(window.location.search)
    const [open, setOpen] = useSessionStorageState<boolean>("hccs.crashmap.toolboxOpen", { defaultValue: fromUrl ?? defaultOpen })
    useEffect(() => {
        if (fromUrl !== null) setOpen(fromUrl)
    }, [])  // eslint-disable-line react-hooks/exhaustive-deps
    return [open, setOpen] as const
}

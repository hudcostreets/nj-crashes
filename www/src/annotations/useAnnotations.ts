import { useEffect, useMemo, useState } from "react"
import { getBasePath } from "@/src/lib/basePath"
import type { Annotation } from "./types"
import { matchesGeo, matchesPage } from "./types"

let cachePromise: Promise<Annotation[]> | null = null

function loadAll(): Promise<Annotation[]> {
    if (!cachePromise) {
        const basePath = getBasePath()
        cachePromise = fetch(`${basePath}/annotations.json`)
            .then(r => r.ok ? r.json() as Promise<Annotation[]> : [])
            .catch(() => [] as Annotation[])
    }
    return cachePromise
}

export function useAnnotations({
    page,
    cc,
    mc,
}: {
    page: string
    cc: number | null
    mc: number | null
}): Annotation[] {
    const [all, setAll] = useState<Annotation[]>([])
    useEffect(() => {
        let cancelled = false
        loadAll().then(rows => {
            if (!cancelled) setAll(rows)
        })
        return () => { cancelled = true }
    }, [])
    return useMemo(
        () => all.filter(a => matchesGeo(a, cc, mc) && matchesPage(a, page)),
        [all, page, cc, mc],
    )
}

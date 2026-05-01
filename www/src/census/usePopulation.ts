import { useMemo } from "react"
import { getBasePath } from "@/src/lib/basePath"
import { useParquet } from "@/src/lib/useParquet"

export type PopulationLevel = 'state' | 'county' | 'muni'

export type PopulationRow = {
    year: number
    level: PopulationLevel
    cc: number | null
    mc: number | null
    population: number
    source: 'acs5' | 'dec2000' | 'interp'
}

const POPULATION_URL = `${getBasePath()}/census/population.parquet`

export function usePopulation() {
    const result = useParquet<PopulationRow>(POPULATION_URL)

    const lookup = useMemo(() => {
        if (!result.data) return null
        const map = new Map<string, number>()
        for (const r of result.data) {
            const key = `${r.level}|${r.cc ?? ''}|${r.mc ?? ''}|${r.year}`
            map.set(key, r.population)
        }
        return map
    }, [result.data])

    return { ...result, lookup }
}

/** Look up population at a specific (geo, year). Returns null if missing. */
export function getPopulation(
    lookup: Map<string, number>,
    geo: { cc: number | null; mc: number | null },
    year: number,
): number | null {
    const level: PopulationLevel = geo.mc !== null ? 'muni' : geo.cc !== null ? 'county' : 'state'
    const cc = geo.cc ?? ''
    const mc = geo.mc ?? ''
    return lookup.get(`${level}|${cc}|${mc}|${year}`) ?? null
}

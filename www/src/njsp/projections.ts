import { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import { ProjectedCsv } from "@/src/paths"
import { basename } from "path"

export type HasDb = {
    db: AsyncDuckDB
}
export type HasCounty = {
    county: string | null
}
export type Base = HasDb & HasCounty
export type HasCsvText = {
    csvText: string
}
export type Props = Base & HasCsvText

export const typeCountsQuery = (county: string | null) => `
    SELECT
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger
    FROM read_csv('${basename(ProjectedCsv)}')
    ${county ? `WHERE county = '${county}'` : ``}
`

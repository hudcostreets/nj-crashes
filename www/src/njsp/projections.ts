import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { TypeCounts } from "@/src/njsp/plot";
import { ProjectedCsv } from "@/src/paths";
import { basename } from "path";
import { runQuery } from "@rdub/duckdb/duckdb";

export type Props = {
    db: AsyncDuckDB
    county: string | null
    csvText?: string
}

export async function getTypeProjections({ db, county, csvText, }: Props): Promise<TypeCounts> {
    let projectedCsvText: string
    if (csvText) {
        projectedCsvText = csvText
    } else {
        if (typeof window !== "undefined") {
            projectedCsvText = await fetch(window.location.host + ProjectedCsv).then(r => r.text())
        } else {
            throw Error(`csvText required when calling getTypeProjections on server`)
        }
    }
    const name = basename(ProjectedCsv)
    await db.registerFileText(name, projectedCsvText)
    const [ typeProjections ] = await runQuery<TypeCounts>(
        db,
        `
        SELECT
            CAST(sum(driver) as INT) as driver,
            CAST(sum(pedestrian) as INT) as pedestrian,
            CAST(sum(cyclist) as INT) as cyclist,
            CAST(sum(passenger) as INT) as passenger
        FROM ${name}
        ${county ? `WHERE county = '${county}'` : ``}
        `,
    )
    console.log("typeProjections:", typeProjections)
    return typeProjections
}

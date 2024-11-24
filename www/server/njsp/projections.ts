import { TypeCounts } from "@/src/njsp/plot"
import { typeCountsQuery } from "@/src/njsp/projections"
import { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm"

export async function getTypeProjections({ conn, county, }: { conn: AsyncDuckDBConnection, county: string | null, }): Promise<TypeCounts> {
    const query = typeCountsQuery(county)
    console.log("getTypeProjections query:", query)
    // await db.registerFileURL('projected.csv', '/njsp/projected.csv', false)
    const [ typeCounts ] = JSON.parse(JSON.stringify((await (conn.query(query))).toArray()))
    // const [ typeCounts ] = await getCsvTable<TypeCounts>({ db, query, })
    return typeCounts
}

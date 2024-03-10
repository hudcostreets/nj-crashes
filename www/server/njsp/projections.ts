import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { TypeCounts } from "@/src/njsp/plot";
import { ProjectedCsv } from "@/server/paths";
import { table, typeCountsQuery } from "@/src/njsp/projections";
import { getCsvTable } from "@/server/tableData";

export async function getTypeProjections({ db, county, }: { db: AsyncDuckDB, county: string | null, }): Promise<TypeCounts> {
    const [ typeCounts ] = await getCsvTable<TypeCounts>({
        db,
        path: ProjectedCsv,
        table,
        query: typeCountsQuery(county),
    })
    return typeCounts
}

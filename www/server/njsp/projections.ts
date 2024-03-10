import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { TypeCounts } from "@/src/njsp/plot";
import fs from "fs";
import { ProjectedCsv } from "@/server/paths";
import * as projections from "@/src/njsp/projections";

export async function getTypeProjections({ db, county, }: { db: AsyncDuckDB, county: string | null, }): Promise<TypeCounts> {
    const csvText = fs.readFileSync(ProjectedCsv).toString()
    return projections.getTypeProjections({ db, county, csvText, })
}

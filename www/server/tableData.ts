import fs from "fs";
import { getRegisteredDb, HasDb, HasQuery, MaybeTable, TableData } from "@/src/tableData";
import { runQuery } from "@rdub/duckdb/duckdb";
import { basename } from "path";

export function loadTableData(path: string): TableData {
    if (path.endsWith('.csv')) {
        const data = fs.readFileSync(path).toString()
        return { kind: 'csv', data, }
    } else if (path.endsWith('.pqt') || path.endsWith('.parquet')) {
        const pqtBuf = fs.readFileSync(path)
        const base64 = pqtBuf.toString('base64')
        return { kind: 'pqt',  base64, }
    } else {
        throw new Error(`unknown file type: ${path}`)
    }
}

export async function getCsvTable<T>({ path, db, table, query, }: { path: string } & HasDb & MaybeTable & HasQuery): Promise<T[]> {
    const csvText = fs.readFileSync(path).toString()
    const registeredDb = await getRegisteredDb({ db, table: table ?? basename(path), csvText, })
    return await runQuery<T>(registeredDb, query,)
}

import { AsyncDuckDB } from "@duckdb/duckdb-wasm";

export type CsvData = {
    kind: 'csv'
    data: string
}
export type PqtData = {
    kind: 'pqt'
    base64: string
}
export type TableData = CsvData | PqtData

export async function registerTableData({ db, tableData, stem }: {
    db: AsyncDuckDB
    tableData: TableData
    stem: string
}) {
    let target: string
    if (tableData.kind === 'csv') {
        const path = `${stem}.csv`
        target = `'${path}'`
        await db.registerFileText(path, tableData.data)
    } else {
        const path = `${stem}.parquet`
        target = `parquet_scan('${path}')`
        let ytcPqtArr = new Uint8Array(Buffer.from(tableData.base64, 'base64'))
        await db.registerFileBuffer(path, ytcPqtArr)
    }
    return target
}

import fs from "fs";
import { TableData } from "@/src/tableData";

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

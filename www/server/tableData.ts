import path, { dirname } from "path";
import fs from "fs";
import { TableData } from "@/src/tableData";

export function loadTableData({ fmt, stem }: { fmt: 'csv' | 'pqt', stem: string }): TableData {
    const parent = dirname(process.cwd())
    if (fmt === 'csv') {
        const csvPath = path.join(parent, `${stem}.csv`)
        const data = fs.readFileSync(csvPath).toString()
        return { kind: 'csv', data, }
    } else {
        const pqtPath = path.join(parent, `${stem}.pqt`)
        const pqtBuf = fs.readFileSync(pqtPath)
        const base64 = pqtBuf.toString('base64')
        return { kind: 'pqt',  base64, }
    }
}

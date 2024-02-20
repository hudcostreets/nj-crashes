import path, { dirname } from "path";
import fs from "fs";
import { TableData } from "@/src/tableData";

export function loadTableData({ fmt, dir, stem }: { fmt: 'csv' | 'pqt', dir: string, stem: string }): TableData {
    if (fmt === 'csv') {
        const csvPath = path.join(dir, `${stem}.csv`)
        const data = fs.readFileSync(csvPath).toString()
        return { kind: 'csv', data, }
    } else {
        const pqtPath = path.join(dir, `${stem}.pqt`)
        const pqtBuf = fs.readFileSync(pqtPath)
        const base64 = pqtBuf.toString('base64')
        return { kind: 'pqt',  base64, }
    }
}

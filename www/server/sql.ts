import { promisify } from "util"
import { exec } from "child_process";
const execP = promisify(exec)

export async function sh(command: string) {
    const { stdout, stderr } = await execP(command);
    if(stderr) {
        console.error('Error:', stderr);
    }
    return stdout
}

export async function sqlQuery<T>({ url, query }: { url: string, query: string }): Promise<T[]> {
    const stdout = await sh(`sql-query ${url} '${query}'`)
    const rows = JSON.parse(stdout) as T[]
    // console.log("sqlQuery", { url, query, rows, })
    return rows
}


import { asyncQuery, Params } from "../sql";
import { Crash, Total } from "@/src/njsp/crash";
import Database, { Database as Db } from "better-sqlite3";

export class Crashes {
    private db: Db

    constructor(path: string) {
        this.db = new Database(path, { verbose: console.log })  // Remove in production
    }

    where({ cc, mc, }: { cc: number | null, mc: number | null }): { where: string, params: Params } {
        const conditions: string[] = []
        const params: Params = {}
        if (cc) {
            conditions.push('cc = @cc')
            params.cc = cc
        }
        if (mc) {
            conditions.push('mc = @mc')
            params.mc = mc
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        return { where, params }
    }

    async total({ cc, mc, }: { cc: number | null, mc: number | null }): Promise<number> {
        const { where, params } = this.where({ cc, mc })
        const query = `select count(*) as total from crashes ${where}`
        const [{ total }] = await asyncQuery<Total>(this.db, query, params)
        return total
    }

    crashes({ cc, mc, page, perPage, }: {
        cc: number | null
        mc: number | null
        page: number
        perPage: number
    }): Promise<Crash[]> {
        const { where, params } = this.where({ cc, mc })
        params.limit = perPage
        params.offset = page * perPage
        const query = `
            SELECT *
            FROM crashes ${where}
            ORDER BY dt DESC
            LIMIT @limit OFFSET @offset
        `;
        return asyncQuery(this.db, query, params)
    }
}

import Database, { Database as Db } from 'better-sqlite3'
import { CCMC } from "@/src/njsp/region";
import { PageOpts } from "@/src/pagination";
import { CrashPage, Total } from "@/src/crash";


export type Params = Record<string, any>

export function asyncQuery<T>(db: Db, query: string, params: Params): Promise<T[]> {
    return new Promise((resolve, reject) => {
        try {
            const result = db.prepare(query).all(params) as T[]
            resolve(result);
        } catch (err) {
            console.error(`asyncQuery error: ${query}`, err)
            reject(err);
        }
    });
}

export abstract class HasCrashPage<Crash> {
    abstract total({ cc, mc, }: CCMC): Promise<number>
    abstract crashes({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<Crash[]>

    async crashPage({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<CrashPage<Crash>> {
        const [ crashes, total, ] = await Promise.all([
            this.crashes({ cc, mc, page, perPage, }),
            this.total({ cc, mc, }),
        ])
        return { crashes, total }
    }
}

export class CrashDB<Crash> extends HasCrashPage<Crash> {
    private readonly db: Db

    constructor(path: string) {
        super()
        this.db = new Database(path, { verbose: console.log })  // Remove in production
    }

    where({ cc, mc, }: CCMC): { where: string, params: Params } {
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

    async total({ cc, mc, }: CCMC): Promise<number> {
        const { where, params } = this.where({ cc, mc })
        const query = `select count(*) as total from crashes ${where}`
        const [{ total }] = await asyncQuery<Total>(this.db, query, params)
        return total
    }

    crashes({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<Crash[]> {
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

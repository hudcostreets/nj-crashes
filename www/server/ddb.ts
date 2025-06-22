import { OPEN_READWRITE } from "duckdb"
import { Database } from "duckdb-async"
import { HasCrashPage } from "@/server/crash-page"
import { CCMC } from "@/src/njsp/region"
import { PageOpts } from "@/src/pagination"

export class DDB {
  readonly db: Promise<Database>
  readonly url: string

  constructor(url: string) {
    this.url = url
    this.db = Database.create(':memory:', OPEN_READWRITE)
  }

  async query<T = any>(sql: string): Promise<T[]> {
    const msg = `DDB: ${sql.replace("\n", " ").replace(/\s+/g, " ")}`
    console.time(msg)
    const db = await this.db
    const res = (await db.all(sql)) as T[]
    console.timeEnd(msg)
    return res
  }
}

export class CrashDDB<Crash> extends DDB implements HasCrashPage<Crash> {
  where({ cc, mc, }: CCMC): string {
    const conditions: string[] = []
    if (cc) {
      conditions.push(`cc = ${cc}`)
    }
    if (mc) {
      conditions.push(`mc = ${mc}`)
    }
    return conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  }

  async total({ cc, mc, }: CCMC): Promise<number> {
    const where = this.where({ cc, mc })
    const [{ total }] = await this.query(`select cast(count(*) as int) as total from '${this.url}' ${where}`)
    return total
  }

  async crashes({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<Crash[]> {
    const where = this.where({ cc, mc })
    const limit = perPage
    const offset = page * perPage
    return this.query<Crash>(`
        SELECT
            strftime(dt, '%Y-%m-%dT%H:%M:%S') as dt,
            * EXCLUDE (dt)
        FROM '${this.url}' ${where}
        ORDER BY dt DESC
        LIMIT ${limit} OFFSET ${offset}
    `)
  }
}

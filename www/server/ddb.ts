import { OPEN_READWRITE } from "duckdb"
import { Database } from "duckdb-async"
import { HasCrashPage } from "@/server/crash-page"
import { CCMC } from "@/src/njsp/region"
import { PageOpts } from "@/src/pagination"

export class CrashDDB<Crash> extends HasCrashPage<Crash> {
  readonly db: Promise<Database>
  readonly url: string

  constructor(url: string) {
    super()
    this.url = url
    this.db = Database.create(':memory:', OPEN_READWRITE)
  }

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
    const query = `select cast(count(*) as int) as total from '${this.url}' ${where}`
    const db = await this.db
    const [{ total }] = await db.all(query)
    return total
  }

  async crashes({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<Crash[]> {
    const where = this.where({ cc, mc })
    const limit = perPage
    const offset = page * perPage
    const query = `
            SELECT
                strftime(dt, '%Y-%m-%dT%H:%M:%S') as dt,
                * EXCLUDE (dt)
            FROM '${this.url}' ${where}
            ORDER BY dt DESC
            LIMIT ${limit} OFFSET ${offset}
        `
    const db = await this.db
    return (await db.all(query)) as Crash[]
  }
}

import { Crash, Crash0, Occupant, Pedestrian, Vehicle } from "@/src/njdot/crash"
import { CrashDDB as CrashDDB0 } from "../ddb"
import { toYearStatsDicts, YearStats, YearStatsDicts } from "@/src/use-year-stats"
import { DotPqtUrls } from "@/src/urls";
import { CCMC } from "@/src/njsp/region";
import { HasCrashPage } from "@/server/crash-page";
import { IdMap, idMap, Ids, Props } from "@/server/njdot/crash-page";
import { Database } from "duckdb-async";

export class CrashDDB extends CrashDDB0<Crash0> {
  where({ cc, mc, }: CCMC): string {
    const severities = [ 'i', 'f' ]
    const severitiesFilter = severities.map(s => `severity='${s}'`).join(' or ')
    const severitiesClause = severitiesFilter ? `(${severitiesFilter})` : ""
    let where = super.where({ cc, mc, });
    if (severitiesClause) {
      if (where) {
        where += ` AND ${severitiesClause}`
      } else {
        where = `WHERE ${severitiesClause}`
      }
    }
    return where
  }
}

export class DotDdb extends HasCrashPage<Crash> {
  private crashDdb: CrashDDB
  urls: DotPqtUrls

  constructor(urls: DotPqtUrls) {
    super()
    console.log("dot dbs:", urls)
    const { crashes, occupants, pedestrians, vehicles, drivers } = urls
    this.urls = {
      ...urls,
      crashes: crashes.replace(/\.db$/, ".parquet"),
      occupants: occupants.replace(/\.db$/, ".parquet"),
      pedestrians: pedestrians.replace(/\.db$/, ".parquet"),
      vehicles: vehicles.replace(/\.db$/, ".parquet"),
      drivers: drivers.replace(/\.db$/, ".parquet"),
    }
    this.crashDdb = new CrashDDB(this.urls.crashes)
  }

  get db(): Promise<Database> {
    return this.crashDdb.db
  }

  async crashes({ cc, mc, page, perPage, }: Props): Promise<Crash[]> {
    const crashes = await this._crashes({ cc, mc, page, perPage, })
    const ids = crashes.map(({ id }) => id)
    console.log("crashes:", crashes, "ids:", ids)
    const [ occMap, pedMap, vehMap ] = await Promise.all([
      this.occupants(ids),
      this.pedestrians(ids),
      this.vehicles(ids),
    ])
    return crashes.map(crash => {
      const occs = occMap[crash.id]
      const peds = pedMap[crash.id]
      const vehs = vehMap[crash.id]
      return { crash, occs, peds, vehs, }
    })
  }

  total({ cc, mc }: CCMC): Promise<number> {
    return this.crashDdb.total({ cc, mc, })
  }

  _crashes({ cc, mc, page, perPage }: Props): Promise<Crash0[]> {
    return this.crashDdb.crashes({ cc, mc, page, perPage, })
  }

  async occupants(ids: Ids): Promise<IdMap<Occupant>> {
    if (!ids.length) return {}
    const query = `
        select crash_id, pos, condition, eject, age, sex, inj_loc, inj_type
        from '${this.urls.occupants}'
        where crash_id in (${ids.join(', ')}) and condition >= 1 and condition < 5
        order by crash_id, condition, pos
    `
    const db = await this.db
    console.log("occupants query:", query)
    return idMap(ids, await db.all(query) as Occupant[])
  }

  async pedestrians(ids: Ids): Promise<IdMap<Pedestrian>> {
    if (!ids.length) return {}
    const query = `
        select crash_id, condition, age, sex, inj_loc, inj_type, cyclist
        from '${this.urls.pedestrians}'
        where crash_id in (${ids.join(', ')}) and condition >= 1 and condition < 5
        order by crash_id, condition, cyclist
    `
    const db = await this.db
    console.log("pedestrians query:", query)
    return idMap(ids, await db.all(query) as Pedestrian[])
  }

  async vehicles(ids: Ids): Promise<IdMap<Vehicle>> {
    if (!ids.length) return {}
    const query = `
        select
            crash_id,
            damage,
            damage_loc,
            impact_loc,
            departure,
            type
        from '${this.urls.vehicles}'
        where crash_id in (${ids.join(', ')})
    `
    const db = await this.db
    console.log("vehicles query:", query)
    return idMap(ids, await db.all(query) as Vehicle[])
  }

  async yearStats({ cc, mc }: CCMC): Promise<YearStatsDicts> {
    const where = cc ? `where cc=${cc}${mc ? ` and mc=${mc}` : ""}` : ""
    const { cmyc, cyc, yc } = this.urls
    const url = cc ? mc ? cmyc : cyc : yc
    const query = `
        select y, condition,
               cast(drivers + passengers + pedestrians + cyclists as int) as total,
               cast(num_crashes as int) as num_crashes
        from '${url}' ${where}
        order by y desc, condition asc
    `
    console.log("yearStats query:", query)
    const db = await this.db
    const yearStats = await db.all(query) as YearStats[]
    return toYearStatsDicts(yearStats)
  }
}

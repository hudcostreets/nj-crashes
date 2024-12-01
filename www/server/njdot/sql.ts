import Database, { Database as Db } from "better-sqlite3"
import { HasCrashPage } from "@/server/crash-page"
import { IdMap, idMap, Ids, Props } from "@/server/njdot/crash-page"
import { Crash, Crash0, Occupant, Pedestrian, Vehicle } from "@/src/njdot/crash"
import { CCMC } from "@/src/njsp/region"
import { DotSqlUrls } from "@/src/urls"
import { toYearStatsDicts, YearStats, YearStatsDicts } from "@/src/use-year-stats"
import { asyncQuery, CrashDB as CrashDB0, Params } from "../sql"

export class CrashDB extends CrashDB0<Crash0> {
  where({ cc, mc, }: CCMC): { where: string; params: Params } {
    const severities = [ 'i', 'f' ]
    const severitiesFilter = severities.map(s => `severity='${s}'`).join(' or ')
    const severitiesClause = severitiesFilter ? `(${severitiesFilter})` : ""
    let { where, params } = super.where({ cc, mc, })
    if (severitiesClause) {
      if (where) {
        where += ` and ${severitiesClause}`
      } else {
        where = `WHERE ${severitiesClause}`
      }
    }
    return { where, params }
  }
}

export class DotSql extends HasCrashPage<Crash> {
  private crashDb: CrashDB
  private yearStatsDb: Db
  private occupantsDb: Db
  private pedestriansDb: Db
  private vehiclesDb: Db

  constructor(urls: DotSqlUrls) {
    super()
    // console.log("dot dbs:", urls)
    const opts = { verbose: console.log }  // Remove in production
    this.crashDb = new CrashDB(urls.crashes)
    this.yearStatsDb = new Database(urls.cmymc, opts)
    this.occupantsDb = new Database(urls.occupants, opts)
    this.pedestriansDb = new Database(urls.pedestrians, opts)
    this.vehiclesDb = new Database(urls.vehicles, opts)
  }

  async crashes({ cc, mc, page, perPage, }: Props): Promise<Crash[]> {
    const crashes = await this._crashes({ cc, mc, page, perPage, })
    const ids = crashes.map(({ id }) => id)
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
    return this.crashDb.total({ cc, mc, })
  }

  _crashes({ cc, mc, page, perPage }: Props): Promise<Crash0[]> {
    return this.crashDb.crashes({ cc, mc, page, perPage, })
  }

  async occupants(ids: Ids): Promise<IdMap<Occupant>> {
    const query = `
        select crash_id, pos, condition, eject, age, sex, inj_loc, inj_type
        from occupants
        where crash_id in (${ids.join(', ')}) and condition >= 1 and condition < 5
        order by crash_id, condition, pos
    `
    return idMap(ids, await asyncQuery<Occupant>(this.occupantsDb, query, {}))
  }

  async pedestrians(ids: Ids): Promise<IdMap<Pedestrian>> {
    const query = `
        select crash_id, condition, age, sex, inj_loc, inj_type, cyclist
        from pedestrians
        where crash_id in (${ids.join(', ')}) and condition >= 1 and condition < 5
        order by crash_id, condition, cyclist
    `
    return idMap(ids, await asyncQuery<Pedestrian>(this.pedestriansDb, query, {}))
  }

  async vehicles(ids: Ids): Promise<IdMap<Vehicle>> {
    const query = `
        select
            crash_id,
            damage,
            damage_loc,
            impact_loc,
            departure,
            type
        from vehicles
        where crash_id in (${ids.join(', ')})
    `
    return idMap(ids, await asyncQuery<Vehicle>(this.vehiclesDb, query, {}))
  }

  async yearStats({ cc, mc }: CCMC): Promise<YearStatsDicts> {
    const where = cc ? `where cc=${cc}${mc ? ` and mc=${mc}` : ""}` : ""
    const table = (cc ? "c" : "") + (mc ? "m" : "") + "yc"
    const query = `
        select y, condition,
               drivers + passengers + pedestrians + cyclists as total,
               num_crashes as num_crashes
        from ${table} ${where}
        order by y desc, condition asc
    `
    return toYearStatsDicts(await asyncQuery<YearStats>(this.yearStatsDb, query, {}))
  }
}

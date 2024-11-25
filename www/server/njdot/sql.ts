import { Crash, CrashRec, Occupant, Pedestrian, Vehicle } from "@/src/njdot/crash"
import moment from "moment-timezone"
import Database, { Database as Db } from "better-sqlite3"
import { asyncQuery } from "../sql"
import { fromEntries } from "@rdub/base/objs"
import { toYearStatsDicts, YearStats, YearStatsDicts } from "@/src/use-year-stats"

export type Props = {
  cc: number | null
  mc: number | null
  before: string
  perPage: number
}

export type Ids = number[]
export type IdMap<T> = Record<number, T[]>

export function idMap<T>(ids: Ids, els: T[]): IdMap<T> {
  const map: IdMap<T> = fromEntries(ids.map(id => [ id, [] ]))
  els.forEach((el, i) => {
    map[ids[i]].push(el)
  })
  return map
}

export class DOTCrashDb {
  private db: Db
  constructor(path: string) {
    this.db = new Database(path, {
      verbose: console.log  // Remove in production
    })
  }

  async yearStats({ cc, mc }: Pick<Props, 'cc' | 'mc'>): Promise<YearStatsDicts> {
    const where = cc ? `where cc=${cc}${mc ? ` and mc=${mc}` : ""}` : ""
    const table = (cc ? "c" : "") + (mc ? "m" : "") + "yc"
    const query = `
        select y, condition,
               drivers + passengers + pedestrians + cyclists as total,
               num_crashes as num_crashes
        from ${table} ${where}
        order by y desc, condition asc
    `
    return toYearStatsDicts(await asyncQuery<YearStats>(this.db, query, {}))
  }

  crashes({ cc, mc, before, perPage }: Props): Promise<Crash[]> {
    const severities = [ 'i', 'f' ]
    const severitiesFilter = severities.map(s => `severity='${s}'`).join(' or ')
    const severitiesClause = severitiesFilter ? `(${severitiesFilter}) and ` : ""

    const regionClause = cc ? `cc=${cc}${mc ? ` and mc=${mc}` : ""} and ` : ""

    const m = moment.tz(before, "America/New_York").add(1, 'day')
    const mStr = m.format('YYYY-MM-DD')
    const dtClause = `dt<='${mStr}'`

    const query = `
        select * from crashes
        where ${severitiesClause}${regionClause}${dtClause}
        order by dt desc
        limit ${perPage}
    `
    return asyncQuery<Crash>(this.db, query, {})
  }

  async occupants(ids: Ids): Promise<IdMap<Occupant>> {
    const query = `
        select crash_id, pos, condition, eject, age, sex, inj_loc, inj_type
        from occupants
        where crash_id in (${ids.join(', ')}) and condition >= 1 and condition < 5
        order by crash_id, condition, pos
    `
    return idMap(ids, await asyncQuery<Occupant>(this.db, query, {}))
  }

  async pedestrians(ids: Ids): Promise<IdMap<Pedestrian>> {
    const query = `
        select crash_id, condition, age, sex, inj_loc, inj_type, cyclist
        from pedestrians
        where crash_id in (${ids.join(', ')}) and condition >= 1 and condition < 5
        order by crash_id, condition, cyclist
    `
    return idMap(ids, await asyncQuery<Pedestrian>(this.db, query, {}))
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
    return idMap(ids, await asyncQuery<Vehicle>(this.db, query, {}))
  }

  async crashRecs({ cc, mc, before, perPage, }: Props): Promise<CrashRec[]> {
    const crashes = await this.crashes({ cc, mc, before, perPage, })
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
}

import { cc2mc2mn } from "@/server/county"
import { CountyHomicides, Homicides } from "@/server/crime/ddb"
import { CC } from "@/src/njsp/region"

export type Row = {
    year: number
    homicides: number
}

export function getVsHomicides(
  { cc }: CC
): Promise<Row[]> {
  const cn = cc === null ? "NJ" : cc2mc2mn[cc].cn
  if (cn === "NJ") {
    return Homicides.query(`select year, homicides from parquet_scan('${Homicides.url}')`)
  } else {
    return CountyHomicides.query(`select year, murders as homicides from parquet_scan('${CountyHomicides.url}') where county='${cn}'`)
  }
}

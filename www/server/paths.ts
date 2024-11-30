import { dirname, join, relative } from "path";
import * as paths from "@/src/paths";
import { DotUrls } from "@/src/urls";

export const WWW = process.cwd()
export const PUBLIC = join(WWW, "public")
export const ROOT = dirname(WWW)
export const NJSP = join(PUBLIC, "njsp")
export const PLOTS = join(PUBLIC, "plots")
export const RUNDATE = join(NJSP, "rundate.json")

export const NJDOT = join(PUBLIC, "njdot")
export const CC2MC2MN = join(NJDOT, "cc2mc2mn.json")
export const CC2MC2MN_RELPATH = relative(WWW, CC2MC2MN)

export const NJSP_DATA = join(ROOT, "njsp", "data")
export const ProjectedCsv = join(PUBLIC, paths.ProjectedCsv)
export const YearTypeCountyCsv = join(NJSP_DATA, "year-type-county.csv")
export const NjspCrashesPqt = join(NJSP_DATA, "crashes.parquet")

export const NJDOT_DATA = join(ROOT, "njdot", "data")
export const DotPqts: DotUrls = {
  crashes: join(NJDOT_DATA, "crashes.parquet"),
  drivers: join(NJDOT_DATA, "drivers.parquet"),
  occupants: join(NJDOT_DATA, "occupants.parquet"),
  pedestrians: join(NJDOT_DATA, "pedestrians.parquet"),
  vehicles: join(NJDOT_DATA, "vehicles.parquet"),
}

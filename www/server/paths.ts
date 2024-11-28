import path, { dirname } from "path";
import * as paths from "@/src/paths";

export const WWW = process.cwd()
export const PUBLIC = path.join(WWW, "public")
export const ROOT = dirname(WWW)
export const NJSP = path.join(PUBLIC, "njsp")
export const PLOTS = path.join(PUBLIC, "plots")
export const RUNDATE = path.join(NJSP, "rundate.json")

export const NJDOT = path.join(PUBLIC, "njdot")
export const CC2MC2MN = path.join(NJDOT, "cc2mc2mn.json")
export const CC2MC2MN_RELPATH = path.relative(WWW, CC2MC2MN)

export const NJSP_DATA = path.join(ROOT, "njsp", "data")
export const ProjectedCsv = path.join(PUBLIC, paths.ProjectedCsv)
export const YearTypeCountyCsv = path.join(NJSP_DATA, "year-type-county.csv")

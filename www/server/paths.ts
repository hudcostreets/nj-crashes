import path, { dirname } from "path";

export const WWW = process.cwd()
export const PUBLIC = path.join(WWW, "public")
export const ROOT = dirname(WWW)
export const DATA = path.join(PUBLIC, "data")
export const NJSP = path.join(DATA, "njsp")
export const RUNDATE = path.join(NJSP, "rundate.json")
export const RUNDATE_RELPATH = path.relative(ROOT, RUNDATE)

export const NJDOT = path.join(DATA, "njdot")
export const CC2MC2MN = path.join(NJDOT, "cc2mc2mn.json")
export const CC2MC2MN_RELPATH = path.relative(ROOT, CC2MC2MN)

import path from "path";

export const WWW = process.cwd()
export const PUBLIC = path.join(WWW, "public")
export const NJSP = path.join(PUBLIC, "njsp")

export const NJDOT = path.join(PUBLIC, "njdot")
export const CC2MC2MN = path.join(NJDOT, "cc2mc2mn.json")
export const CC2MC2MN_RELPATH = path.relative(WWW, CC2MC2MN)

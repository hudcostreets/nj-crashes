import { join, resolve } from "path"
import { cwd } from "process"

export const publicDir = resolve(cwd(), 'public')
export const plotsDir = join(publicDir, 'plots')
export const njdotDir = join(plotsDir, 'njdot')

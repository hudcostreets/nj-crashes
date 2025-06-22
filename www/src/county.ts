import { titleCase } from "@rdub/base/str"

export type MC2MN = { [mc: number]: string }
export type County = { cn: string, mc2mn: MC2MN }
export type CC2MC2MN = { [cc: number]: County }
export type CC = { cc: number }

export const normalize = (s: string) => s.toLowerCase().replaceAll(' ', '-')

export const denormalize = (s: string) => titleCase(s.replaceAll('-', ' '))

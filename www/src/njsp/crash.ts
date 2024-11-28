import type { CrashPage as CrashPage0 } from "@/src/crash"

export type Crash = {
  id: number
  cc: number
  mc: number
  dt: string
  tk: number
  ti: number
  dk: number
  ok: number
  pk: number
  bk: number
  location: string
  street: string
  highway: string
}

export type CrashPage = CrashPage0<Crash>

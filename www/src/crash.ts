export type Total = { total: number }
export type WithTotal<T> = T & Total
export type T<T> = T & { total: number }

export type CrashPage<Crash> = T<{ crashes: Crash[] }>

type Dispatch<A> = (value: A) => void

export type Param<T = any, U = Dispatch<T>> = {
  encode: (t: T) => string | undefined
  decode: (v: string | undefined) => T
  push?: boolean
  use?: (init: T) => [ T, U ]
}

export type Params = Record<string, Param>

export type ParamType<P> = P extends Param<infer T> ? T : never

// Helper type to convert an object of Params to an object of their value types
export type ParsedParams<P extends Params> = {
  [K in keyof P]: ParamType<P[K]>
}

export function intParam(init: number, push: boolean = true): Param<number> {
  return {
    encode: v => v === init ? undefined : v.toString(),
    decode: v => v ? parseInt(v) : init,
    push,
  }
}

export function optIntParam(push: boolean = true): Param<number | null> {
  return {
    encode: v => {
      if (v === null) return undefined
      return v.toString()
    },
    decode: v => {
      if (v === undefined) return null
      return parseInt(v)
    },
    push,
  }
}

import { floatParam, LL, llParam, Param, ParsedParam, parseHashParams, updateHashParams } from "@rdub/next-params/params";

export type Params = {
    ll: Param<LL>
    z: Param<number>
}

export type ParsedParams = {
    ll: ParsedParam<LL>
    z: ParsedParam<number>
}

export const DEFAULT_CENTER = { lat: 40.73, lng: -74.08 }
export const DEFAULT_ZOOM = 12

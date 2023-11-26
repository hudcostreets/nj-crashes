import { floatParam, LL, llParam, Param, ParsedParam, parseHashParams, updateHashParams } from "next-utils/params";

export type Params = {
    ll: Param<LL>
    z: Param<number>
}

export type ParsedParams = {
    ll: ParsedParam<LL>
    z: ParsedParam<number>
}

export const DEFAULT_CENTER = { lat: 40.725527, lng: -74.042037 }
export const DEFAULT_ZOOM = 11

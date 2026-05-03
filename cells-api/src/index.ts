/** Cloudflare Worker entrypoint for `crashes-cells-api`.
 *
 *  Endpoints:
 *    GET /v1/cells?cells=h3a,h3b,...&res=N[&years=Y0-Y1][&severities=fip][&polygon=lon,lat,...]
 *    GET /v1/manifest                   # the cached manifest, for debug
 *    GET /healthz
 *
 *  The `cells` param is the list of `shard_res` parent cells the client
 *  wants. Client computes that set from its viewport bbox via
 *  `polygonToCellsExperimental`. Per-shard responses are cached on the
 *  client by URL — pan over already-fetched shards = no worker calls.
 *  Caching: the response carries an ETag derived from the request params
 *  + the manifest's `data_version`. Pipeline pushes new data → bumps
 *  `data_version` → invalidates. Edge cache TTL = 1h unconditional, 24h
 *  conditional revalidation.
 */
import { handleCellsRequest, HttpError, parseCellsRequest } from "./cells"
import { loadManifest } from "./manifest"

interface Env {
    CELLS_BUCKET: R2Bucket
    CORS_ORIGIN: string
    CELLS_PREFIX: string
}

function corsHeaders(env: Env, extra: HeadersInit = {}): HeadersInit {
    return {
        "Access-Control-Allow-Origin": env.CORS_ORIGIN ?? "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
        "Content-Type": "application/json",
        ...extra,
    }
}

async function etagFor(req: Request, dataVersion: string): Promise<string> {
    const url = new URL(req.url)
    const buf = new TextEncoder().encode(`${url.pathname}?${url.searchParams}|${dataVersion}`)
    const digest = await crypto.subtle.digest("SHA-1", buf)
    const hex = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, "0")).join("")
    return `"${hex.slice(0, 16)}"`
}

function jsonReplacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value
}

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url)
        const { pathname } = url

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(env) })
        }
        if (request.method !== "GET") {
            return new Response("method not allowed", { status: 405, headers: corsHeaders(env) })
        }

        try {
            if (pathname === "/healthz") {
                return new Response("ok", { headers: corsHeaders(env, { "Content-Type": "text/plain" }) })
            }
            const prefix = env.CELLS_PREFIX || "cells"
            if (pathname === "/v1/manifest") {
                const m = await loadManifest(env.CELLS_BUCKET, prefix)
                return new Response(JSON.stringify(m, jsonReplacer), { headers: corsHeaders(env) })
            }
            if (pathname === "/v1/cells") {
                const cellsReq = parseCellsRequest(url)
                const manifest = await loadManifest(env.CELLS_BUCKET, prefix)
                const tag = await etagFor(request, manifest.data_version)
                if (request.headers.get("If-None-Match") === tag) {
                    return new Response(null, { status: 304, headers: corsHeaders(env, { ETag: tag }) })
                }
                const body = await handleCellsRequest(env.CELLS_BUCKET, prefix, cellsReq)
                return new Response(JSON.stringify(body, jsonReplacer), {
                    headers: corsHeaders(env, {
                        ETag: tag,
                        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
                    }),
                })
            }
            return new Response("not found", { status: 404, headers: corsHeaders(env) })
        } catch (e) {
            if (e instanceof HttpError) {
                return new Response(JSON.stringify({ error: e.message }), {
                    status: e.status, headers: corsHeaders(env),
                })
            }
            console.error(e)
            return new Response(JSON.stringify({ error: "internal error" }), {
                status: 500, headers: corsHeaders(env),
            })
        }
    },
}

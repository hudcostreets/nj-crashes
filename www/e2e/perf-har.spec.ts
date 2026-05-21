/**
 * Per-scenario page-load gallery. Loads named URLs, captures each
 * network response (`page.on('response')`), normalizes the request set
 * (strip cache-busters, hash-suffixed bundles, vite-dev module queries),
 * and asserts the *exact set* of `{url, status, body_size}` against a
 * committed golden JSON.
 *
 * Run:                pnpm test:perf
 * Regenerate golden:  pnpm test:perf:update      (PERF_UPDATE_GOLDEN=1)
 *
 * Filtering: dev-server module requests (`/src/...`, `?import`,
 * `/@fs/...`, etc.) are dropped because they're vite's ESM streaming
 * artifacts that don't exist in production builds. What remains is the
 * user-meaningful network: cells-api, static parquets (S3), data CSVs
 * (CFP). Both dev and prod should see the same set there.
 *
 * Latency (`p50`, `p95` over `PERF_RUNS` runs) lands in a separate
 * `<name>.timing.json` — drift over `PERF_LATENCY_WARN_PCT` is a
 * warning, not a failure (CI runners have variable bandwidth).
 *
 * Adding a scenario: add an entry to `SCENARIOS` and run
 * `pnpm test:perf:update`.
 */
import { test, expect } from "@playwright/test"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(__dirname, "perf-har")

if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true })

const UPDATE = process.env.PERF_UPDATE_GOLDEN === "1"
const RUNS_PER_SCENARIO = Number(process.env.PERF_RUNS ?? "3")
const LATENCY_WARN_PCT = Number(process.env.PERF_LATENCY_WARN_PCT ?? "30")

type Scenario = {
    name: string
    /** Path-relative to baseURL. URL state encodes the deterministic
     *  snap-grid bbox so the request set is reproducible. */
    path: string
    /** Wait for at least this many cells-api responses before snapshotting,
     *  guarding against capturing mid-fetch. */
    minCellsResponses: number
    /** Optional explicit settle delay (ms). Default 3000. */
    settleMs?: number
}

const SCENARIOS: Scenario[] = [
    {
        name: "cold-homepage",
        path: "/",
        minCellsResponses: 1,
    },
    {
        name: "jersey-city-z14",
        path: "/?llz=40.7239-74.0500+14.73+0+0&y=2016-2025",
        minCellsResponses: 1,
    },
    {
        name: "jersey-city-z15",
        path: "/?llz=40.7271-74.0515+15.76+0+0&y=2016-2025",
        minCellsResponses: 2,
    },
    {
        name: "hudson-county",
        path: "/c/hudson",
        minCellsResponses: 1,
    },
]

type Entry = {
    url: string
    status: number
    body_size: number
}

/** Drop vite dev-only requests (ESM module streaming, source maps,
 *  HMR pings). These don't exist in prod builds. Result is the
 *  user-meaningful network: cells-api, parquets, JSON/CSV data, images. */
function isDevOnly(url: string): boolean {
    if (url.startsWith("data:") || url.startsWith("blob:")) return false
    let u: URL
    try { u = new URL(url) } catch { return false }
    if (u.hostname !== "localhost") return false
    const p = u.pathname
    // Vite serves source modules under /src/ and /@fs/, and `?import`
    // (or `?t=...`) marker queries. Also /node_modules/.vite/ deps.
    if (p.startsWith("/src/")) return true
    if (p.startsWith("/@fs/") || p.startsWith("/@vite/") || p.startsWith("/@id/") || p.startsWith("/@react-refresh")) return true
    if (p.startsWith("/node_modules/")) return true
    if (u.searchParams.has("import") || u.searchParams.has("t") || u.searchParams.has("v")) return true
    if (p.endsWith(".tsx") || p.endsWith(".ts") || p.endsWith(".jsx") || p.endsWith(".scss") || p.endsWith(".sass")) return true
    return false
}

/** Strip cache-busting params (`?_=...`); collapse Vite hash-suffixed
 *  asset bundles (`index-VM0FAdj7.js` → `index-<hash>.js`); collapse
 *  `blob:` URLs to a stable token (MapLibre instantiates workers via
 *  `URL.createObjectURL(blob)`, yielding a fresh UUID per session).
 *  Keeps semantic params (years, severities, cells, shard_res, polygon). */
function normalizeUrl(url: string): string {
    if (url.startsWith("blob:")) return "blob:<session>"
    let u: URL
    try { u = new URL(url) } catch { return url }
    u.searchParams.delete("_")
    u.searchParams.delete("__")
    let s = u.toString()
    s = s.replace(/-[A-Za-z0-9_]{8}\.(js|css|woff2?|ttf)(?=$|\?)/g, "-<hash>.$1")
    return s
}

/** Collapse all `/v1/cells?…` batched requests into a single summary
 *  entry. Batch boundaries vary between runs because the picker fires
 *  multiple times during URL-driven zoom transitions and the
 *  cache-miss set differs each time; but the *union* of fetched shards
 *  is stable for a given viewport. Aggregated entry's URL encodes the
 *  sorted shard list + non-batch params (res, years, sevs, shard_res,
 *  polygon) so the golden still pins what data was fetched. */
function aggregateCellsApi(entries: Entry[]): Entry[] {
    const cellsBuckets = new Map<string, { shards: Set<string>; bytes: number; count: number }>()
    const passthrough: Entry[] = []
    for (const e of entries) {
        const m = /^(https?:\/\/[^/]+)\/v1\/cells\?(.+)$/.exec(e.url)
        if (!m) { passthrough.push(e); continue }
        const params = new URLSearchParams(m[2])
        const cells = (params.get("cells") ?? "").split(",").filter(Boolean)
        params.delete("cells")
        const key = `${m[1]}/v1/cells?${params.toString()}`
        let b = cellsBuckets.get(key)
        if (!b) { b = { shards: new Set(), bytes: 0, count: 0 }; cellsBuckets.set(key, b) }
        for (const s of cells) b.shards.add(s)
        b.bytes += Number.isFinite(e.body_size) ? e.body_size : 0
        b.count += 1
    }
    for (const [key, b] of cellsBuckets) {
        const shards = [...b.shards].sort().join(",")
        // Drop batch-count from the URL — it varies between runs based
        // on cache-miss timing, but the *shards fetched* is what we want
        // to pin.
        passthrough.push({
            url: `${key}&cells=${shards}`,
            status: 200,
            body_size: b.bytes,
        })
    }
    return passthrough
}

function sortEntries(entries: Entry[]): Entry[] {
    return [...entries].sort((a, b) =>
        a.url < b.url ? -1 : a.url > b.url ? 1 :
        a.status - b.status || a.body_size - b.body_size,
    )
}

function quantile(values: number[], q: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
    return sorted[i]
}

for (const sc of SCENARIOS) {
    test(`perf-har: ${sc.name}`, async ({ playwright, baseURL }) => {
        const goldenPath = join(GOLDEN_DIR, `${sc.name}.json`)
        const timingPath = join(GOLDEN_DIR, `${sc.name}.timing.json`)
        const latencies: number[] = []
        let lastEntries: Entry[] = []
        let lastCellsResponses = 0

        for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
            const browser = await playwright.chromium.launch()
            const context = await browser.newContext({ baseURL })
            const page = await context.newPage()

            const captured: Array<{ url: string; status: number; bodyPromise: Promise<number> }> = []
            let cellsResponses = 0
            page.on("response", res => {
                const url = res.url()
                if (/\/v1\/cells\b/.test(url)) cellsResponses++
                if (isDevOnly(url)) return
                if (url.endsWith(".map")) return
                if (url.includes("/favicon")) return
                captured.push({
                    url,
                    status: res.status(),
                    // Body size — use `body()` length; fall back to 0 for
                    // resources without a body (304s, redirects).
                    bodyPromise: res.body().then(b => b?.length ?? 0).catch(() => 0),
                })
            })

            const t0 = Date.now()
            await page.goto(sc.path, { waitUntil: "domcontentloaded" })
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {})
            await page.waitForTimeout(sc.settleMs ?? 3000)
            const t1 = Date.now()
            latencies.push(t1 - t0)

            // Resolve all body sizes before closing context — once context
            // closes, body() rejects.
            const sizes = await Promise.all(captured.map(c => c.bodyPromise))
            await context.close()
            await browser.close()

            const entries: Entry[] = captured.map((c, i) => ({
                url: normalizeUrl(c.url),
                status: c.status,
                body_size: sizes[i],
            }))
            lastEntries = sortEntries(aggregateCellsApi(entries))
            lastCellsResponses = cellsResponses
        }

        // A scenario that declares `minCellsResponses` must actually
        // fetch that many `/v1/cells` responses. Without this guard a
        // broken map (empty cover → zero fetches) silently bakes into
        // the golden under `PERF_UPDATE_GOLDEN=1`.
        if (lastCellsResponses < sc.minCellsResponses) {
            throw new Error(
                `${sc.name}: ${lastCellsResponses} /v1/cells response(s), ` +
                `expected ≥ ${sc.minCellsResponses} — the map fetched no crash data. ` +
                `Refusing to ${UPDATE ? "write" : "verify against"} a broken golden.`,
            )
        }

        const p50 = quantile(latencies, 0.5)
        const p95 = quantile(latencies, 0.95)
        const timing = { p50_ms: p50, p95_ms: p95, runs: RUNS_PER_SCENARIO }

        if (UPDATE) {
            writeFileSync(goldenPath, JSON.stringify(lastEntries, null, 2) + "\n")
            writeFileSync(timingPath, JSON.stringify(timing, null, 2) + "\n")
            const totalBytes = lastEntries.reduce((s, e) => s + e.body_size, 0)
            console.log(`[update] ${sc.name}: ${lastEntries.length} entries, ${totalBytes.toLocaleString()} bytes; p50=${p50}ms p95=${p95}ms`)
            return
        }

        if (!existsSync(goldenPath)) {
            throw new Error(`No golden at ${goldenPath}. Run with PERF_UPDATE_GOLDEN=1 first.`)
        }
        const golden: Entry[] = JSON.parse(readFileSync(goldenPath, "utf8"))
        expect(lastEntries).toEqual(golden)

        // Latency drift warning (non-failing).
        if (existsSync(timingPath)) {
            const goldenTiming = JSON.parse(readFileSync(timingPath, "utf8"))
            const driftPct = ((p50 - goldenTiming.p50_ms) / goldenTiming.p50_ms) * 100
            if (Math.abs(driftPct) > LATENCY_WARN_PCT) {
                console.warn(`[${sc.name}] p50 drift: ${driftPct.toFixed(1)}% (golden ${goldenTiming.p50_ms}ms, now ${p50}ms)`)
            }
        }
    })
}

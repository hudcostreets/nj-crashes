// Map interaction benchmark: pan / wheel zoom / road-hover sweep / year change, with CPU-profile
// attribution (see specs/map-mobile-perf.md § Round 2).
//
// Usage: node scripts/interaction-perf.mjs <app-base-url> <label> [desktop|phone] [path]
//   env: CPU=<throttle> (default 1 desktop, 4 phone), HEADLESS=1 (default headful, real GPU),
//        RUNS=<n> (repeat the interaction steps n times; default 1), PROFILE=0 (skip CPU profiles)
//
// Serve an unminified build with source maps (readable function names; self time bucketed by npm
// package / app file), e.g.
//   VITE_CELLS_API_BASE=https://crashes-cells-dev.hccs.dev VITE_MAP_BASE_URL=https://crashes-data.hccs.dev/njdot/map \
//     pnpm exec vite build --minify false --sourcemap --outDir tmp/dist-x && pnpm exec vite preview --outDir tmp/dist-x --port 5249
//
// Per step it reports: rAF frame intervals *during the interaction* (p50 / p95 / max / count > 50 ms),
// long tasks, React commits (via a minimal DevTools global hook), heatmap weight-map re-renders
// (`perf=1` page counter), `/v1/cells` requests (duration, bytes, edge-cache hit / miss), requests
// by kind (cells API, road parquets, basemap tiles), time to settle, and from a CDP CPU profile:
// inclusive time under a few named functions, self time by package, and the top self-time
// functions. Writes tmp/iperf-<label>.json.
import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"

const [base, label, kind = "desktop", pathArg] = process.argv.slice(2)
if (!base || !label) {
    console.error("usage: interaction-perf.mjs <base-url> <label> [desktop|phone] [path]")
    process.exit(1)
}
const phone = kind === "phone"
const cpu = Number(process.env.CPU ?? (phone ? 4 : 1))
const runs = Number(process.env.RUNS ?? 1)
const profile = process.env.PROFILE !== "0"
// `perf=1`: the page counts heatmap weight-map re-renders (`__crashMapDebug.heatWeightmaps`).
const path = (pathArg ?? "/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013") + "&perf=1"

// `GPU=swiftshader` renders WebGL in software: a stand-in for a weak (phone / integrated) GPU, which
// makes per-frame GPU work (e.g. heatmap re-aggregation) show up as frame time.
const gpuArgs = process.env.GPU === "swiftshader"
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : ["--enable-gpu", "--ignore-gpu-blocklist"]
const browser = await chromium.launch({
    headless: process.env.HEADLESS === "1",
    args: [...gpuArgs, "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
})
const ctx = await browser.newContext(phone ? {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
} : {
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
})
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
await cdp.send("Profiler.enable")
await cdp.send("Profiler.setSamplingInterval", { interval: 250 })
await page.addInitScript(() => {
    const w = window
    w.__lt = []
    new PerformanceObserver(l => { for (const e of l.getEntries()) w.__lt.push([e.startTime, e.duration]) })
        .observe({ type: "longtask", buffered: true })
    w.__frames = []
    let last = performance.now()
    const tick = t => { w.__frames.push([t, t - last]); last = t; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    // Count React commits: React looks for this hook at startup (production builds too).
    w.__commits = []
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true, renderers: new Map(), inject() { return 1 }, checkDCE() {},
        onCommitFiberRoot() { w.__commits.push(performance.now()) }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
        onScheduleFiberRoot() {}, setStrictMode() {},
    }
})
const consoleCounts = new Map()
page.on("console", m => {
    const t = m.text().slice(0, 90)
    consoleCounts.set(t, (consoleCounts.get(t) ?? 0) + 1)
})

function reqKind(url) {
    if (url.includes("/v1/cells")) return "cells"
    if (url.includes("/v1/")) return "api"
    const m = /\/roads\/([\w-]+)\.parquet/.exec(url)
    if (m) return `roads:${m[1]}`
    if (/stadiamaps|tiles\./.test(url)) return "tiles"
    return null
}
let inflight = 0
const reqLog = []
page.on("request", r => {
    const k = reqKind(r.url())
    if (k === "cells" || k === "api" || k?.startsWith("roads:")) inflight++
})
const done = (r, failed) => {
    const k = reqKind(r.url())
    if (k === "cells" || k === "api" || k?.startsWith("roads:")) inflight--
    if (k) reqLog.push({ t: Date.now(), kind: k, failed, url: r.url() })
}
page.on("requestfinished", r => done(r, false))
page.on("requestfailed", r => done(r, true))

const now = () => page.evaluate(() => performance.now())
async function settle(quietMs = 1200, minMs = 900, maxMs = 60000) {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
        await new Promise(r => setTimeout(r, 100))
        if (inflight > 0 || Date.now() - t0 < minMs) continue
        const [pnow, last] = await page.evaluate(() => {
            const ends = performance.getEntriesByType("resource").filter(e => e.name.includes("/v1/") || e.name.includes("/roads/")).map(e => e.responseEnd)
            return [performance.now(), Math.max(0, ...ends, ...window.__lt.map(([s, d]) => s + d), ...window.__commits)]
        })
        if (pnow - last > quietMs) return last
    }
    throw new Error("settle timeout")
}

// Source maps (a `--sourcemap` build): self time is bucketed by npm package / app source file.
const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]))
/** Per generated line: sorted `[genCol, sourceIndex]` pairs. */
function decodeMappings(mappings) {
    const lines = []
    let src = 0
    for (const line of mappings.split(";")) {
        const segs = []
        let col = 0
        for (const seg of line.split(",")) {
            if (!seg) continue
            const vals = []
            let v = 0, shift = 0
            for (const ch of seg) {
                const d = B64[ch]
                v += (d & 31) << shift
                if (d & 32) { shift += 5; continue }
                vals.push(v & 1 ? -(v >>> 1) : v >>> 1)
                v = 0; shift = 0
            }
            // Fields: generated column, source index, source line, source column, name (all
            // deltas); only the source index matters here.
            col += vals[0]
            if (vals.length > 1) { src += vals[1]; segs.push([col, src]) }
        }
        lines.push(segs)
    }
    return lines
}
const maps = new Map()
async function sourceOf(url, line, col) {
    if (!url.startsWith("http")) return null
    let m = maps.get(url)
    if (m === undefined) {
        m = null
        try {
            const r = await fetch(url + ".map")
            if (r.ok) {
                const j = await r.json()
                m = { sources: j.sources, lines: decodeMappings(j.mappings) }
            }
        } catch { /* no map */ }
        maps.set(url, m)
    }
    const segs = m?.lines[line]
    if (!segs?.length) return null
    let lo = 0, hi = segs.length - 1, best = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (segs[mid][0] <= col) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    return best < 0 ? null : m.sources[segs[best][1]]
}
function bucketOf(source) {
    if (!source) return null
    const i = source.lastIndexOf("node_modules/")
    if (i >= 0) {
        const rest = source.slice(i + 13).split("/")
        return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]
    }
    const j = source.indexOf("src/")
    return `app:${j >= 0 ? source.slice(j) : source}`
}

/** Top self-time functions of a CDP CPU profile, plus coarse buckets. */
async function summarizeProfile(prof) {
    const byBucket = new Map()
    {
        const byNode = new Map(prof.nodes.map(n => [n.id, n]))
        const nodeSelf = new Map()
        for (let i = 0; i < prof.samples.length; i++) nodeSelf.set(prof.samples[i], (nodeSelf.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000)
        for (const [id, ms] of nodeSelf) {
            const cf = byNode.get(id).callFrame
            const b = cf.url ? bucketOf(await sourceOf(cf.url, cf.lineNumber, cf.columnNumber)) ?? "(unmapped js)" : cf.functionName || "(native)"
            byBucket.set(b, (byBucket.get(b) ?? 0) + ms)
        }
    }
    const buckets = [...byBucket.entries()].filter(([k]) => k !== "(idle)").sort((a, b) => b[1] - a[1]).slice(0, 14)
        .map(([k, ms]) => [k, Math.round(ms)])
    const byId = new Map(prof.nodes.map(n => [n.id, n]))
    const self = new Map()
    for (let i = 0; i < prof.samples.length; i++) {
        const n = byId.get(prof.samples[i])
        const dt = (prof.timeDeltas[i] ?? 0) / 1000
        const cf = n.callFrame
        const file = cf.url ? cf.url.split("/").pop().replace(/-[\w-]{8}\.js$/, ".js") : ""
        const key = `${cf.functionName || "(anon)"} ${file}${cf.url ? ":" + (cf.lineNumber + 1) : ""}`
        self.set(key, (self.get(key) ?? 0) + dt)
    }
    // Inclusive time under a few named functions (each sample counted once per name), grouping
    // the self-time scatter into React / deck.gl / maplibre / app work.
    const parent = new Map()
    for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
    const INCL = {
        "CrashMapSection render": ["CrashMapSection"],
        "deck frame": ["_onRenderFrame"],
        "deck layer updates": ["updateLayers"],
        "deck draw": ["renderLayers"],
        "heatmap weightmap": ["_updateWeightmap"],
        "maplibre render": ["_render"],
        "nearestRoad": ["nearestRoad"],
        "parquet reads": ["readRows", "parquetReadObjects"],
        "lean decode/aggregate": ["decodeLean", "aggregateLean", "aggregateLeanTables"],
        "JSON.parse": ["parse"],
        "heat C bake": ["splatDensity", "colorizeDensity", "densityQuantile"],
    }
    const incl = Object.fromEntries(Object.keys(INCL).map(k => [k, 0]))
    for (let i = 0; i < prof.samples.length; i++) {
        const dt = (prof.timeDeltas[i] ?? 0) / 1000
        const names = new Set()
        for (let id = prof.samples[i]; id !== undefined; id = parent.get(id)) names.add(byId.get(id).callFrame.functionName)
        for (const [k, fns] of Object.entries(INCL)) if (fns.some(f => names.has(f))) incl[k] += dt
    }
    for (const k in incl) incl[k] = Math.round(incl[k])
    const total = [...self.values()].reduce((a, b) => a + b, 0)
    const idle = (self.get("(idle) ") ?? 0) + (self.get("(program) ") ?? 0)
    const top = [...self.entries()].filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, 25)
        .map(([k, ms]) => [k, Math.round(ms * 10) / 10])
    return { totalMs: Math.round(total), busyMs: Math.round(total - (self.get("(idle) ") ?? 0)), programMs: Math.round(self.get("(program) ") ?? 0), gcMs: Math.round(self.get("(garbage collector) ") ?? 0), idleMs: Math.round(idle), incl, buckets, top }
}

let lastWeightmaps = 0
/** macOS swap in use (MB): numbers taken while swapping are skewed, so each step records it. */
function swapUsedMb() {
    try {
        const m = /used = ([\d.]+)M/.exec(execSync("sysctl vm.swapusage", { encoding: "utf8" }))
        return m ? Math.round(+m[1]) : null
    } catch { return null }
}
async function step(name, fn) {
    if (profile) await cdp.send("Profiler.start")
    const tw0 = Date.now()
    const t0 = await now()
    await fn()
    const t1 = await now()
    const tEnd = Math.max(t1, await settle())
    const prof = profile ? await summarizeProfile((await cdp.send("Profiler.stop")).profile) : null
    const r = await page.evaluate(([t0, t1, tEnd]) => {
        const q = (fr, p) => fr.length ? Math.round(fr[Math.min(fr.length - 1, Math.floor(p * fr.length))]) : null
        const frames = (a, b) => {
            const fr = window.__frames.filter(([s]) => s > a && s <= b).map(x => x[1]).sort((x, y) => x - y)
            return { n: fr.length, p50: q(fr, 0.5), p95: q(fr, 0.95), max: q(fr, 1), over50: fr.filter(x => x > 50).length }
        }
        const lt = window.__lt.filter(([s]) => s >= t0 && s <= tEnd)
        return {
            interactMs: Math.round(t1 - t0),
            settleMs: Math.round(tEnd - t0),
            framesDuring: frames(t0, t1 + 50),
            framesAfter: frames(t1 + 50, tEnd),
            longTasks: lt.length,
            longTaskMs: Math.round(lt.reduce((s, x) => s + x[1], 0)),
            maxLongTaskMs: Math.round(Math.max(0, ...lt.map(x => x[1]))),
            commits: window.__commits.filter(t => t >= t0 && t <= tEnd).length,
            commitsDuring: window.__commits.filter(t => t >= t0 && t <= t1).length,
            heatWeightmaps: window.__crashMapDebug?.heatWeightmaps ?? 0,
            cells: performance.getEntriesByType("resource")
                .filter(e => e.name.includes("/v1/cells") && e.startTime >= t0)
                .map(e => {
                    const st = Object.fromEntries((e.serverTiming || []).map(s => [s.name, s.description || Math.round(s.duration)]))
                    const u = new URL(e.name)
                    return `l${u.searchParams.get("res")} ${Math.round(e.duration)}ms enc=${e.encodedBodySize} dec=${e.decodedBodySize} cache=${st.cache ?? "?"} total=${st.total ?? "?"}`
                }),
        }
    }, [t0, t1, tEnd])
    const wm = r.heatWeightmaps - lastWeightmaps
    lastWeightmaps = r.heatWeightmaps
    r.heatWeightmaps = wm
    const reqs = {}
    for (const e of reqLog.filter(e => e.t >= tw0)) reqs[e.kind] = (reqs[e.kind] ?? 0) + 1
    const swapMb = swapUsedMb()
    const out = { step: name, ...r, reqs, swapMb, profile: prof }
    const f = r.framesDuring
    console.log(`${label} ${name.padEnd(10)} interact=${r.interactMs}ms settle=${r.settleMs}ms frames(during) n=${f.n} p50/p95/max=${f.p50}/${f.p95}/${f.max} >50=${f.over50} longTasks=${r.longTasks}/${r.longTaskMs}ms(max ${r.maxLongTaskMs}) heatWeightmaps=${r.heatWeightmaps} commits=${r.commitsDuring}/${r.commits} reqs=${JSON.stringify(reqs)} swap=${swapMb}MB${prof ? ` busy=${prof.busyMs}ms gc=${prof.gcMs}ms` : ""}`)
    for (const c of r.cells) console.log(`    cells ${c}`)
    if (prof) console.log(`    incl: ${Object.entries(prof.incl).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}ms`).join(" ")}`)
    if (prof) console.log(`    self by package: ${prof.buckets.map(([k, v]) => `${k}=${v}`).join(" ")}`)
    if (prof) for (const [k, ms] of prof.top.slice(0, 12)) console.log(`      ${String(ms).padStart(7)}ms  ${k}`)
    return out
}

const center = async () => {
    const box = await page.locator("#deckgl-overlay").boundingBox()
    return [box.x + box.width / 2, box.y + box.height / 2, box]
}
/** A ~1 s drag: 60 moves at ~16 ms (a real drag's event rate). */
async function drag(dx, dy) {
    const [x, y] = await center()
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 60; i++) {
        await page.mouse.move(x + dx * i / 60, y + dy * i / 60)
        await page.waitForTimeout(16)
    }
    await page.mouse.up()
}
/** Trackpad-like wheel zoom: 20 small deltas at ~16 ms. */
async function wheel(deltaY) {
    const [x, y] = await center()
    await page.mouse.move(x, y)
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, deltaY / 20); await page.waitForTimeout(16) }
}
/** Sweep the cursor across the street grid: a zigzag of 240 moves at ~8 ms (~2 s). */
async function hoverSweep() {
    const [, , box] = await center()
    const x0 = box.x + box.width * 0.15, x1 = box.x + box.width * 0.85
    const rows = [0.3, 0.45, 0.6, 0.75]
    let i = 0
    for (const fy of rows) {
        const y = box.y + box.height * fy
        for (let k = 0; k <= 60; k++, i++) {
            const t = k / 60
            await page.mouse.move(i % 122 < 61 ? x0 + (x1 - x0) * t : x1 - (x1 - x0) * t, y + 8 * Math.sin(k))
            await page.waitForTimeout(8)
        }
    }
}
async function setYear(i, v) {
    await page.locator("select").nth(i).selectOption(String(v))
}

const results = { label, kind, cpu, path, base, steps: [] }
results.steps.push(await step("load", async () => {
    await page.goto(base + path)
    await page.locator("#deckgl-overlay").waitFor()
}))
results.gl = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2")
    const d = c?.getExtension("WEBGL_debug_renderer_info")
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"
})
console.log(`${label} gl: ${results.gl}`)
// `STEPS=pan-x,hover` runs a subset.
const only = process.env.STEPS ? new Set(process.env.STEPS.split(",")) : null
for (let run = 0; run < runs; run++) {
    const sfx = runs > 1 ? `#${run + 1}` : ""
    const steps = [
        ["pan-x", () => drag(-500, 0)],
        ["pan-y", () => drag(0, 300)],
        ["zoom-in", () => wheel(-300)],
        ["zoom-out", () => wheel(300)],
        ...(phone ? [] : [["hover", hoverSweep]]),
        ["year", () => setYear(1, run % 2 ? 2013 : 2016)],
    ]
    for (const [name, fn] of steps) {
        if (only && !only.has(name)) continue
        results.steps.push(await step(`${name}${sfx}`, fn))
    }
}
results.console = Object.fromEntries([...consoleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
console.log(`${label} console:`, results.console)
mkdirSync("tmp", { recursive: true })
writeFileSync(`tmp/iperf-${label}.json`, JSON.stringify(results, null, 1) + "\n")
await browser.close()

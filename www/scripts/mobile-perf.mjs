// Phone-emulated map interaction benchmark (see specs/map-mobile-perf.md).
// Usage: node scripts/mobile-perf.mjs <app-base-url> <label> [cpuThrottle=4] [path]
// (serve a build first, e.g. `vite build --outDir tmp/dist && vite preview --outDir tmp/dist`).
// Emulates a 390x844 DPR-2.75 touch phone with CPU throttling, then runs:
// load → pan → pan → zoom-in → year change ×2, recording per step the
// /v1/cells requests (bytes, duration, Server-Timing), long tasks, rAF
// frame intervals, and time-to-settle. Writes tmp/perf-<label>.json.
// Headless Chromium on macOS renders WebGL on the real GPU (ANGLE/Metal), so
// GPU-bound frame stalls (e.g. deck.gl `HeatmapLayer`) do show up.
import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"

const [base, label, cpuArg, pathArg] = process.argv.slice(2)
const cpu = Number(cpuArg ?? 4)
const path = pathArg ?? "/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013"

const browser = await chromium.launch({ channel: "chromium", args: ["--enable-gpu", "--ignore-gpu-blocklist"] })
const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
})
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
await page.addInitScript(() => {
    const w = window
    w.__lt = []
    new PerformanceObserver(l => { for (const e of l.getEntries()) w.__lt.push([e.startTime, e.duration]) })
        .observe({ type: "longtask", buffered: true })
    w.__frames = []
    let last = performance.now()
    const tick = t => { w.__frames.push([t, t - last]); last = t; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
})

const now = () => page.evaluate(() => performance.now())
// In-flight /v1/ requests, tracked from Node (Resource Timing only lists
// *completed* requests, so a page-side check can't see one in flight).
let inflight = 0
page.on("request", r => { if (r.url().includes("/v1/")) inflight++ })
const done = r => { if (r.url().includes("/v1/")) inflight-- }
page.on("requestfinished", done)
page.on("requestfailed", done)
// Wait until no request is in flight and nothing (response, long task) has
// happened for `quietMs`, at least `minMs` after the action (covers the
// fetch debounce). Returns the page time of the last activity.
async function settle(quietMs = 1500, minMs = 1200, maxMs = 60000) {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
        await new Promise(r => setTimeout(r, 100))
        if (inflight > 0 || Date.now() - t0 < minMs) continue
        const [pnow, last] = await page.evaluate(() => {
            const ends = performance.getEntriesByType("resource").filter(e => e.name.includes("/v1/")).map(e => e.responseEnd)
            return [performance.now(), Math.max(0, ...ends, ...window.__lt.map(([s, d]) => s + d))]
        })
        if (pnow - last > quietMs) return last
    }
    throw new Error("settle timeout")
}
async function report(name, t0, tEnd) {
    return page.evaluate(([name, t0, tEnd]) => {
        const cells = performance.getEntriesByType("resource")
            .filter(e => e.name.includes("/v1/cells") && e.startTime >= t0)
            .map(e => {
                const u = new URL(e.name)
                const st = Object.fromEntries((e.serverTiming || []).map(s => [s.name, s.description || Math.round(s.duration)]))
                return {
                    dur: Math.round(e.duration), enc: e.encodedBodySize, dec: e.decodedBodySize,
                    res: u.searchParams.get("res"), years: u.searchParams.get("years"),
                    fmt: u.searchParams.get("format"), group: u.searchParams.get("group"),
                    st,
                }
            })
        const lt = window.__lt.filter(([s]) => s >= t0 && s <= tEnd)
        const fr = window.__frames.filter(([s]) => s >= t0 && s <= tEnd).map(x => x[1]).sort((a, b) => a - b)
        const q = p => fr.length ? Math.round(fr[Math.min(fr.length - 1, Math.floor(p * fr.length))]) : null
        return {
            step: name,
            settleMs: Math.round(tEnd - t0),
            requests: cells.length,
            encBytes: cells.reduce((s, c) => s + c.enc, 0),
            decBytes: cells.reduce((s, c) => s + c.dec, 0),
            cells,
            longTasks: lt.length,
            longTaskMs: Math.round(lt.reduce((s, x) => s + x[1], 0)),
            maxLongTaskMs: Math.round(Math.max(0, ...lt.map(x => x[1]))),
            frames: { n: fr.length, p50: q(0.5), p95: q(0.95), max: q(1), over50: fr.filter(x => x > 50).length },
        }
    }, [name, t0, tEnd])
}
async function step(name, fn) {
    const t0 = await now()
    await fn()
    const tEnd = Math.max(t0, await settle())
    const r = await report(name, t0, tEnd)
    console.log(`${label} ${name.padEnd(12)} ${new URL(page.url()).searchParams.get("y")} settle=${r.settleMs}ms req=${r.requests} enc=${r.encBytes} dec=${r.decBytes} longTasks=${r.longTasks}/${r.longTaskMs}ms(max ${r.maxLongTaskMs}) frames p50/p95/max=${r.frames.p50}/${r.frames.p95}/${r.frames.max} >50ms=${r.frames.over50}`)
    for (const c of r.cells) console.log(`    l${c.res} ${c.years} ${c.fmt ?? "rows"}${c.group ? "/" + c.group : ""} ${c.dur}ms enc=${c.enc} dec=${c.dec} ${JSON.stringify(c.st)}`)
    return r
}
async function drag(dx, dy) {
    const box = await page.locator("#deckgl-overlay").boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 15; i++) await page.mouse.move(x + dx * i / 15, y + dy * i / 15)
    await page.mouse.up()
}
async function zoomIn() {
    const box = await page.locator("#deckgl-overlay").boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(50) }
}
async function setYear(i, v) {
    await page.locator("select").nth(i).selectOption(String(v))
}

const results = []
results.push(await step("load", async () => {
    await page.goto(base + path)
    await page.locator("#deckgl-overlay").waitFor()
}))
results.push({ gl: await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2")
    const d = c?.getExtension("WEBGL_debug_renderer_info")
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"
}) })
console.log(`${label} gl: ${results.at(-1).gl}`)
results.push(await step("pan-left", () => drag(-300, 0)))
results.push(await step("pan-up", () => drag(0, 400)))
results.push(await step("zoom-in", zoomIn))
results.push(await step("year-hi", () => setYear(1, 2016)))
results.push(await step("year-lo", () => setYear(0, 2013)))
results.push(await step("year-back", () => setYear(0, 2011)))
mkdirSync("tmp", { recursive: true })
writeFileSync(`tmp/perf-${label}.json`, JSON.stringify(results, null, 1) + "\n")
await browser.close()

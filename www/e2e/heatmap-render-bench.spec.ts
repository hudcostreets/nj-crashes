/**
 * Heatmap render-strategy comparison (`?hr=` — see
 * `specs/map-heatmap-render-strategies.md`).
 *
 * Loads each strategy across a viewport matrix (statewide / county / city) at
 * desktop + mobile widths and captures, per combo:
 *
 *   - **Bytes fetched** from cells-api + cell count / S2 level — render-
 *     independent; confirms the strategies fetch identical data (B/A change
 *     only *how* cells are drawn, never *what* is fetched).
 *   - **Time-to-first-render** (nav → first cells painted). Legacy's
 *     `HeatmapLayer` builds GPU aggregation textures + its heatmap program on
 *     first paint, so it first-renders slower than B's plain geometry — a real
 *     signal that survives even the software-GL backend below.
 *   - **A screenshot** per combo → the look-comparison matrix (only with
 *     `BENCH_SHOTS=1` + `--headed`; see below).
 *
 * Run:
 *   pnpm test:bench       — numbers only (headless, CI-safe).
 *   pnpm test:bench:viz   — numbers + the screenshot matrix (headed).
 *   Env: HR_STRATEGIES=legacy,b   (comma list; add `a`/`c` as they land)
 *
 * Two backend facts drive the split:
 *   - **Numbers** (bytes/ttfr/cells) come from the network + a `window` hook,
 *     so they're reliable headless.
 *   - **Screenshots** need a real GL context: headless Chromium renders WebGL
 *     through a *software* GL backend that `page.screenshot()` captures as a
 *     blank canvas — so the visual matrix only works `--headed` (real GPU),
 *     which is why it's gated behind `BENCH_SHOTS=1`.
 *   - **No automated FPS:** interaction smoothness is the point of B/A, but
 *     it's GPU-bound (legacy's per-frame KDE re-aggregation runs on the GPU),
 *     so a software-GL frame-rate would neither reproduce the mobile pain nor
 *     distinguish strategies. Smoothness is judged on the screenshots (look)
 *     + a device/CIC pan (feel).
 *
 * Output → `test-results/heatmap-bench.json` (+ PNGs under
 * `test-results/heatmap-bench/` when `BENCH_SHOTS=1`).
 */
import { test } from "@playwright/test"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

test.setTimeout(300_000)

const OUT_DIR = "test-results"
const SHOT_DIR = join(OUT_DIR, "heatmap-bench")

type Viewport = {
    name: string
    /** llz = lat_lon_zoom_pitch_bearing (pitch/bearing optional). All use the
     *  statewide `/map` route — the viewport (not a geo-scoped path) controls
     *  which cells are fetched, which is what we hold constant across
     *  strategies at each zoom. */
    llz: string
}

const VIEWPORTS: Viewport[] = [
    { name: "statewide-z7", llz: "40.20_-74.72_7.71_0_0" },
    { name: "county-z12", llz: "40.71_-74.09_12.0_0_0" },
    { name: "city-z14", llz: "40.7250_-74.0500_14.0_0_0" },
]

const WIDTHS: Array<{ name: string; width: number; height: number }> = [
    { name: "dt", width: 1280, height: 900 },
    { name: "mb", width: 390, height: 780 },
]

const STRATEGIES = (process.env.HR_STRATEGIES ?? "legacy,b").split(",").map(s => s.trim()).filter(Boolean)
/** Screenshots need a real GL context (blank under headless software-GL), so
 *  only capture them when explicitly asked for a headed viz run. */
const SHOTS = process.env.BENCH_SHOTS === "1"

type Result = {
    viewport: string
    width: string
    strategy: string
    cellCount?: number
    resolution?: number
    cellsBytes: number
    cellsRequests: number
    ttfrMs: number
    screenshot?: string
}

test("heatmap render-strategy comparison", async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true })
    if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true })
    const results: Result[] = []

    for (const vp of VIEWPORTS) {
        for (const w of WIDTHS) {
            for (const strategy of STRATEGIES) {
                await page.setViewportSize({ width: w.width, height: w.height })
                const url = `/map?mode=heatmap&hr=${strategy}&perf=1&llz=${vp.llz.replace(/_/g, "+")}`

                let cellsBytes = 0
                let cellsRequests = 0
                const onResp = async (res: any) => {
                    if (!/\/v1\/cells\b/.test(res.url())) return
                    cellsRequests++
                    try { cellsBytes += (await res.body()).length } catch { /* aborted */ }
                }
                page.on("response", onResp)

                const tNav = Date.now()
                await page.goto(url, { waitUntil: "domcontentloaded" })
                await page.waitForSelector("canvas", { state: "attached", timeout: 30_000 })
                await page.waitForFunction(
                    () => ((window as any).__crashMapDebug?.cellCount ?? 0) > 0,
                    { timeout: 30_000 },
                )
                const ttfrMs = Date.now() - tNav
                await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
                await page.waitForTimeout(700)

                const probe = await page.evaluate(() => {
                    const w = window as any
                    return { cellCount: w.__crashMapDebug?.cellCount, resolution: w.__crashMapDebug?.resolution }
                })

                let shot: string | undefined
                if (SHOTS) {
                    shot = join(SHOT_DIR, `${vp.name}-${w.name}-${strategy}.png`)
                    await page.screenshot({ path: shot, fullPage: false })
                }

                page.off("response", onResp)

                results.push({
                    viewport: vp.name,
                    width: w.name,
                    strategy,
                    cellCount: probe.cellCount,
                    resolution: probe.resolution,
                    cellsBytes,
                    cellsRequests,
                    ttfrMs,
                    screenshot: shot,
                })
            }
        }
    }

    writeFileSync(join(OUT_DIR, "heatmap-bench.json"), JSON.stringify(results, null, 2) + "\n")

    const pad = (s: string | number, n: number) => String(s).padEnd(n)
    const padL = (s: string | number, n: number) => String(s).padStart(n)
    console.log("\n=== heatmap render-strategy comparison ===")
    console.log("(smoothness is GPU-bound → not measurable headless; compare look via the PNGs + a device CIC)")
    console.log(
        pad("viewport", 16) + pad("w", 4) + pad("hr", 8) + padL("cells", 7)
        + padL("res", 5) + padL("KB", 9) + padL("reqs", 6) + padL("ttfr", 8),
    )
    let last = ""
    for (const r of results) {
        const grp = `${r.viewport}-${r.width}`
        if (grp !== last && last) console.log("-".repeat(63))
        last = grp
        console.log(
            pad(r.viewport, 16) + pad(r.width, 4) + pad(r.strategy, 8) + padL(r.cellCount ?? "?", 7)
            + padL(r.resolution ?? "?", 5) + padL((r.cellsBytes / 1024).toFixed(0), 9)
            + padL(r.cellsRequests, 6) + padL(r.ttfrMs, 8),
        )
    }
    console.log(`\nJSON → ${OUT_DIR}/heatmap-bench.json${SHOTS ? ` · PNGs → ${SHOT_DIR}/` : " (run test:bench:viz for the screenshot matrix)"}`)
})

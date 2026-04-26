/**
 * Map performance probe.
 *
 * Loads the crash map at several `?v=` viewports that span resolution
 * boundaries, then records:
 *   - All network requests (URL, transferred bytes, timing)
 *   - Console messages from our `console.time/timeEnd` instrumentation
 *   - "Map ready" timestamp (deck.gl onAfterRender exposed on window)
 *   - PNG screenshot per scenario for visual sanity check
 *
 * Output → `test-results/map-perf.json` and `test-results/map-perf-*.png`.
 */
import { test } from '@playwright/test'

test.setTimeout(180_000)
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

type NetEvent = {
    url: string
    method: string
    status?: number
    transferred?: number
    encodedSize?: number
    type: string
    startedAt: number
    finishedAt?: number
    fromCache?: boolean
}

type Scenario = {
    name: string
    /** llz=lat_lon_zoom_pitch_bearing (pitch/bearing optional). */
    llz: string
    /** Optional path under /map (e.g. "" for statewide, "/c/hudson" for county). */
    path?: string
    /** Extra URL query params (no leading `?` or `&`), e.g. `s=fip` to enable PDO. */
    extraQuery?: string
}

const SCENARIOS: Scenario[] = [
    // Statewide hexbin, default severities (f+i): exercises detail-mode
    // raw-row binning + cache + prewarm.
    { name: 'state-zoom7-overview',  llz: '40.20_-74.50_7.5_45_0' },
    { name: 'state-zoom8-southern',  llz: '39.89_-74.90_8.3_45_0' },
    { name: 'state-zoom10-central',  llz: '40.49_-74.43_10.0_45_0' },
    { name: 'state-zoom12-newark',   llz: '40.74_-74.17_12.0_45_0' },
    // PDO included → prebin path (uses r8 hex aggregates server-side).
    { name: 'state-with-pdo',        llz: '40.20_-74.50_8.0_45_0', extraQuery: 's=fip' },
    // Fatal-only (small data set): tests filter post-load + auto-elevation.
    { name: 'state-fatal-only',      llz: '40.20_-74.50_8.0_45_0', extraQuery: 's=f' },
    // County drill-down: bypasses statewide pipeline, fewer rows.
    { name: 'hudson-zoom12',         llz: '40.71_-74.09_12.0_45_0', path: '/c/hudson' },
    { name: 'mercer-zoom11',         llz: '40.27_-74.65_11.0_45_0', path: '/c/mercer' },
    // Muni drill: even fewer rows, finer hex by default.
    { name: 'jersey-city-zoom13',    llz: '40.72_-74.06_13.0_45_0', path: '/c/hudson/jersey-city' },
]

const OUT_DIR = 'test-results'

test('map perf probe', async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true })

    const allReports: any[] = []

    for (const scenario of SCENARIOS) {
        const netEvents: NetEvent[] = []
        const consoleMessages: { type: string; text: string; ts: number }[] = []

        const reqStart = new Map<string, number>()
        const onReq = (req: any) => {
            const url = req.url()
            reqStart.set(url, Date.now())
            netEvents.push({
                url,
                method: req.method(),
                type: req.resourceType(),
                startedAt: Date.now(),
            })
        }
        const onResp = async (resp: any) => {
            const url = resp.url()
            const ev = netEvents.find(e => e.url === url && e.finishedAt === undefined)
            if (!ev) return
            ev.finishedAt = Date.now()
            ev.status = resp.status()
            ev.fromCache = resp.fromServiceWorker() || (resp.headers()['x-from-cache'] === '1')
            try {
                const buf = await resp.body()
                ev.transferred = buf.length
            } catch {
                // Some resources (e.g. failed) can't be read.
            }
            const cl = resp.headers()['content-length']
            if (cl) ev.encodedSize = Number(cl)
        }
        const onConsole = (msg: any) => {
            consoleMessages.push({
                type: msg.type(),
                text: msg.text(),
                ts: Date.now(),
            })
        }

        page.on('request', onReq)
        page.on('response', onResp)
        page.on('console', onConsole)

        const extra = scenario.extraQuery ? `&${scenario.extraQuery}` : ''
        const url = `/map${scenario.path ?? ''}?v=${scenario.llz}&perf=1${extra}#map`
        const tNav = Date.now()
        await page.goto(url, { waitUntil: 'domcontentloaded' })

        // Wait for deck.gl canvas to attach (it may stay hidden behind the
        // Loading... overlay until data binds, so don't require visibility).
        await page.waitForSelector('canvas', { state: 'attached', timeout: 30_000 })

        // Wait for the perf instrumentation flag set by binIntoHexes — that
        // means at least one hex layer was built, i.e. data finished loading
        // and binning ran at least once.
        await page.waitForFunction(
            () => (window as any).__crashMapDebug?.lastBinMs !== undefined,
            { timeout: 30_000 },
        )

        // Network may keep streaming tiles for a while; cap at 5s networkidle.
        try {
            await page.waitForLoadState('networkidle', { timeout: 5_000 })
        } catch {}
        await page.waitForTimeout(300)
        const tStable = Date.now()

        // Capture deck.gl render-counter / hex-count from the page if
        // CrashMap exposes them on window (added in instrumentation step).
        const probe = await page.evaluate(() => {
            const w = window as any
            return {
                hexCount: w.__crashMapDebug?.hexCount,
                resolution: w.__crashMapDebug?.resolution,
                renderCount: w.__crashMapDebug?.renderCount,
                crashCount: w.__crashMapDebug?.crashCount,
            }
        })

        const screenshot = join(OUT_DIR, `map-perf-${scenario.name}.png`)
        await page.screenshot({ path: screenshot, fullPage: false })

        page.off('request', onReq)
        page.off('response', onResp)
        page.off('console', onConsole)

        // Aggregate by parquet vs tile vs other so we can see what's heavy.
        const summary = (() => {
            let parquetBytes = 0, parquetCount = 0
            let tileBytes = 0, tileCount = 0
            let scriptBytes = 0, scriptCount = 0
            let otherBytes = 0, otherCount = 0
            for (const ev of netEvents) {
                const sz = ev.transferred ?? 0
                if (ev.url.includes('.parquet')) {
                    parquetBytes += sz; parquetCount++
                } else if (
                    ev.url.includes('stadiamaps.com')
                    || ev.url.match(/\/tiles?\//)
                    || ev.url.match(/\.png(\?|$)/)
                    || ev.url.match(/\.pbf(\?|$)/)
                ) {
                    tileBytes += sz; tileCount++
                } else if (ev.type === 'script' || ev.type === 'stylesheet' || ev.url.includes('@vite') || ev.url.match(/\.(js|ts|tsx|css)(\?|$)/)) {
                    scriptBytes += sz; scriptCount++
                } else {
                    otherBytes += sz; otherCount++
                }
            }
            return {
                parquetBytes, parquetCount,
                tileBytes, tileCount,
                scriptBytes, scriptCount,
                otherBytes, otherCount,
            }
        })()

        const report = {
            scenario: scenario.name,
            url,
            timing: {
                stableMs: tStable - tNav,
            },
            probe,
            summary,
            netEvents: netEvents.map(e => ({
                ...e,
                durationMs: e.finishedAt && e.startedAt ? e.finishedAt - e.startedAt : undefined,
            })),
            consoleMessages: consoleMessages.filter(m =>
                // Keep all our perf instrumentation + errors/warnings.
                m.text.startsWith('[perf]') ||
                m.type === 'error' ||
                m.type === 'warning'
            ),
            screenshot,
        }
        allReports.push(report)

        const binTimes = consoleMessages
            .filter(m => m.text.includes('[perf] binIntoHexes'))
            .map(m => {
                const match = m.text.match(/(\d+\.\d+)ms/)
                return match ? Number(match[1]) : 0
            })
        const layerTimes = consoleMessages
            .filter(m => m.text.includes('[perf] layers:'))
            .map(m => {
                const match = m.text.match(/(\d+\.\d+)ms/)
                return match ? Number(match[1]) : 0
            })

        console.log(`[${scenario.name}] stable=${report.timing.stableMs}ms · `
            + `parquet=${(summary.parquetBytes / 1024).toFixed(0)}KB×${summary.parquetCount} · `
            + `script=${(summary.scriptBytes / 1024).toFixed(0)}KB×${summary.scriptCount} · `
            + `tiles=${(summary.tileBytes / 1024).toFixed(0)}KB×${summary.tileCount} · `
            + `other=${(summary.otherBytes / 1024).toFixed(0)}KB×${summary.otherCount} · `
            + `bin[ms]=${binTimes.map(t => t.toFixed(0)).join(',')} · `
            + `layer[ms]=${layerTimes.map(t => t.toFixed(0)).join(',')} · `
            + `hexes=${probe.hexCount ?? '?'}@r${probe.resolution ?? '?'}`)
    }

    writeFileSync(join(OUT_DIR, 'map-perf.json'), JSON.stringify(allReports, null, 2))
    console.log(`\nFull report written to ${OUT_DIR}/map-perf.json`)
})

/**
 * Second test: load once, then drive several zoom changes within the same
 * page (no reload). After idle prewarm completes, every subsequent re-bin
 * should be a cache hit (~0ms) regardless of which resolution we land on.
 */
test('map perf interactive zoom', async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true })
    const consoleMessages: { type: string; text: string; ts: number }[] = []
    page.on('console', msg => consoleMessages.push({
        type: msg.type(), text: msg.text(), ts: Date.now(),
    }))

    // Load statewide hexbin at a moderate zoom.
    await page.goto('/map?v=40.50_-74.40_10.0_45_0&perf=1#map', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('canvas', { state: 'attached', timeout: 30_000 })
    await page.waitForFunction(() => (window as any).__crashMapDebug?.lastBinMs !== undefined,
        { timeout: 30_000 })

    // Wait for prewarm to complete so all common resolutions are cached.
    await page.waitForFunction(
        () => consoleMessageCount('[perf] prewarm done') > 0,
        { timeout: 30_000 },
    ).catch(() => {})
    function consoleMessageCount(_substr: string) { return 0 }

    // Wait for prewarm-done log via our captured messages instead.
    const t0 = Date.now()
    while (Date.now() - t0 < 30_000) {
        if (consoleMessages.some(m => m.text.includes('[perf] prewarm done'))) break
        await page.waitForTimeout(200)
    }

    // Snapshot the cache state.
    const beforeBins = consoleMessages
        .filter(m => m.text.includes('[perf] binIntoHexes') && !m.text.includes('coarsenHexes'))
        .length

    // Drive 6 viewport changes via navigation (use-prms updates URL via
    // pushState; CrashMap reads URL → updates viewState → effectiveHexRes
    // recomputes). Only crossing res boundaries triggers re-bin attempts.
    const llzs = [
        '40.50_-74.40_8.0_45_0',   // r6/r7
        '40.50_-74.40_12.0_45_0',  // r8
        '40.50_-74.40_9.0_45_0',   // r7
        '40.50_-74.40_11.0_45_0',  // r8
        '40.50_-74.40_7.0_45_0',   // r5/r6
        '40.50_-74.40_13.0_45_0',  // r9 (or r8 if too fine)
    ]
    for (const llz of llzs) {
        await page.evaluate((l) => {
            const u = new URL(window.location.href)
            u.searchParams.set('v', l)
            window.history.pushState({}, '', u.toString())
            window.dispatchEvent(new PopStateEvent('popstate'))
        }, llz)
        await page.waitForTimeout(400)
    }

    const afterBins = consoleMessages
        .filter(m => m.text.includes('[perf] binIntoHexes') && !m.text.includes('coarsenHexes'))
        .length
    const newBins = afterBins - beforeBins

    const allBinTimes = consoleMessages
        .filter(m => m.text.includes('[perf] binIntoHexes') && !m.text.includes('coarsenHexes'))
        .map(m => Number(m.text.match(/(\d+\.\d+)ms/)?.[1] ?? 0))
    const prewarmTimes = consoleMessages
        .filter(m => m.text.includes('[perf] prewarm r'))
        .map(m => Number(m.text.match(/(\d+\.\d+)ms/)?.[1] ?? 0))
    const cacheHits = consoleMessages.filter(m => m.text.includes('[perf] cache HIT')).length

    console.log(`\n[interactive] initial bins=${beforeBins} prewarm=${prewarmTimes.map(t => t.toFixed(0)).join(',')}ms`)
    console.log(`[interactive] navigations=${llzs.length} new bins=${newBins} cache hits=${cacheHits}`)
    console.log(`[interactive] all bin times: ${allBinTimes.map(t => t.toFixed(0)).join(',')}ms`)

    writeFileSync(join(OUT_DIR, 'map-perf-interactive.json'), JSON.stringify({
        beforeBins, afterBins, newBins, prewarmTimes, allBinTimes, cacheHits,
        consoleMessages: consoleMessages.filter(m => m.text.startsWith('[perf]')),
    }, null, 2))
})

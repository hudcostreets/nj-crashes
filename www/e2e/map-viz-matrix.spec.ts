/** Screenshot matrix for the Crash Map viz.
 *
 * Renders the map across a curated set of `(page, llz, viz)` tuples
 * spanning statewide → county → muni scopes and coarse → deep zoom;
 * dumps one PNG per scenario under `test-results/map-viz/`.
 *
 * Use cases:
 *
 *   1. Manual before/after eval — flip a picker/curve/AUTO_RES change,
 *      run once, `git stash` the change, run again, and diff the PNGs
 *      side-by-side. Way better than CIC-ing one viewport.
 *
 *   2. Golden regression — the naming is stable (`{page}-{zoom}-{viz}.png`)
 *      so a git-diff on `test-results/map-viz/` after a change shows
 *      which viewports moved and how.
 *
 *   3. Companion for `/dev/ab` (once landed) — reuse this scenario list
 *      as the "known interesting viewports" that route iterates over.
 *
 * Run:
 *
 *   pnpm exec playwright test e2e/map-viz-matrix.spec.ts
 *
 * Notes:
 *
 *   - Waits for the deck.gl `mapReady` window signal before shooting.
 *   - Drawer is closed on shoot (`?drawer=0`) so the viz fills the frame.
 *   - Tuples deliberately span the picker's regime crossings (statewide
 *     rasterized-heatmap ↔ mid-zoom discrete-dots ↔ deep-zoom single-cell).
 */
import { test } from "@playwright/test"
import { mkdirSync } from "fs"
import { join } from "path"

test.setTimeout(180_000)

type Scenario = {
    name: string
    path?: string
    llz: string
    viz?: "hex" | "circle"
}

/** Curated viewports spanning the picker's regime crossings. `llz` is
 *  `lat_lon_zoom_pitch_bearing` (pitch/bearing optional). */
const SCENARIOS: Scenario[] = [
    // Statewide — rasterized-heatmap regime (target < 1.5px)
    { name: "state-z07-overview",   llz: "40.20_-74.50_7.5_0_0" },
    { name: "state-z08-southern",   llz: "39.89_-74.90_8.3_0_0" },

    // Regional — coarsest-fit kicks in (target > 1.5px, coarser cells)
    { name: "state-z10-central",    llz: "40.49_-74.43_10.0_0_0" },
    { name: "state-z10-bergen",     llz: "40.79_-74.06_10.94_17_10" },
    { name: "state-z11-newark",     llz: "40.74_-74.17_11.5_0_0" },

    // County drill — mid zoom, muni-shape context
    { name: "hudson-z12",           path: "/c/hudson",       llz: "40.71_-74.09_12.0_0_0" },
    { name: "mercer-z11",           path: "/c/mercer",       llz: "40.27_-74.65_11.0_0_0" },

    // Muni drill — deep zoom, discrete dots per cell
    { name: "jersey-city-z13",      path: "/jersey-city",    llz: "40.72_-74.06_13.0_0_0" },
    { name: "jersey-city-z14",      path: "/jersey-city",    llz: "40.7251_-74.0467_13.81_17_-4" },
    { name: "union-city-z15",       path: "/union-city",     llz: "40.7691_-74.0331_15.00_26_3" },

    // Deep-zoom regime — dots hoverable-sized
    { name: "downtown-jc-z17",      llz: "40.7262_-74.0524_16.91_17_-4" },
    { name: "raritan-circle-z18",   llz: "40.5757_-74.6293_17.20_31_-1" },
    { name: "somerville-circle-z20", llz: "40.5755_-74.6294_20.00_31_-1" },
]

const OUT_DIR = "test-results/map-viz"
mkdirSync(OUT_DIR, { recursive: true })

/** Each scenario shot twice — once in hex mode, once in circle. Filename
 *  encodes `{name}-{viz}.png` so before/after PNG diffs align by tuple. */
for (const sc of SCENARIOS) {
    for (const viz of ["hex", "circle"] as const) {
        test(`${sc.name} — ${viz}`, async ({ page }) => {
            const path = sc.path ?? ""
            const url = `/${path.replace(/^\/+/, "")}?llz=${sc.llz.replace(/_/g, "+")}&viz=${viz}`

            const requests: Array<{ url: string; bytes: number }> = []
            page.on("response", async (res) => {
                if (!res.url().includes("cells-api")) return
                try {
                    const body = await res.body()
                    requests.push({ url: res.url(), bytes: body.length })
                } catch { /* aborted; ignore */ }
            })

            await page.goto(url)
            // Wait for the cells-api settle. No dedicated `mapReady` signal
            // today (see map-perf.spec.ts for a planned probe); rely on:
            //   1. `networkidle` (nothing in-flight for 500 ms)
            //   2. a small settle for the deck.gl paint after last fetch
            try { await page.waitForLoadState("networkidle", { timeout: 15_000 }) } catch { /* fall through */ }
            await page.waitForTimeout(2000)

            const png = join(OUT_DIR, `${sc.name}-${viz}.png`)
            await page.screenshot({ path: png, fullPage: false })

            const totalBytes = requests.reduce((s, r) => s + r.bytes, 0)
            // eslint-disable-next-line no-console
            console.log(
                `[${sc.name}] viz=${viz}: ${requests.length} cells-api reqs, `
                + `${(totalBytes / 1024).toFixed(1)} KB total, `
                + `→ ${png}`,
            )
        })
    }
}

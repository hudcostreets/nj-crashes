/** Sweep the bins-per-viewport budget across the scrns matrix.
 *
 *  Renders the map at each `(scenario, budget, viz)` cell, dumps PNGs
 *  under `test-results/map-budget/` and logs cells-api byte totals so
 *  we can pick a budget from evidence (spec: `specs/autores-bins-budget.md`).
 *
 *  Naming: `{scenario}-b{budget}-{viz}.png` — grouping by scenario
 *  makes it easy to eyeball "at this viewport, does dropping the
 *  budget hurt visual density?"
 *
 *  Run:
 *    pnpm exec playwright test e2e/map-budget-sweep.spec.ts
 */
import { test } from "@playwright/test"
import { mkdirSync } from "fs"
import { join } from "path"

test.setTimeout(300_000)

type Scenario = {
    name: string
    path?: string
    llz: string
}

/** Same curated set as `map-viz-matrix.spec.ts`, spanning the picker's
 *  regime crossings. Kept in sync manually — a shared module could
 *  factor these but the duplication is 20 lines and low churn. */
const SCENARIOS: Scenario[] = [
    { name: "state-z07-overview", llz: "40.20_-74.50_7.5_0_0" },
    { name: "state-z08-southern", llz: "39.89_-74.90_8.3_0_0" },
    { name: "state-z10-central",  llz: "40.49_-74.43_10.0_0_0" },
    { name: "state-z10-bergen",   llz: "40.79_-74.06_10.94_17_10" },
    { name: "state-z11-newark",   llz: "40.74_-74.17_11.5_0_0" },
    { name: "hudson-z12",         path: "/c/hudson",    llz: "40.71_-74.09_12.0_0_0" },
    { name: "jersey-city-z13",    path: "/jersey-city", llz: "40.72_-74.06_13.0_0_0" },
    { name: "downtown-jc-z17",    llz: "40.7262_-74.0524_16.91_17_-4" },
]

/** Budget sweep. The current module default is 100k; the sweep bounds
 *  cover roughly ½× → 2× so we can see where density degrades vs where
 *  IO stops shrinking. */
const BUDGETS = [50_000, 100_000, 150_000, 200_000]

const OUT_DIR = "test-results/map-budget"
mkdirSync(OUT_DIR, { recursive: true })

for (const sc of SCENARIOS) {
    for (const budget of BUDGETS) {
        // Only circle mode — it's the current default viz, and the picker
        // itself doesn't distinguish hex vs circle any more (rendering-only
        // swap). Cuts test wall-clock in half.
        const viz = "circle"
        test(`${sc.name} — b${budget / 1000}k — ${viz}`, async ({ page }) => {
            const path = sc.path ?? ""
            const url = `/${path.replace(/^\/+/, "")}?llz=${sc.llz.replace(/_/g, "+")}&viz=${viz}&bins=${budget}`

            const requests: Array<{ url: string; bytes: number; ms: number }> = []
            const startTimes = new Map<string, number>()
            page.on("request", (req) => {
                if (req.url().includes("cells-api")) startTimes.set(req.url(), Date.now())
            })
            page.on("response", async (res) => {
                if (!res.url().includes("cells-api")) return
                const started = startTimes.get(res.url()) ?? Date.now()
                try {
                    const body = await res.body()
                    requests.push({ url: res.url(), bytes: body.length, ms: Date.now() - started })
                } catch { /* aborted; ignore */ }
            })

            await page.goto(url)
            try { await page.waitForLoadState("networkidle", { timeout: 20_000 }) } catch { /* fall through */ }
            await page.waitForTimeout(2000)

            const png = join(OUT_DIR, `${sc.name}-b${budget / 1000}k-${viz}.png`)
            await page.screenshot({ path: png, fullPage: false })

            const totalBytes = requests.reduce((s, r) => s + r.bytes, 0)
            const maxMs = requests.reduce((m, r) => Math.max(m, r.ms), 0)
            // Extract res from the first cells-api URL — all should agree
            // (client fires one res per viewport).
            const resMatch = requests[0]?.url.match(/[?&]res=(\d+)/)
            const res = resMatch ? Number(resMatch[1]) : null
            // eslint-disable-next-line no-console
            console.log(
                `[sweep] ${sc.name} b=${budget / 1000}k → r${res ?? "?"} · `
                + `${requests.length} reqs · ${(totalBytes / 1024).toFixed(0)} KB · `
                + `${maxMs} ms max · ${png}`,
            )
        })
    }
}

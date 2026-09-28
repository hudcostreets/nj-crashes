/** Heatmap regression guard: every heatmap render must actually paint.
 *
 * A blank heatmap is silent — the cell requests 200, the layer runs, no page error. The dark
 * basemap is neutral gray (R ≈ B), and every crash color (heatmap ramps, Points dots) is warm
 * (R ≫ B), so the fraction of warm pixels in a screenshot measures what the crash layer drew.
 * Measured (Jersey City, z14.5, all years, 1280×800): blank heatmap 0.0003 (the legend swatches
 * only), painted legacy ≈0.025, C ≈0.03; Points ≫ that.
 *
 * Covers the default render (C, tiled baked KDE), legacy, a heatmap created with its data already
 * present (page load) and one created by a mode switch after the cells are loaded (Points →
 * Heatmap).
 *
 * No lattice ("griddy" legacy) check here: pixel metrics tried on the Round 3 screenshots
 * (isolated warm blocks, local-maxima density) didn't separate the 10 px-cell lattice from the
 * fixed render or from genuinely sparse street-level data. The cause (the legacy cell floor) is
 * pinned in `picker.test.ts` instead.
 *
 * Needs network access to the cells API (`VITE_CELLS_API_BASE`; the dev worker works from
 * `localhost`). Run against a production build (what `deploy-worker.sh` ships):
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:<preview port> pnpm exec playwright test e2e/heatmap-paints.spec.ts
 */
import { test, expect, type Page } from "@playwright/test"

// Headless shell has no WebGL by default.
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } })

const LLZ = "40.7213-74.0810+14.5+0+0"  // Jersey City / Lincoln Park: dense crashes

/** 15× the blank-map level, ~⅕ of a painted heatmap's. */
const MIN_WARM = 0.005

const VIEWPORTS = {
    desktop: { width: 1280, height: 800 },
    phone: { width: 390, height: 844 },
} as const

type Pixels = { data: number[]; width: number; height: number }

/** The page's pixels, RGBA. */
async function pixels(page: Page): Promise<Pixels> {
    const png = await page.screenshot()
    return page.evaluate(async b64 => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext("2d")!
        ctx.drawImage(img, 0, 0)
        const { data } = ctx.getImageData(0, 0, c.width, c.height)
        return { data: Array.from(data), width: c.width, height: c.height }
    }, png.toString("base64"))
}

/** Fraction of pixels that are warm (R − B > 60). */
function warmFraction({ data }: Pixels): number {
    let warm = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] - data[i + 2] > 60) warm++
    return warm / (data.length / 4)
}

async function expectPainted(page: Page) {
    await expect(async () => {
        expect(warmFraction(await pixels(page))).toBeGreaterThanOrEqual(MIN_WARM)
    }).toPass({ timeout: 30_000, intervals: [1000] })
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem("nj-crashes-theme", "dark") })
})

for (const hr of [null, "legacy"]) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
        for (const years of [null, "2011-2013"]) {
            test(`heatmap paints: ${hr ?? "default (C)"} ${vpName} ${years ?? "all years"}`, async ({ page }) => {
                test.setTimeout(60_000)
                await page.setViewportSize(viewport)
                await page.goto(`/map?llz=${LLZ}&mode=heatmap${hr ? `&hr=${hr}` : ""}${years ? `&y=${years}` : ""}`)
                await page.locator(".maplibregl-canvas").waitFor({ state: "attached" })
                await expectPainted(page)
            })
        }
    }
}

test("points paint (control)", async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(VIEWPORTS.desktop)
    await page.goto(`/map?llz=${LLZ}&mode=scatter`)
    await page.locator(".maplibregl-canvas").waitFor({ state: "attached" })
    await expectPainted(page)
})

test("heatmap paints after switching from Points", async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(VIEWPORTS.desktop)
    await page.goto(`/map?llz=${LLZ}&mode=scatter`)
    await page.locator(".maplibregl-canvas").waitFor({ state: "attached" })
    await expectPainted(page)
    await page.getByRole("button", { name: "Heatmap", exact: true }).click()
    await expect(page).toHaveURL(/mode=heatmap/)
    // Let the Points layer go away before measuring (its dots are warm too).
    await page.waitForTimeout(3000)
    await expectPainted(page)
})

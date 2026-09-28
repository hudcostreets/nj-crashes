/** Basemap regression guard: the Stadia raster tiles must actually paint under the deck.gl layers.
 *
 * A missing basemap is silent — tiles can 200 (or 401) with no page error, leaving a flat page
 * background under the crash points. So: hide the deck.gl overlay canvas, screenshot a patch of
 * the map, and require real texture there (a blank map is one uniform color).
 *
 * Needs a host Stadia authorizes (`localhost` is; the default `webServer` qualifies) and network
 * access to `tiles.stadiamaps.com` + the cells API.
 *
 *   pnpm exec playwright test e2e/basemap.spec.ts
 */
import { test, expect, type Page } from "@playwright/test"

// Headless shell has no WebGL by default (MapLibre then never creates its canvas).
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } })

const LLZ ="40.7213-74.0810+14.5+0+0"  // Jersey City / Lincoln Park: dense streets + labels

/** Measured (160px patch, z14.5 Jersey City): blank map 1 color / std 0; painted Stadia
 *  `alidade_smooth_dark` ≈530 / 10, `alidade_smooth` ≈700 / 11. */
const MIN_COLORS = 20
const MIN_LUMA_STD = 2

const VIEWPORTS = {
    desktop: { width: 1280, height: 800 },
    phone: { width: 390, height: 844 },
} as const

async function setTheme(page: Page, theme: "light" | "dark") {
    await page.addInitScript(t => { localStorage.setItem("nj-crashes-theme", t) }, theme)
}

/** Distinct-color count + luminance std-dev of a centred patch of the map, deck.gl overlay hidden. */
async function basemapTexture(page: Page): Promise<{ colors: number; lumaStd: number }> {
    await page.locator("#deckgl-overlay").evaluate(el => { (el as HTMLElement).style.visibility = "hidden" })
    const vp = page.viewportSize()!
    const size = 160
    const png = await page.screenshot({
        clip: { x: vp.width / 2 - size / 2, y: vp.height / 2 - size / 2, width: size, height: size },
    })
    await page.locator("#deckgl-overlay").evaluate(el => { (el as HTMLElement).style.visibility = "" })
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
        const colors = new Set<number>()
        let sum = 0, sum2 = 0
        const n = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
            colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
            const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
            sum += l
            sum2 += l * l
        }
        const mean = sum / n
        return { colors: colors.size, lumaStd: Math.sqrt(sum2 / n - mean * mean) }
    }, png.toString("base64"))
}

for (const theme of ["dark", "light"] as const) {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
        for (const mode of ["scatter", "heatmap", "bins"] as const) {
            test(`basemap paints: ${theme} ${vpName} ${mode}`, async ({ page }) => {
                test.setTimeout(60_000)
                await page.setViewportSize(viewport)
                await setTheme(page, theme)
                await page.goto(`/map?llz=${LLZ}&mode=${mode}&y=2011-2013`)
                await page.locator(".maplibregl-canvas").waitFor()
                await expect(async () => {
                    const { colors, lumaStd } = await basemapTexture(page)
                    expect(colors).toBeGreaterThanOrEqual(MIN_COLORS)
                    expect(lumaStd).toBeGreaterThanOrEqual(MIN_LUMA_STD)
                }).toPass({ timeout: 30_000, intervals: [1000] })
                await expect(page.getByRole("status").filter({ hasText: "Basemap unavailable" })).toHaveCount(0)
            })
        }
    }
}

test("refused basemap tiles surface a notice instead of a silent blank map", async ({ page }) => {
    await page.route("https://tiles.stadiamaps.com/**", route => route.fulfill({ status: 401, body: "" }))
    await page.goto(`/map?llz=${LLZ}&mode=scatter&y=2011-2013`)
    await expect(page.getByRole("status").filter({ hasText: "Basemap unavailable" }))
        .toHaveText("Basemap unavailable: tile server refused this site (401)", { timeout: 20_000 })
})

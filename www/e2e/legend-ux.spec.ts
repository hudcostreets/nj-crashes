import { test, expect, Page, Locator } from '@playwright/test'

/**
 * Legend-interaction tests. The homepage has two legend implementations:
 *  - Plotly's native SVG legend (`.legend .traces`) — YtdDeathsPlot,
 *    FatalitiesByMonthBarsPlot, CrashPlot.
 *  - `pltly`'s custom HTML legend (`.pltly-legend-item`) — FatalitiesPerYearPlot,
 *    HomicidesComparisonPlot. Pinned item → `font-weight: 600`; non-active
 *    items → `opacity: 0.3` while another is hovered/pinned.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Wait for all Plotly plots to render (no "Loading..." fallbacks remain). */
async function waitForPlots(page: Page, { count, timeout = 15_000 }: { count?: number, timeout?: number } = {}) {
  await page.locator('.js-plotly-plot').first().waitFor({ timeout })
  if (count !== undefined) {
    await expect(page.locator('.js-plotly-plot')).toHaveCount(count, { timeout })
  }
}

/** Plotly native-SVG-legend items / texts for a given plot. */
const legendItems = (plot: Locator): Locator => plot.locator('.legend .traces')
const legendTexts = (plot: Locator): Locator => plot.locator('.legend .traces .legendtext')

/** `pltly` custom-HTML-legend items, scoped to a plot section by its `<h2 id>`. */
const customLegendItems = (page: Page, sectionId: string): Locator =>
  page.locator(`div:has(> h2[id="${sectionId}"]) .pltly-legend-item`)

/** Numeric font-weight of an element (`normal` → 400). */
async function fontWeight(el: Locator): Promise<number> {
  const raw = await el.evaluate(e => (e as HTMLElement).style.fontWeight || getComputedStyle(e).fontWeight)
  return raw === 'normal' ? 400 : raw === 'bold' ? 700 : parseInt(raw) || 400
}

/** Numeric opacity of an element. */
async function opacity(el: Locator): Promise<number> {
  return el.evaluate(e => parseFloat(getComputedStyle(e).opacity))
}

function isBold(weight: number): boolean {
  return weight >= 600
}

/** Count visible (not legendonly) traces in a plot. */
async function visibleTraceCount(plot: Locator): Promise<number> {
  return plot.evaluate(el => {
    const gd = el as any
    if (!gd.data) return 0
    return gd.data.filter((t: any) => t.visible !== 'legendonly' && t.visible !== false).length
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────

test.describe('Plot rendering', () => {
  test('all plots render without stuck Loading state', async ({ page }) => {
    await page.goto('/')
    await waitForPlots(page, { count: 5 })
    await expect(page.locator('.js-plotly-plot >> text=Loading...')).toHaveCount(0)
  })
})

test.describe('Custom legend (Homicides)', () => {
  test('hovering an item fades the others, unhover restores', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const items = customLegendItems(page, 'vs-homicides')
    await expect(items).toHaveCount(3)

    await items.first().hover()
    await expect(async () => {
      expect(await opacity(items.nth(1))).toBe(0.3)
      expect(await opacity(items.nth(2))).toBe(0.3)
    }).toPass({ timeout: 5000 })

    await page.mouse.move(0, 0)
    await expect(async () => {
      expect(await opacity(items.nth(1))).toBe(1)
      expect(await opacity(items.nth(2))).toBe(1)
    }).toPass({ timeout: 5000 })
  })

  test('clicking an item pins it (bold), persists after unhover', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const items = customLegendItems(page, 'vs-homicides')

    await items.nth(1).click()
    await expect(async () => {
      expect(isBold(await fontWeight(items.nth(1)))).toBe(true)
    }).toPass({ timeout: 5000 })

    // Move away — pinned bold persists (it's a pin, not a hover).
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    expect(isBold(await fontWeight(items.nth(1)))).toBe(true)
  })

  test('re-clicking the pinned item unpins it', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const items = customLegendItems(page, 'vs-homicides')
    const homicides = items.nth(1)
    // Fire the click via the DOM directly: a real Playwright `.click()` after a
    // prior pin intermittently fails to register the toggle (the pointer never
    // leaves the item between clicks). `el.click()` exercises the same React
    // `onClick` → `useLegendPin` toggle deterministically.
    const click = () => homicides.evaluate(el => (el as HTMLElement).click())

    await click()  // pin
    await expect(async () => {
      expect(isBold(await fontWeight(homicides))).toBe(true)
    }).toPass({ timeout: 5000 })

    await click()  // re-click → unpin
    await expect(async () => {
      expect(isBold(await fontWeight(homicides))).toBe(false)
    }).toPass({ timeout: 5000 })
  })

  test('clicking the plot background unpins', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const items = customLegendItems(page, 'vs-homicides')
    const plot = page.locator('.js-plotly-plot').nth(2)

    await items.nth(1).click()
    await expect(async () => {
      expect(isBold(await fontWeight(items.nth(1)))).toBe(true)
    }).toPass({ timeout: 5000 })

    const box = await plot.boundingBox()
    await page.mouse.click(box!.x + box!.width - 20, box!.y + 20)  // empty corner
    await page.mouse.move(0, 0)
    await expect(async () => {
      expect(isBold(await fontWeight(items.nth(1)))).toBe(false)
    }).toPass({ timeout: 5000 })
  })

  test('pinning an item does not hide any plot traces', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const items = customLegendItems(page, 'vs-homicides')
    const plot = page.locator('.js-plotly-plot').nth(2)

    const visBefore = await plot.evaluate(el => (el as any).data.map((t: any) => t.visible ?? true))
    await items.nth(1).click()
    await page.waitForTimeout(300)
    const visAfter = await plot.evaluate(el => (el as any).data.map((t: any) => t.visible ?? true))
    expect(visAfter).toEqual(visBefore)
  })
})

test.describe('CrashPlot solo mode', () => {
  test('hover LI solos trace (hides others)', async ({ page }) => {
    await page.goto('/#njdot')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(4)
    const items = legendItems(plot)
    if (await items.count() < 2) return  // skip if only one trace

    const allVisible = await visibleTraceCount(plot)
    expect(allVisible).toBeGreaterThan(1)

    await items.first().hover()
    await page.waitForTimeout(500)
    expect(await visibleTraceCount(plot)).toBeLessThan(allVisible)

    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    expect(await visibleTraceCount(plot)).toBe(allVisible)
  })
})

test.describe('YTD legend', () => {
  test('hovering a legend item thickens its trace line', async ({ page }) => {
    await page.goto('/#ytd')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(1)
    const items = legendItems(plot)
    const count = await items.count()
    if (count < 2) return

    // The legend auto-scrolls to the bottom (current year), so `nth(count-2)`
    // is a visible, non-current-year item. YtdDeathsPlot highlights via a
    // thicker trace line (`activeStyle` → `line.width` 5), not bold legend text.
    const idx = count - 2
    const name = (await legendTexts(plot).nth(idx).textContent())?.trim()
    const lineWidth = () => plot.evaluate(
      (el, n) => ((el as any).data.find((t: any) => t.name === n)?.line?.width) as number | undefined,
      name,
    )

    expect(await lineWidth()).toBe(2)
    await items.nth(idx).hover()
    await expect.poll(lineWidth).toBe(5)

    await page.mouse.move(0, 0)
    await expect.poll(lineWidth).toBe(2)
  })
})

test.describe('FBM pin', () => {
  test('click LI pins year trace', async ({ page }) => {
    await page.goto('/#by-month-bars')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(3)
    const items = legendItems(plot)
    const texts = legendTexts(plot)
    if (await items.count() < 2) return

    await items.first().click()
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    await items.first().dblclick()  // unpin
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(false)
  })
})

test.describe('Tooltip order', () => {
  test('Plot1 unified hover shows top-of-stack first', async ({ page }) => {
    await page.goto('/')
    await waitForPlots(page, { count: 5 })
    const traceorder = await page.evaluate(() => {
      const gd = document.querySelector('.js-plotly-plot') as any
      return gd?._fullLayout?.legend?.traceorder ?? 'not set'
    })
    expect(traceorder).toContain('reversed')
  })

  test('CrashPlot tooltip order matches stack (top-first)', async ({ page }) => {
    await page.goto('/#njdot')
    const plot = page.locator('.js-plotly-plot').nth(4)
    await plot.waitFor({ timeout: 15000 })
    await page.waitForTimeout(2000)
    await plot.scrollIntoViewIfNeeded()
    const box = await plot.boundingBox()

    // The x-unified tooltip lists traces top-of-stack first — the reverse of
    // `gd.data`'s bottom-up order. Asserting against the live stack keeps this
    // robust to severity-label changes; the `toPass` retries the hover, which
    // can land between bars on the first sweep.
    await expect(async () => {
      await page.mouse.move(box!.x + 50, box!.y + box!.height / 2, { steps: 3 })
      await page.waitForTimeout(200)
      await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height / 2, { steps: 10 })
      await page.waitForTimeout(600)
      const stackOrder = await plot.evaluate(el => (el as any).data.map((t: any) => t.name))
      const tip = await plot.locator('.hoverlayer .legend .traces .legendtext').allTextContents()
      const tipTypes = tip.map(n => n.split(':')[0].trim())
      expect(tipTypes).toEqual([...stackOrder].reverse())
    }).toPass({ timeout: 15000 })
  })
})

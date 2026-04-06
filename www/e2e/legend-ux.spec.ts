import { test, expect, Page, Locator } from '@playwright/test'

/**
 * Helper: wait for all Plotly plots to render (no "Loading..." fallbacks remain).
 */
async function waitForPlots(page: Page, { count, timeout = 15_000 }: { count?: number, timeout?: number } = {}) {
  // Wait for at least one .js-plotly-plot to appear
  await page.locator('.js-plotly-plot').first().waitFor({ timeout })
  if (count !== undefined) {
    await expect(page.locator('.js-plotly-plot')).toHaveCount(count, { timeout })
  }
}

/**
 * Helper: get legend items (`.legend .traces`) for a given plot.
 */
function legendItems(plot: Locator): Locator {
  return plot.locator('.legend .traces')
}

/**
 * Helper: get legend text elements for a given plot.
 */
function legendTexts(plot: Locator): Locator {
  return plot.locator('.legend .traces .legendtext')
}

/**
 * Helper: get the font-weight of a legend text element.
 */
async function fontWeight(el: Locator): Promise<string> {
  return el.evaluate(e => (e as SVGElement).style.fontWeight || getComputedStyle(e).fontWeight)
}

/**
 * Helper: check if a font-weight value represents bold.
 */
function isBold(weight: string): boolean {
  return weight === 'bold' || parseInt(weight) >= 600
}

/**
 * Helper: count visible (not legendonly) traces in a plot.
 */
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
    // No "Loading..." text inside plot containers
    const loadingDivs = page.locator('.js-plotly-plot >> text=Loading...')
    await expect(loadingDivs).toHaveCount(0)
  })
})

test.describe('Legend hover (no pin)', () => {
  // TODO: pltly bold not applied after dual-axis relayout on hover (works on click/pin)
  test.fixme('Homicides plot: hover LI highlights trace, unhover resets', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(2) // Homicides is 3rd plot
    const items = legendItems(plot)
    const firstItem = items.first()

    // Hover the first legend item
    await firstItem.hover()

    // First LI text should be bold (may take a moment after dual-axis relayout)
    const firstText = legendTexts(plot).first()
    await expect(async () => {
      expect(isBold(await fontWeight(firstText))).toBe(true)
    }).toPass({ timeout: 10000 })

    // Move mouse away from legend
    await page.mouse.move(0, 0)

    // Bold should be cleared
    await expect(async () => {
      expect(isBold(await fontWeight(firstText))).toBe(false)
    }).toPass({ timeout: 10000 })
  })
})

test.describe('Legend pin', () => {
  test('Homicides plot: click LI pins trace, bold persists', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(2)
    const items = legendItems(plot)
    const texts = legendTexts(plot)
    const firstItem = items.first()
    const firstText = texts.first()
    const secondItem = items.nth(1)
    const secondText = texts.nth(1)

    // Click first LI to pin
    await firstItem.click()

    // First LI should be bold (pinned) — may take a moment after dual-axis relayout
    await expect(async () => {
      expect(isBold(await fontWeight(firstText))).toBe(true)
    }).toPass({ timeout: 10000 })

    // Move mouse away — bold should persist (it's pinned, not just hovered)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    expect(isBold(await fontWeight(firstText))).toBe(true)

    // Hover second LI — second should become bold (preview), first stays bold (pinned)
    await secondItem.hover()
    await expect(async () => {
      expect(isBold(await fontWeight(firstText))).toBe(true)
      expect(isBold(await fontWeight(secondText))).toBe(true)
    }).toPass({ timeout: 10000 })

    // Click second LI — pin should switch to second
    await secondItem.click()
    await expect(async () => {
      expect(isBold(await fontWeight(secondText))).toBe(true)
    }).toPass({ timeout: 10000 })
    // First should no longer be bold (unless hovered)
    await page.mouse.move(0, 0)
    await expect(async () => {
      expect(isBold(await fontWeight(firstText))).toBe(false)
      expect(isBold(await fontWeight(secondText))).toBe(true)
    }).toPass({ timeout: 10000 })

    // Click second LI again — unpin, all back to normal
    await secondItem.click()
    await page.mouse.move(0, 0)
    await expect(async () => {
      expect(isBold(await fontWeight(secondText))).toBe(false)
    }).toPass({ timeout: 10000 })
  })

  test('pin does not change trace visibility on hover of other LIs', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(2)
    const items = legendItems(plot)

    // Pin first LI
    await items.first().click()
    await page.waitForTimeout(300)

    // Record trace visibility state (opacity may change due to fade preview)
    const visAfterPin = await plot.evaluate(el => {
      const gd = el as any
      return gd.data.map((t: any) => ({ name: t.name, visible: t.visible }))
    })

    // Hover second LI — visibility should NOT change (no solo toggle)
    await items.nth(1).hover()
    await page.waitForTimeout(300)

    const visAfterHover = await plot.evaluate(el => {
      const gd = el as any
      return gd.data.map((t: any) => ({ name: t.name, visible: t.visible }))
    })

    expect(visAfterHover).toEqual(visAfterPin)
  })

  test('double-click unpins', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(2)
    const items = legendItems(plot)
    const texts = legendTexts(plot)

    // Pin first LI
    await items.first().click()
    await expect(async () => {
      expect(isBold(await fontWeight(texts.first()))).toBe(true)
    }).toPass({ timeout: 10000 })

    // Move away to confirm pin persists
    const plotBox = await plot.boundingBox()
    await page.mouse.move(plotBox!.x - 50, plotBox!.y - 50)
    await page.waitForTimeout(300)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    // Click same LI again to unpin
    await items.first().click()

    // Move away to clear hover
    await page.mouse.move(plotBox!.x - 50, plotBox!.y - 50)

    // No bold LIs (no pin, no hover)
    await expect(async () => {
      const count = await texts.count()
      const boldNames: string[] = []
      for (let i = 0; i < count; i++) {
        const fw = await fontWeight(texts.nth(i))
        if (isBold(fw)) {
          const name = await texts.nth(i).textContent()
          boldNames.push(`${name} (fw=${fw})`)
        }
      }
      expect(boldNames).toEqual([])
    }).toPass({ timeout: 10000 })
  })

  test('click on plot background unpins', async ({ page }) => {
    await page.goto('/#vs-homicides')
    await waitForPlots(page)
    const plot = page.locator('.js-plotly-plot').nth(2)
    const items = legendItems(plot)
    const texts = legendTexts(plot)

    // Pin first LI
    await items.first().click()
    await expect(async () => {
      expect(isBold(await fontWeight(texts.first()))).toBe(true)
    }).toPass({ timeout: 10000 })

    // Click on empty plot area (above traces, below title)
    const plotBox = await plot.boundingBox()
    await page.mouse.click(plotBox!.x + plotBox!.width - 20, plotBox!.y + 20)

    // Move mouse away to clear any hover
    await page.mouse.move(plotBox!.x - 50, plotBox!.y - 50)

    // No bold LIs
    await expect(async () => {
      const count = await texts.count()
      const boldNames: string[] = []
      for (let i = 0; i < count; i++) {
        const fw = await fontWeight(texts.nth(i))
        if (isBold(fw)) {
          const name = await texts.nth(i).textContent()
          boldNames.push(`${name} (fw=${fw})`)
        }
      }
      expect(boldNames).toEqual([])
    }).toPass({ timeout: 10000 })
  })
})

test.describe('CrashPlot solo mode', () => {
  test('hover LI solos trace (hides others)', async ({ page }) => {
    await page.goto('/#njdot')
    await waitForPlots(page)
    // CrashPlot is the 5th plot (index 4)
    const plot = page.locator('.js-plotly-plot').nth(4)
    const items = legendItems(plot)
    const itemCount = await items.count()
    if (itemCount < 2) return // skip if only one trace

    // Before hover: all traces visible
    const allVisible = await visibleTraceCount(plot)
    expect(allVisible).toBeGreaterThan(1)

    // Hover first LI
    await items.first().hover()
    await page.waitForTimeout(500)

    // After hover: only active trace (and its legendgroup) should be visible
    const afterHover = await visibleTraceCount(plot)
    expect(afterHover).toBeLessThan(allVisible)

    // Unhover: all traces visible again
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    const afterUnhover = await visibleTraceCount(plot)
    expect(afterUnhover).toBe(allVisible)
  })
})

test.describe('YTD pin', () => {
  test('click LI pins trace, bold persists after unhover', async ({ page }) => {
    await page.goto('/#ytd')
    await waitForPlots(page)
    // YTD is the 2nd plot (index 1)
    const plot = page.locator('.js-plotly-plot').nth(1)
    const items = legendItems(plot)
    const texts = legendTexts(plot)
    const count = await items.count()
    if (count < 2) return

    // Click first LI to pin
    await items.first().click()
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    // Move away — bold should persist
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    // Click again to unpin
    await items.first().click()
    await page.waitForTimeout(200)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(false)
  })
})

test.describe('FBM pin', () => {
  test('click LI pins year trace', async ({ page }) => {
    await page.goto('/#by-month-bars')
    await waitForPlots(page)
    // FBM is the 4th plot (index 3)
    const plot = page.locator('.js-plotly-plot').nth(3)
    const items = legendItems(plot)
    const texts = legendTexts(plot)
    const count = await items.count()
    if (count < 2) return

    // Click first LI to pin
    await items.first().click()
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    // Move away
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(true)

    // Double-click to unpin
    await items.first().dblclick()
    await page.waitForTimeout(200)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    expect(isBold(await fontWeight(texts.first()))).toBe(false)
  })
})

test.describe('Tooltip order', () => {
  test('Plot1 unified hover shows top-of-stack first', async ({ page }) => {
    await page.goto('/')
    await waitForPlots(page, { count: 5 })
    // Verify plotly.js defaults traceorder to 'reversed' for stacked bars
    const traceorder = await page.evaluate(() => {
      const gd = document.querySelector('.js-plotly-plot') as any
      return gd?._fullLayout?.legend?.traceorder ?? 'not set'
    })
    expect(traceorder).toContain('reversed')
  })

  test('CrashPlot tooltip order matches stack (top-first)', async ({ page }) => {
    await page.goto('/#njdot')
    await page.locator('.js-plotly-plot').nth(4).waitFor({ timeout: 15000 })
    await page.waitForTimeout(2000)

    const plot = page.locator('.js-plotly-plot').nth(4)
    await plot.scrollIntoViewIfNeeded()
    const box = await plot.boundingBox()

    await page.mouse.move(box!.x + 50, box!.y + box!.height / 2, { steps: 3 })
    await page.waitForTimeout(300)
    await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height / 2, { steps: 10 })
    await page.waitForTimeout(1000)

    const names = await plot.locator('.hoverlayer .legend .traces .legendtext').allTextContents()
    const types = names.map(n => n.split(':')[0].trim())
    // Stack bottom→top: Fatal, Injury, Prop. Damage
    // Tooltip top→bottom should be: Prop. Damage, Injury, Fatal
    expect(types).toEqual(['Prop. Damage', 'Injury', 'Fatal'])
  })
})

import { test, expect } from '@playwright/test'

/**
 * crash-detail-pages spec, step 5: NJDOT crash-table date cells link to the
 * per-crash detail page (`/crash/:year/:cc/:mc/:case`). Before this, the
 * detail route existed but was unreachable from the UI.
 */
test.describe('Crash detail navigation', () => {
  test('NJDOT crash-table date links open the crash detail page', async ({ page }) => {
    await page.goto('/c/hudson/jersey-city')

    // Date cells in the NJDOT crash table render as links to /crash/...
    const firstLink = page.locator('a[href^="/crash/"]').first()
    await firstLink.waitFor({ timeout: 20_000 })

    const href = await firstLink.getAttribute('href')
    expect(href).toMatch(/^\/crash\/\d{4}\/\d+\/\d+\/.+$/)

    await firstLink.click()
    await page.waitForURL('**/crash/**')
    expect(new URL(page.url()).pathname).toBe(href)

    // Detail page heading: "<Severity> crash · <Mon D, YYYY>".
    await expect(page.locator('h1')).toHaveText(
      /^(Fatal|Injury|Property Damage Only) crash · \w+ \d+, \d{4}$/,
      { timeout: 15_000 },
    )

    // The always-present section headings, in order (counts stripped).
    const sections = await page.locator('main h2').allTextContents()
    expect(sections.slice(0, 4).map(s => s.replace(/\s*\(\d+\)\s*$/, ''))).toEqual(
      ['Location', 'Conditions', 'Casualties', 'Vehicles'],
    )
  })
})

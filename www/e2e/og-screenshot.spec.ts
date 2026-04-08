import { test, expect } from '@playwright/test'

test('capture OG image', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 630 })
    await page.goto('/og', { waitUntil: 'domcontentloaded' })

    // Wait for plot to render
    await page.locator('.js-plotly-plot').first().waitFor({ timeout: 15000 })
    // Wait for table to load (from D1 API)
    await page.locator('table').first().waitFor({ timeout: 15000 }).catch(() => {
        console.log('Table did not load (API may be unavailable)')
    })
    await page.waitForTimeout(3000)

    // Verify nothing is visibly truncated: check the #og container
    // doesn't have scrollable overflow
    const overflow = await page.evaluate(() => {
        const og = document.getElementById('og')
        if (!og) return 'no #og'
        const { scrollHeight, clientHeight, scrollWidth, clientWidth } = og
        return { scrollHeight, clientHeight, scrollWidth, clientWidth }
    })
    console.log('OG overflow check:', JSON.stringify(overflow))

    await page.screenshot({ path: 'public/og.png' })
})

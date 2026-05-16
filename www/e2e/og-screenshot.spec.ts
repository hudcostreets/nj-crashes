import { test, expect } from '@playwright/test'

// Output path is overridable via $OG_OUT_PATH (the og-image.sh script
// points it at a tmp jpg before uploading to S3). Default keeps the
// legacy public/og.png target so a bare `npx playwright test` still
// regenerates the local fallback.
const outPath = process.env.OG_OUT_PATH ?? 'public/og.png'
const isJpeg = /\.jpe?g$/i.test(outPath)

test('capture OG image', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 630 })
    await page.goto('/og', { waitUntil: 'domcontentloaded' })

    // Wait for plot to render
    await page.locator('.js-plotly-plot').first().waitFor({ timeout: 15000 })

    // Wait for the crashes table — race against any ResultTable error
    // panel (rendered when the D1 API fails). If the error wins, fail
    // the test so og-image.sh aborts before uploading a broken image.
    const tableLoc = page.locator('table').first()
    const errorLoc = page.locator('[class*="sqlError"]').first()
    await Promise.race([
        tableLoc.waitFor({ timeout: 15000 }),
        errorLoc.waitFor({ timeout: 15000 }),
    ]).catch(() => {})
    if (await errorLoc.isVisible()) {
        const msg = await errorLoc.innerText()
        throw new Error(`OG image table errored — refusing to publish broken image:\n${msg}`)
    }
    await expect(tableLoc).toBeVisible({ timeout: 1000 })
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

    await page.screenshot({
        path: outPath,
        type: isJpeg ? 'jpeg' : 'png',
        ...(isJpeg ? { quality: 85 } : {}),
    })
})

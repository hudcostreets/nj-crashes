import { FatalitiesPerYearPlot } from "@/src/njsp/FatalitiesPerYearPlot"
import { NjspCrashesSection } from "@/src/tables/NjspCrashesSection"
import { GeoFilterProvider } from "@/src/GeoFilterContext"

/**
 * Dedicated OG image page: Plot1 (left) + Recent Fatal Crashes table (right)
 * at exactly 1200x630. Screenshot with Playwright for og:image.
 *
 * Visit /og to preview. Run `npx playwright test e2e/og-screenshot.spec.ts`
 * to regenerate public/og.png.
 */

const W = 1200
const H = 630
const PAD = 10
const GAP = 12
const HALF_W = (W - 2 * PAD - GAP) / 2

export default function OgImage() {
    return (
        <GeoFilterProvider>
        <div id="og" style={{
            width: W,
            height: H,
            display: 'flex',
            background: '#0d1117',
            color: '#e0e0e0',
            overflow: 'hidden',
            boxSizing: 'border-box',
            alignItems: 'flex-start',
            justifyContent: 'center',
            gap: GAP,
            padding: PAD,
        }}>
            <style>{`
                #og h2 { text-align: center; font-size: 18px; margin: 0 0 8px; }
                #og h2 a { color: #e0e0e0; text-decoration: none; }
                #og [class*="subtitle"] { display: none !important; }
                /* Hide everything after the summary paragraph on the left */
                #og .og-left p ~ * { display: none !important; }
                #og .og-left p { font-size: 12px; }
                /* Hide By Year / By Month toggle */
                #og .og-left button { display: none !important; }
                #og table { font-size: 10px; white-space: nowrap; width: 100%; }
                #og table th { font-size: 9px; padding: 2px 3px; }
                #og table td { padding: 2px 3px; }
                /* Compact the narrower columns */
                #og table td:nth-child(1) { width: 62px; }  /* Date */
                #og table td:nth-child(2) { width: 52px; }  /* Time */
                #og table td:nth-child(3) { width: 64px; }  /* County */
                #og table td:nth-child(4) { width: 72px; }  /* Municipality */
                #og table td:nth-child(5) { width: 40px; }  /* Casualties */
                /* Location: fill remaining space, elide long values, right-justify */
                #og table td:last-child, #og table th:last-child {
                    text-align: right;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 180px;
                }
            `}</style>
            <div className="og-left" style={{ width: HALF_W, maxWidth: HALF_W, height: H - 2 * PAD, overflow: 'hidden' }}>
                <FatalitiesPerYearPlot id="og-p1" height={500} />
            </div>
            <div style={{ width: HALF_W, maxWidth: HALF_W, height: H - 2 * PAD, overflow: 'hidden', fontSize: 10 }}>
                <h2 style={{ marginBottom: 10 }}>Recent Fatal Crashes</h2>
                <NjspCrashesSection perPage={19} />
            </div>
        </div>
        </GeoFilterProvider>
    )
}

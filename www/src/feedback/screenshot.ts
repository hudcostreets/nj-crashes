/** Viewport screenshot for feedback reports: DOM capture via
 *  `modern-screenshot` (lazy-loaded; only fetched when someone opens the
 *  feedback form), with WebGL canvases (map) substituted from render-time
 *  copies (`glCapture.ts`). Output is downscaled and WebP/JPEG-encoded. */
import { captureGlCanvases } from "./glCapture"
import { IGNORE_ATTR } from "./actionLog"

/** Output width cap (px). Retina viewports are captured at ≤ this width. */
export const SHOT_MAX_W = 1600
const QUALITY = 0.8

/** Capture scale: device pixels, capped so the output is ≤ `SHOT_MAX_W` wide. */
export function shotScale(vw: number, dpr: number, maxW = SHOT_MAX_W): number {
    return Math.min(dpr || 1, maxW / Math.max(1, vw))
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
    return new Promise(res => canvas.toBlob(res, type, quality))
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
    // Safari can't encode WebP and silently returns PNG; fall back to JPEG.
    const webp = await toBlob(canvas, "image/webp", QUALITY)
    if (webp && webp.type === "image/webp") return webp
    const jpeg = await toBlob(canvas, "image/jpeg", QUALITY)
    if (!jpeg) throw new Error("screenshot encoding failed")
    return jpeg
}

const AUTO_MARGIN_ATTR = "data-feedback-ml"

/** Chrome reports `margin: 0 auto` + `width: 100%; max-width: …` boxes as
 *  `margin-left: 0px` (the auto margins resolve before `max-width` applies),
 *  and the DOM clone only carries computed styles, so such centered columns
 *  render flush-left. Record the real left offset of in-flow block children
 *  whose position disagrees with their reported margin; the clone hook below
 *  applies it. Returns a cleanup function. */
function markAutoMargins(): () => void {
    const marked: Element[] = []
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
        const parent = el.parentElement
        if (!parent || !(el instanceof HTMLElement)) continue
        const cs = getComputedStyle(el)
        if (cs.marginLeft !== "0px" || cs.display !== "block" || cs.float !== "none") continue
        if (cs.position !== "static" && cs.position !== "relative") continue
        const ps = getComputedStyle(parent)
        if (ps.display !== "block") continue
        const contentLeft = parent.getBoundingClientRect().left + parseFloat(ps.borderLeftWidth) + parseFloat(ps.paddingLeft)
        const delta = el.getBoundingClientRect().left - contentLeft - (cs.position === "relative" ? parseFloat(cs.left) || 0 : 0)
        if (delta > 0.5) {
            el.setAttribute(AUTO_MARGIN_ATTR, `${delta}px`)
            marked.push(el)
        }
    }
    return () => { for (const el of marked) el.removeAttribute(AUTO_MARGIN_ATTR) }
}

export async function captureScreenshot(): Promise<Blob> {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const scale = shotScale(vw, window.devicePixelRatio)
    const snaps = await captureGlCanvases()

    // modern-screenshot clones `<canvas>`es via `toDataURL()`; point the GL
    // ones at their render-time copies for the duration of the capture.
    for (const { canvas, dataUrl } of snaps) {
        Object.defineProperty(canvas, "toDataURL", { value: () => dataUrl, configurable: true })
    }
    // Clones take `<option selected>` *attributes*, not live selection (React
    // sets `.value`), so mirror the live selection into the attributes.
    const touched: HTMLOptionElement[] = []
    for (const opt of document.querySelectorAll("option")) {
        if (opt.selected !== opt.defaultSelected) {
            touched.push(opt)
            opt.defaultSelected = opt.selected
        }
    }
    const unmarkAutoMargins = markAutoMargins()
    try {
        const { domToCanvas } = await import("modern-screenshot")
        const { scrollX, scrollY } = window
        const canvas = await domToCanvas(document.body, {
            width: vw,
            height: vh,
            scale,
            backgroundColor: getComputedStyle(document.body).backgroundColor,
            style: {
                // The clone otherwise picks up UA-default `body` margins.
                margin: "0",
                // Viewport crop: shift the cloned body up/left by the scroll offset.
                ...(scrollX || scrollY ? { transform: `translate(${-scrollX}px, ${-scrollY}px)` } : {}),
            },
            filter: node => !(node instanceof Element && node.hasAttribute(IGNORE_ATTR)),
            // Re-apply recorded auto margins; and since the shifted body is the
            // containing block for `position: fixed` clones, shift those back
            // to stay viewport-anchored.
            onCloneEachNode: node => {
                const el = node as HTMLElement
                const style = el.style
                if (!style) return
                const ml = el.getAttribute?.(AUTO_MARGIN_ATTR)
                if (ml) style.marginLeft = ml
                if ((scrollX || scrollY) && style.position === "fixed") style.translate = `${scrollX}px ${scrollY}px`
            },
            timeout: 8000,
        })
        return await encode(canvas)
    } finally {
        for (const { canvas } of snaps) delete (canvas as { toDataURL?: unknown }).toDataURL
        for (const opt of touched) opt.defaultSelected = !opt.defaultSelected
        unmarkAutoMargins()
    }
}

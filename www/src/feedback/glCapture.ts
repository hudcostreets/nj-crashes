/** WebGL canvas capture for feedback screenshots.
 *
 *  maplibre and deck.gl render with `preserveDrawingBuffer: false` (the
 *  fast default), so their drawing buffers are cleared once composited: a
 *  DOM-to-image pass (or `toDataURL` at an arbitrary time) reads them back
 *  blank. Instead, each GL-rendering component registers a *capturer* that
 *  forces a repaint and copies its canvas from inside the render callback,
 *  while the buffer is still valid (maplibre's `render` event, deck's
 *  `onAfterRender`). `screenshot.ts` then substitutes those copies for the
 *  live canvases during the DOM capture, so overlays keep their z-order. */
import { useCallback, useEffect, useRef, type RefObject } from "react"
import type { DeckGLRef } from "@deck.gl/react"
import type { MapRef } from "react-map-gl/maplibre"

export type GlSnapshot = {
    /** The live canvas in the page. */
    canvas: HTMLCanvasElement
    /** PNG copy at the canvas's backing size (alpha kept: deck's canvas overlays the map). */
    dataUrl: string
}

type Capturer = () => Promise<GlSnapshot[]>

const capturers = new Set<Capturer>()

export function registerGlCapturer(fn: Capturer): () => void {
    capturers.add(fn)
    return () => { capturers.delete(fn) }
}

export async function captureGlCanvases(): Promise<GlSnapshot[]> {
    const results = await Promise.all([...capturers].map(fn => fn().catch(err => {
        console.warn("feedback: GL capture failed", err)
        return [] as GlSnapshot[]
    })))
    return results.flat()
}

/** Copy `src` (must be called while its drawing buffer is valid) into a 2D
 *  canvas. Kept at `src`'s backing size: the copy replaces the canvas's own
 *  `toDataURL()` during the DOM capture, and a different intrinsic size can
 *  change the clone's layout (e.g. widen a flex/grid column). */
export function snapshotCanvas(src: HTMLCanvasElement): string {
    const w = Math.max(1, src.width)
    const h = Math.max(1, src.height)
    const out = document.createElement("canvas")
    out.width = w
    out.height = h
    out.getContext("2d")!.drawImage(src, 0, 0, w, h)
    return out.toDataURL("image/png")
}

const GL_CAPTURE_TIMEOUT_MS = 2000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))])
}

/** Register a capturer for a `<DeckGL>` (non-interleaved) with a
 *  react-map-gl `<Map>` child. Wire the returned `deckRef` and
 *  `onAfterRender` into the `<DeckGL>`; pass the `<Map>`'s ref as `mapRef`. */
export function useDeckMapCapture(mapRef: RefObject<MapRef | null>) {
    const deckRef = useRef<DeckGLRef | null>(null)
    const pending = useRef<Array<() => void>>([])
    const onAfterRender = useCallback(() => {
        const cbs = pending.current
        if (!cbs.length) return
        pending.current = []
        for (const cb of cbs) cb()
    }, [])
    useEffect(() => registerGlCapturer(async () => {
        const out: GlSnapshot[] = []
        const map = mapRef.current?.getMap()
        if (map) {
            const canvas = map.getCanvas()
            const dataUrl = await withTimeout(new Promise<string>(res => {
                map.once("render", () => res(snapshotCanvas(canvas)))
                // Synchronous paint (fires `render` before returning), so this
                // works even when rAF is throttled (e.g. a backgrounded tab).
                map.redraw()
            }), GL_CAPTURE_TIMEOUT_MS)
            if (dataUrl) out.push({ canvas, dataUrl })
        }
        const deck = deckRef.current?.deck
        const canvas = deck?.getCanvas()
        if (deck && canvas) {
            const dataUrl = await withTimeout(new Promise<string>(res => {
                pending.current.push(() => res(snapshotCanvas(canvas)))
                deck.redraw("feedback-screenshot")
            }), GL_CAPTURE_TIMEOUT_MS)
            if (dataUrl) out.push({ canvas, dataUrl })
        }
        return out
    }), [mapRef])
    return { deckRef, onAfterRender }
}

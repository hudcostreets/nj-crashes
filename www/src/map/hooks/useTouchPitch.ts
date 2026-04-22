import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

/**
 * Two-finger pitch gesture for deck.gl on mobile.
 *
 * deck.gl's built-in `multipan` recognizer (via mjolnir.js) fails on real
 * touchscreens because Pinch and Pan(pointers:2, direction:Vertical) compete
 * for the same two-finger input — pinch almost always wins.
 * See https://github.com/visgl/deck.gl/issues/4853
 *
 * This hook detects two-finger vertical drag via document-level touch events
 * and converts it to pitch changes on a controlled `viewState`. A simple
 * state machine classifies gestures after a 15px dead zone:
 *
 *   idle → pending (2 fingers down) → pitching | passthrough
 *
 * Classification as "pitch" requires both fingers moving in the same vertical
 * direction with low spread change (not pinch) and low rotation.
 *
 * Convention: drag up = increase pitch (tilt toward horizon / surface).
 *
 * Usage:
 * ```tsx
 * const isPitchingRef = useTouchPitch({ setViewState, maxPitch: 85 })
 *
 * <DeckGL
 *   viewState={viewState}
 *   onViewStateChange={({ viewState: vs }) => {
 *     if (isPitchingRef.current) return  // ignore deck.gl during pitch
 *     setViewState(vs)
 *   }}
 *   controller={{ touchRotate: true }}
 * />
 * ```
 */
export function useTouchPitch<V extends { pitch: number }>({
  setViewState,
  maxPitch = 85,
  sensitivity = 0.3,
}: {
  /** React-style setState for the deck.gl viewState (controlled mode). */
  setViewState: Dispatch<SetStateAction<V>>
  /** Upper bound for pitch in degrees (default 85). */
  maxPitch?: number
  /** Degrees of pitch change per pixel of finger movement (default 0.3). */
  sensitivity?: number
}) {
  const isPitchingRef = useRef(false)
  // Refs for latest values so the effect never re-subscribes
  const cfgRef = useRef({ maxPitch, sensitivity })
  cfgRef.current = { maxPitch, sensitivity }
  const setterRef = useRef(setViewState)
  setterRef.current = setViewState

  useEffect(() => {
    type State = 'idle' | 'pending' | 'pitching' | 'passthrough'
    // Gesture state: start positions (sx/sy), last-frame positions (ly)
    const g = { state: 'idle' as State, sx0: 0, sy0: 0, sx1: 0, sy1: 0, ly0: 0, ly1: 0 }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        g.state = 'pending'
        g.sx0 = e.touches[0].clientX; g.sy0 = e.touches[0].clientY
        g.sx1 = e.touches[1].clientX; g.sy1 = e.touches[1].clientY
        g.ly0 = g.sy0; g.ly1 = g.sy1
      } else {
        g.state = 'idle'
        isPitchingRef.current = false
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || g.state === 'idle' || g.state === 'passthrough') return
      const x0 = e.touches[0].clientX, y0 = e.touches[0].clientY
      const x1 = e.touches[1].clientX, y1 = e.touches[1].clientY

      if (g.state === 'pending') {
        const dy0 = y0 - g.sy0, dy1 = y1 - g.sy1
        const dx0 = x0 - g.sx0, dx1 = x1 - g.sx1
        const avgDy = (dy0 + dy1) / 2, avgDx = (dx0 + dx1) / 2
        // Spread change (pinch/zoom signal)
        const startSpread = Math.hypot(g.sx1 - g.sx0, g.sy1 - g.sy0)
        const curSpread = Math.hypot(x1 - x0, y1 - y0)
        const spreadDelta = Math.abs(curSpread - startSpread)
        // Rotation signal
        const startAngle = Math.atan2(g.sy1 - g.sy0, g.sx1 - g.sx0)
        const curAngle = Math.atan2(y1 - y0, x1 - x0)
        let rotDelta = curAngle - startAngle
        if (rotDelta > Math.PI) rotDelta -= 2 * Math.PI
        if (rotDelta < -Math.PI) rotDelta += 2 * Math.PI
        const vert = Math.abs(avgDy)
        // Dead zone: wait for 15px of movement before classifying
        if (Math.max(vert, Math.abs(avgDx), spreadDelta) < 15) return
        // Pitch: both fingers same vertical direction, vertical dominates,
        // low spread change (not pinch), low rotation
        const sameDir = (dy0 > 0) === (dy1 > 0)
        if (sameDir && vert > Math.abs(avgDx) * 1.5 && spreadDelta < vert * 0.5 && Math.abs(rotDelta) < 0.2) {
          g.state = 'pitching'
          isPitchingRef.current = true
        } else {
          g.state = 'passthrough'
          return
        }
      }

      // Prevent browser default (scroll/zoom) while pitching
      e.preventDefault()
      const { maxPitch: mp, sensitivity: s } = cfgRef.current
      const frameDy = ((y0 - g.ly0) + (y1 - g.ly1)) / 2
      setterRef.current(v => ({ ...v, pitch: Math.max(0, Math.min(mp, v.pitch - frameDy * s)) } as V))
      g.ly0 = y0; g.ly1 = y1
    }

    const onTouchEnd = () => {
      g.state = 'idle'
      isPitchingRef.current = false
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [])

  return isPitchingRef
}

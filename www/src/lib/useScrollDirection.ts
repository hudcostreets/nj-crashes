import { useEffect, useState } from "react"

export type ScrollDirection = "up" | "down" | null

/** Returns the dominant recent scroll direction, or null when at the top
 *  (so the nav stays visible above the fold without flicker). `threshold`
 *  is the minimum delta in px before a flip is registered — protects
 *  against momentum / rubber-band jitter on iOS. */
export function useScrollDirection(threshold = 8): ScrollDirection {
    const [direction, setDirection] = useState<ScrollDirection>(null)

    useEffect(() => {
        let lastY = window.scrollY
        let ticking = false

        const update = () => {
            const y = window.scrollY
            const dy = y - lastY
            if (y <= 0) {
                setDirection(null)
            } else if (Math.abs(dy) >= threshold) {
                setDirection(dy > 0 ? "down" : "up")
                lastY = y
            }
            ticking = false
        }

        const onScroll = () => {
            if (!ticking) {
                window.requestAnimationFrame(update)
                ticking = true
            }
        }

        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [threshold])

    return direction
}

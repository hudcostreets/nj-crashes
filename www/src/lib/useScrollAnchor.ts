import { useEffect } from "react"

/**
 * Scroll restoration for SPAs with async-loaded content (plots, data tables).
 *
 * - On mount: if URL has a hash, repeatedly scroll the target into view
 *   until the user scrolls or 5s elapse (handles plots loading below the
 *   target that don't affect its position, and content above the target
 *   that would push it down).
 * - On user scroll (debounced): update the URL hash to the nearest `h2[id]`
 *   above the viewport top, using `replaceState` (doesn't pollute history).
 *   This way, any refresh lands at the user's current section without
 *   needing to save pixel offsets to sessionStorage.
 *
 * Use once at the app root.
 */
export function useScrollAnchor() {
    useEffect(() => {
        if (!('scrollRestoration' in history)) return
        history.scrollRestoration = 'manual'

        const hash = window.location.hash?.slice(1)
        let userScrolled = false

        // --- Phase 1: restore scroll to hash target ---
        if (hash) {
            const start = Date.now()
            const maxMs = 5000

            const onUserInput = () => { userScrolled = true }
            window.addEventListener('wheel', onUserInput, { passive: true, once: true })
            window.addEventListener('touchstart', onUserInput, { passive: true, once: true })
            window.addEventListener('keydown', onUserInput, { once: true })

            let revealed = false
            const reveal = () => {
                if (revealed) return
                revealed = true
                document.documentElement.style.visibility = ''
            }
            const rescroll = () => {
                if (userScrolled || Date.now() - start > maxMs) return
                const el = document.getElementById(hash)
                if (el) {
                    el.scrollIntoView({ block: 'start' })
                    reveal()  // show page once scroll has landed
                }
            }
            rescroll()

            const observer = new MutationObserver(rescroll)
            observer.observe(document.body, { childList: true, subtree: true })
            // Ultimate fallback: reveal after maxMs even if scroll never
            // completed (bad hash, etc.) so user isn't stuck on blank screen.
            window.setTimeout(() => { observer.disconnect(); reveal() }, maxMs)
        }

        // --- Phase 2: update URL hash as user scrolls ---
        // Only h2[id] are candidates (section headers). Debounced to avoid
        // thrashing history on every scroll event.
        let timer: number | undefined
        const updateHash = () => {
            const headers = Array.from(document.querySelectorAll<HTMLElement>('h2[id]'))
            if (headers.length === 0) return
            // "Current" section = the last h2 whose top is in the upper third of
            // the viewport (or above it). This gives a ~2-screen look-ahead, so
            // the hash updates as a new section's header enters the upper part
            // of the viewport, not only when it crosses the very top.
            const threshold = window.innerHeight / 3
            let current: HTMLElement | null = null
            for (const h of headers) {
                if (h.getBoundingClientRect().top <= threshold) current = h
                else break
            }
            const newHash = current ? `#${current.id}` : ''
            if (newHash !== window.location.hash) {
                history.replaceState(null, '', newHash || window.location.pathname + window.location.search)
            }
        }
        const onScroll = () => {
            window.clearTimeout(timer)
            timer = window.setTimeout(updateHash, 150)
        }
        window.addEventListener('scroll', onScroll, { passive: true })

        return () => {
            window.removeEventListener('scroll', onScroll)
            window.clearTimeout(timer)
        }
    }, [])
}

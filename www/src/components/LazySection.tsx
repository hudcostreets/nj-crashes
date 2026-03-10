import { ReactNode, useEffect, useRef, useState } from "react"

/**
 * Defers rendering of children until the container scrolls into view.
 * Uses IntersectionObserver with a generous rootMargin so data starts
 * loading slightly before the section becomes visible.
 */
export function LazySection({ children, rootMargin = "200px", placeholder }: {
    children: ReactNode
    rootMargin?: string
    placeholder?: ReactNode
}) {
    const ref = useRef<HTMLDivElement>(null)
    const [visible, setVisible] = useState(false)

    useEffect(() => {
        const el = ref.current
        if (!el) return
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setVisible(true)
                    observer.disconnect()
                }
            },
            { rootMargin },
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [rootMargin])

    return (
        <div ref={ref}>
            {visible ? children : (placeholder ?? null)}
        </div>
    )
}

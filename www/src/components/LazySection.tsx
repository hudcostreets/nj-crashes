import { ReactNode } from "react"

/**
 * Renders children immediately. Previously deferred rendering until
 * scroll-into-view via IntersectionObserver, but this had reliability
 * issues with React StrictMode and client-side routing.
 */
export function LazySection({ children }: {
    children: ReactNode
    rootMargin?: string
    placeholder?: ReactNode
}) {
    return <>{children}</>
}

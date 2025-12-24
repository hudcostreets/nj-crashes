// Vite replacement for @rdub/next-base/a
// Uses react-router-dom Link for internal links, regular anchor for external
import React, { AnchorHTMLAttributes, ReactNode } from "react"
import { Link } from "react-router-dom"

export type AProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
    href?: string
    children?: ReactNode
}

export default function A({ href, children, ...attrs }: AProps) {
    if (href && (href.startsWith("/") || href.startsWith("#"))) {
        // Internal link - use react-router Link
        // Handle hash-only links specially
        if (href.startsWith("#")) {
            return <a href={href} {...attrs}>{children}</a>
        }
        return <Link to={href} {...attrs}>{children}</Link>
    } else {
        // External link
        const { target = "_blank", rel = "noreferrer", ...rest } = attrs
        return <a href={href} target={target} rel={rel} {...rest}>{children}</a>
    }
}

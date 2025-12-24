// Vite replacement for @rdub/next-base/head
// Uses react-helmet-async for managing document head
import React, { ReactNode } from "react"
import { Helmet } from "react-helmet-async"
import { getBasePath } from "./basePath"

export type HeadProps = {
    title: string
    description: string
    type?: string
    url?: string
    thumbnail?: string
    favicon?: string
    twitterCard?: string
    children?: ReactNode
}

export function Head({
    title,
    description,
    type = 'website',
    url,
    thumbnail,
    favicon,
    twitterCard = 'summary_large_image',
    children,
}: HeadProps) {
    const basePath = getBasePath()
    favicon = favicon || `${basePath}/favicon.ico`

    return (
        <Helmet>
            <title>{title}</title>
            <link rel="icon" href={favicon} />
            <meta name="description" content={description} />
            <meta property="og:title" content={title} />
            <meta property="og:description" content={description} />
            <meta property="og:type" content={type} />
            {url && <meta property="og:url" content={url} />}
            {thumbnail && <meta property="og:image" content={thumbnail} />}
            <meta name="twitter:title" content={title} />
            <meta name="twitter:description" content={description} />
            {thumbnail && <meta name="twitter:image" content={thumbnail} />}
            <meta name="twitter:card" content={twitterCard} />
            {children}
        </Helmet>
    )
}

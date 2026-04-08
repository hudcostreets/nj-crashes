/**
 * CF Pages middleware: rewrites OG meta tags based on route.
 *
 * Runs on every page request. Passes through assets unchanged.
 * For HTML pages, rewrites <meta> tags with route-specific OG data.
 */

interface Env {
    NJSP_CRASHES_DB?: D1Database
    OG_BUCKET?: R2Bucket
}

interface OgMeta {
    title: string
    description: string
    image: string
    url: string
}

const SITE_URL = 'https://crashes.hudcostreets.org'
const DEFAULT_OG: OgMeta = {
    title: 'NJ Car Crash Data',
    description: 'Analysis & Visualization of car crash data published by NJ State Police and NJ DOT',
    image: `${SITE_URL}/og.png`,
    url: SITE_URL,
}

function denormalize(slug: string): string {
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function resolveOgMeta(pathname: string): OgMeta {
    // /c/:county/:muni
    const geoMatch = pathname.match(/^\/c\/([^/]+)(?:\/([^/]+))?\/?$/)
    if (geoMatch) {
        const [, countySlug, muniSlug] = geoMatch
        const county = denormalize(countySlug)
        const muni = muniSlug ? denormalize(muniSlug) : null
        const region = muni ? `${muni}, ${county} County` : `${county} County`
        return {
            title: `${region} — NJ Car Crash Data`,
            description: `Car crash data for ${region}, NJ`,
            image: `${SITE_URL}/og.png`, // TODO: per-county OGI from R2
            url: `${SITE_URL}${pathname}`,
        }
    }

    // /crash/:accid (future)
    const crashMatch = pathname.match(/^\/crash\/(\d+)\/?$/)
    if (crashMatch) {
        return {
            title: `Fatal Crash — NJ Car Crash Data`,
            description: 'Fatal crash details from NJ State Police data',
            image: `${SITE_URL}/og.png`, // TODO: per-crash OGI
            url: `${SITE_URL}${pathname}`,
        }
    }

    return DEFAULT_OG
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const response = await context.next()
    const url = new URL(context.request.url)

    // Only rewrite HTML responses (not assets)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
        return response
    }

    const og = resolveOgMeta(url.pathname)

    return new HTMLRewriter()
        .on('title', {
            element(el) { el.setInnerContent(og.title) },
        })
        .on('meta[property="og:title"]', {
            element(el) { el.setAttribute('content', og.title) },
        })
        .on('meta[property="og:description"]', {
            element(el) { el.setAttribute('content', og.description) },
        })
        .on('meta[property="og:image"]', {
            element(el) { el.setAttribute('content', og.image) },
        })
        .on('meta[property="og:url"]', {
            element(el) { el.setAttribute('content', og.url) },
        })
        .on('meta[name="twitter:image"]', {
            element(el) { el.setAttribute('content', og.image) },
        })
        .transform(response)
}

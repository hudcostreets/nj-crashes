/**
 * FE Worker (Workers + static Assets): serves the SPA from `env.ASSETS`, and
 * rewrites OG meta tags on HTML responses based on route.
 *
 * `run_worker_first` (see `wrangler.toml`) sends only SPA navigation routes
 * here; hashed `/assets/*` and other static files go straight to the asset
 * server. Anything that does reach the Worker and isn't HTML passes through.
 */

interface Env {
    ASSETS: Fetcher
    NJSP_CRASHES_DB?: D1Database
    OG_BUCKET?: R2Bucket
}

interface OgMeta {
    title: string
    description: string
    image: string
    url: string
}

const SITE_URL = 'https://crashes.hccs.dev'
// Daily-regenerated homepage mosaic — see `www/og-image.dvc` (uploads
// to `$NJC_S3/og.jpg` = HCCS R2 `crashes` after every daily CI run).
const OG_IMAGE = 'https://crashes-data.hccs.dev/og.jpg'
const DEFAULT_OG: OgMeta = {
    title: 'NJ Car Crash Data',
    description: 'Analysis & Visualization of car crash data published by NJ State Police and NJ DOT',
    image: OG_IMAGE,
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
            image: OG_IMAGE, // TODO: per-county OGI from R2
            url: `${SITE_URL}${pathname}`,
        }
    }

    // /crash/:accid (future)
    const crashMatch = pathname.match(/^\/crash\/(\d+)\/?$/)
    if (crashMatch) {
        return {
            title: `Fatal Crash — NJ Car Crash Data`,
            description: 'Fatal crash details from NJ State Police data',
            image: OG_IMAGE, // TODO: per-crash OGI
            url: `${SITE_URL}${pathname}`,
        }
    }

    return DEFAULT_OG
}

export default {
    async fetch(request, env): Promise<Response> {
        const response = await env.ASSETS.fetch(request)
        const url = new URL(request.url)

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
    },
} satisfies ExportedHandler<Env>

import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { HotkeysProvider, Omnibar, ShortcutsModal, LookupModal } from 'use-kbd'
import 'use-kbd/styles.css'
import GeoHome from './routes/GeoHome'
import { AppSpeedDial } from './components/AppSpeedDial'
import { DuckDbProvider } from './lib/DuckDbContext'
import { useSectionsActions } from './components/SectionsOmnibar'
import { useScrollAnchor } from './lib/useScrollAnchor'

// Home is eager (the landing page). Everything else lazy — `/sql`,
// `/duckdb`, `/match-review`, `/map`, `/raw`, `/files`, `/harmonization`
// each pull in heavy deps (duckdb-wasm, maplibre/deck for the map page,
// plotly variants) that we don't need on the initial homepage paint.
const NotFound = lazy(() => import('./routes/NotFound'))
const SqlPage = lazy(() => import('./routes/SqlPage'))
const DuckDbPage = lazy(() => import('./routes/DuckDbPage'))
const HudsonMap = lazy(() => import('./routes/HudsonMap'))
const HudsonDiffs = lazy(() => import('./routes/HudsonDiffs'))
const OgImage = lazy(() => import('./routes/OgImage'))
const MatchReview = lazy(() => import('./routes/MatchReview'))
const CrashMapPage = lazy(() => import('./routes/CrashMapPage'))
const CrashDetailPage = lazy(() => import('./routes/CrashDetailPage'))
const RawFileBrowser = lazy(() => import('./raw/RawFileBrowser'))
const FilesPage = lazy(() => import('./routes/FilesPage'))
const HarmonizationPage = lazy(() => import('./routes/HarmonizationPage'))
const MuniSlugRoute = lazy(() => import('./routes/MuniSlugRoute'))
const CanonicalizeMuni = lazy(() => import('./routes/CanonicalizeMuni'))

/** Register sections-jump omnibar endpoint. Sits at the App level so any
 *  route with `<h2 id="…">` anchors gets jumpable from Cmd+K. */
function SectionsRegistrar() {
    useSectionsActions()
    return null
}

export default function App() {
    useScrollAnchor()
    return (
        <HotkeysProvider>
        <DuckDbProvider>
            <SectionsRegistrar />
            <Suspense fallback={null}>
            <Routes>
                <Route path="/" element={<GeoHome />} />
                <Route path="/c" element={<GeoHome />} />
                <Route path="/c/:county" element={<GeoHome />} />
                {/* Muni-level `/c/{county}/{muni}` redirects to the short
                    canonical `/{muni-slug}` (or `/{muni-slug}-{county}`
                    when the stem+type is ambiguous state-wide). */}
                <Route path="/c/:county/:city" element={<CanonicalizeMuni />} />
                <Route path="/njsp" element={<GeoHome />} />
                <Route path="/njsp/:county" element={<GeoHome />} />
                <Route path="/sql" element={<SqlPage />} />
                <Route path="/duckdb" element={<DuckDbPage />} />
                <Route path="/og" element={<OgImage />} />
                <Route path="/match-review" element={<MatchReview />} />
                <Route path="/map/hudson/diffs" element={<HudsonDiffs />} />
                <Route path="/map/hudson/legacy" element={<HudsonMap />} />
                <Route path="/map" element={<CrashMapPage />} />
                {/* short form */}
                <Route path="/map/:county" element={<CrashMapPage />} />
                <Route path="/map/:county/:muni" element={<CrashMapPage />} />
                {/* `/c/` form for disambiguation in case we add other /map/* sub-routes later */}
                <Route path="/map/c/:county" element={<CrashMapPage />} />
                <Route path="/map/c/:county/:muni" element={<CrashMapPage />} />
                <Route path="/crash/:year/:cc/:mc/:case" element={<CrashDetailPage />} />
                <Route path="/raw" element={<RawFileBrowser />} />
                <Route path="/raw/*" element={<RawFileBrowser />} />
                <Route path="/harmonization" element={<HarmonizationPage />} />
                <Route path="/h11n" element={<HarmonizationPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/files/*" element={<FilesPage />} />
                {/* Bare `/{muni-slug}` convenience URL — resolves state-wide via
                    `muniKey` and redirects to `/c/{county}/{muni}` when unique;
                    picker when ambiguous; 404 with suggestions when nothing
                    matches. See `specs/canonical-muni-slugs.md`. */}
                <Route path="/:muniSlug" element={<MuniSlugRoute />} />
                <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
            <Omnibar />
            <ShortcutsModal />
            <LookupModal />
            <AppSpeedDial />
        </DuckDbProvider>
        </HotkeysProvider>
    )
}

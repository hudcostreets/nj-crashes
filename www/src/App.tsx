import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { HotkeysProvider, Omnibar, ShortcutsModal, LookupModal, SpeedDial } from 'use-kbd'
import 'use-kbd/styles.css'
import Home from './routes/Home'
import { ThemeToggle } from './components/ThemeToggle'
import { GeoFilterProvider } from './GeoFilterContext'
import { DuckDbProvider } from './lib/DuckDbContext'
import { useGeoActions } from './components/GeoOmnibar'
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

function GeoHome() {
    return <GeoFilterProvider><GeoActionsRegistrar /><Home /></GeoFilterProvider>
}

/** Register geo actions inside GeoFilterProvider */
function GeoActionsRegistrar() {
    useGeoActions()
    return null
}

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
                <Route path="/c/:county/:city" element={<GeoHome />} />
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
                <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
            <Omnibar />
            <ShortcutsModal />
            <LookupModal />
            <SpeedDial />
            <ThemeToggle />
        </DuckDbProvider>
        </HotkeysProvider>
    )
}

import { Routes, Route } from 'react-router-dom'
import { HotkeysProvider, Omnibar, ShortcutsModal, LookupModal, SpeedDial } from 'use-kbd'
import 'use-kbd/styles.css'
import Home from './routes/Home'
import NotFound from './routes/NotFound'
import SqlPage from './routes/SqlPage'
import DuckDbPage from './routes/DuckDbPage'
import HudsonMap from './routes/HudsonMap'
import HudsonDiffs from './routes/HudsonDiffs'
import OgImage from './routes/OgImage'
import MatchReview from './routes/MatchReview'
import CrashMapPage from './routes/CrashMapPage'
import CrashDetailPage from './routes/CrashDetailPage'
import RawFileBrowser from './raw/RawFileBrowser'
import { ThemeToggle } from './components/ThemeToggle'
import { GeoFilterProvider } from './GeoFilterContext'
import { DuckDbProvider } from './lib/DuckDbContext'
import { useGeoActions } from './components/GeoOmnibar'
import { useSectionsActions } from './components/SectionsOmnibar'
import { useScrollAnchor } from './lib/useScrollAnchor'

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
                <Route path="*" element={<NotFound />} />
            </Routes>
            <Omnibar />
            <ShortcutsModal />
            <LookupModal />
            <SpeedDial />
            <ThemeToggle />
        </DuckDbProvider>
        </HotkeysProvider>
    )
}

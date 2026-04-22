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
import { ThemeToggle } from './components/ThemeToggle'
import { GeoFilterProvider } from './GeoFilterContext'
import { DuckDbProvider } from './lib/DuckDbContext'
import { useGeoActions } from './components/GeoOmnibar'
import { useScrollAnchor } from './lib/useScrollAnchor'

function GeoHome() {
    return <GeoFilterProvider><GeoActionsRegistrar /><Home /></GeoFilterProvider>
}

/** Register geo actions inside GeoFilterProvider */
function GeoActionsRegistrar() {
    useGeoActions()
    return null
}

export default function App() {
    useScrollAnchor()
    return (
        <HotkeysProvider>
        <DuckDbProvider>
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
                <Route path="/map/hudson" element={<HudsonMap />} />
                <Route path="/map/hudson/diffs" element={<HudsonDiffs />} />
                <Route path="/map" element={<CrashMapPage />} />
                <Route path="/map/c/:county" element={<CrashMapPage />} />
                <Route path="/map/c/:county/:muni" element={<CrashMapPage />} />
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

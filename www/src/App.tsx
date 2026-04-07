import { Routes, Route } from 'react-router-dom'
import Home from './routes/Home'
import NotFound from './routes/NotFound'
import SqlPage from './routes/SqlPage'
import DuckDbPage from './routes/DuckDbPage'
import HudsonMap from './routes/HudsonMap'
import HudsonDiffs from './routes/HudsonDiffs'
import { ThemeToggle } from './components/ThemeToggle'
import { GeoFilterProvider } from './GeoFilterContext'
import { DuckDbProvider } from './lib/DuckDbContext'

function GeoHome() {
    return <GeoFilterProvider><Home /></GeoFilterProvider>
}

export default function App() {
    return (
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
                <Route path="/map/hudson" element={<HudsonMap />} />
                <Route path="/map/hudson/diffs" element={<HudsonDiffs />} />
                <Route path="*" element={<NotFound />} />
            </Routes>
            <ThemeToggle />
        </DuckDbProvider>
    )
}

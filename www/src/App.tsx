import { Routes, Route } from 'react-router-dom'
import Home from './routes/Home'
import NotFound from './routes/NotFound'
import NjspRegion from './routes/NjspRegion'
import CrashRegion from './routes/CrashRegion'
import SqlPage from './routes/SqlPage'
import DuckDbPage from './routes/DuckDbPage'
import HudsonMap from './routes/HudsonMap'
import HudsonDiffs from './routes/HudsonDiffs'

export default function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/njsp" element={<NjspRegion />} />
            <Route path="/njsp/:county" element={<NjspRegion />} />
            <Route path="/c" element={<CrashRegion />} />
            <Route path="/c/:county" element={<CrashRegion />} />
            <Route path="/c/:county/:city" element={<CrashRegion />} />
            <Route path="/sql" element={<SqlPage />} />
            <Route path="/duckdb" element={<DuckDbPage />} />
            <Route path="/map/hudson" element={<HudsonMap />} />
            <Route path="/map/hudson/diffs" element={<HudsonDiffs />} />
            <Route path="*" element={<NotFound />} />
        </Routes>
    )
}

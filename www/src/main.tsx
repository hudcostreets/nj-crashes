import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import { ThemeProvider } from './contexts/ThemeContext'
import { PlotlyProvider } from 'pltly/react'
import App from './App'
import '../styles/globals.css'
import 'leaflet/dist/leaflet.css'
import '@fortawesome/fontawesome-svg-core/styles.css'

const plotlyBasic = () => import('plotly.js/lib/index-basic.js' as any).then(m => (m as any).default ?? m)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HelmetProvider>
      <ThemeProvider>
        <PlotlyProvider loader={plotlyBasic}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        </PlotlyProvider>
      </ThemeProvider>
    </HelmetProvider>
  </React.StrictMode>,
)

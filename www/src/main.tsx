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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HelmetProvider>
      <ThemeProvider>
        <PlotlyProvider loader={() => import('plotly.js/dist/plotly.min.js').then(m => (m as any).default ?? m)}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        </PlotlyProvider>
      </ThemeProvider>
    </HelmetProvider>
  </React.StrictMode>,
)

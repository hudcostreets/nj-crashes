import '../styles/globals.css'
import 'leaflet/dist/leaflet.css';
import '@fortawesome/fontawesome-svg-core/styles.css'
import type { AppProps } from 'next/app'

function MyApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}

export default MyApp

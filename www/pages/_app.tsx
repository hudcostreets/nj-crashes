import '../styles/globals.css'
import 'leaflet/dist/leaflet.css';
import '@fortawesome/fontawesome-svg-core/styles.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import type { AppProps } from 'next/app'
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchInterval: false,
      retry: false,
    }
  }
})

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <Component {...pageProps} />
    </QueryClientProvider>
  )
}

export default MyApp

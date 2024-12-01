import '../styles/globals.css'
import 'leaflet/dist/leaflet.css'
import '@fortawesome/fontawesome-svg-core/styles.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import { ThemeProvider } from '@mui/material'
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import theme from "@/src/theme"
import type { AppProps } from 'next/app'

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
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <Component {...pageProps} />
      </QueryClientProvider>
    </ThemeProvider>
  )
}

export default MyApp

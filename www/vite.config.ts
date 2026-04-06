import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import { pdsPlugin } from 'pnpm-dep-source/vite'
import path from 'path'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

export default defineConfig({
  plugins: [
    react(),
    vanillaExtractPlugin(),
    pdsPlugin(),
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },

  build: {
    outDir: 'dist',
  },

  server: {
    port: 4006,
    host: true,
    allowedHosts,
    proxy: {
      '/api': {
        target: 'http://localhost:51894',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  }
})

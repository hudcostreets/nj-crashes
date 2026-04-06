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
      'plotly.js/basic': path.resolve(__dirname, 'node_modules/plotly.js/lib/index-basic.js'),
    },
  },

  build: {
    outDir: 'dist',
  },

  server: {
    port: 4006,
    host: true,
    allowedHosts,
    fs: {
      allow: ['..', '../../..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:51894',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  }
})

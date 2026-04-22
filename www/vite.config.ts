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
      // Prevent duplicate React across symlink boundary (pds local)
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      'react-dom/client': path.resolve(__dirname, 'node_modules/react-dom/client'),
    },
    dedupe: ['plotly.js', 'react', 'react-dom'],
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
  },
  optimizeDeps: {
    exclude: ['pltly'],
  },
})

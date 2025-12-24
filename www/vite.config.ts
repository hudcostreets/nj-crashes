import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    vanillaExtractPlugin(),
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
    port: 3000,
  },
})

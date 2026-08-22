import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import { pdsPlugin } from 'pnpm-dep-source/vite'
import path from 'path'
import fs from 'fs'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

/** Dev-only endpoint for the `/tune` page: POST a JSON body to
 *  `/__tune/write` and it's written to `src/map/tuning.json` (indented,
 *  trailing newline). The picker imports that file, so Vite HMR reloads
 *  the app with the new constants. Committed as the shipped defaults. */
function tuneWriterPlugin(): Plugin {
  const votesFile = path.resolve(__dirname, 'tune/votes.jsonl')
  return {
    name: 'tune-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__tune/write', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(body)
            const file = path.resolve(__dirname, 'src/map/tuning.json')
            fs.writeFileSync(file, JSON.stringify(parsed, null, 4) + '\n')
            res.setHeader('Content-Type', 'application/json')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, file }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
        })
      })
      // `/tune/ab` preference stream: GET returns the accumulated votes
      // JSONL verbatim (page counts lines on mount; Claude reads the file
      // directly when fitting thresholds).
      server.middlewares.use('/__tune/votes', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'text/plain')
        res.statusCode = 200
        res.end(fs.existsSync(votesFile) ? fs.readFileSync(votesFile, 'utf8') : '')
      })
      // POST one vote record → appended as a JSONL row. Git-tracked so the
      // corpus accumulates across sessions/machines.
      server.middlewares.use('/__tune/vote', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            fs.mkdirSync(path.dirname(votesFile), { recursive: true })
            fs.appendFileSync(votesFile, JSON.stringify(parsed) + '\n')
            res.setHeader('Content-Type', 'application/json')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, file: votesFile }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    vanillaExtractPlugin(),
    pdsPlugin(),
    tuneWriterPlugin(),
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
  }
})

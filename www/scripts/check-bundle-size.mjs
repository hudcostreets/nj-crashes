#!/usr/bin/env node
/**
 * Bundle-size tracker: after a prod build, walk `dist/`, compute raw and
 * gzipped size for each JS/CSS asset, compare to `bundle-size.baseline.json`.
 *
 * Usage:
 *   pnpm build                      # populate dist/
 *   node scripts/check-bundle-size.mjs             # check against baseline
 *   node scripts/check-bundle-size.mjs --update    # write baseline
 *   node scripts/check-bundle-size.mjs --threshold=0.05  # allow 5% growth
 *
 * CI can run `pnpm build && node scripts/check-bundle-size.mjs` to fail on
 * unexpected growth.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { gzipSync } from 'zlib'
import { resolve, relative, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(__dirname, '..')
const distDir = resolve(root, 'dist')
const baselinePath = resolve(root, 'bundle-size.baseline.json')

const args = process.argv.slice(2)
const update = args.includes('--update')
const threshold = parseFloat(args.find(a => a.startsWith('--threshold='))?.split('=')[1] ?? '0.05')

if (!existsSync(distDir)) {
    console.error(`✗ ${distDir} not found — run \`pnpm build\` first.`)
    process.exit(1)
}

/** Walk dist/ recursively, return [{ path, raw, gzip }] for JS/CSS. */
function walk(dir) {
    const out = []
    for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
            out.push(...walk(full))
        } else if (/\.(js|css)$/.test(name)) {
            const buf = readFileSync(full)
            out.push({
                path: relative(distDir, full),
                raw: buf.length,
                gzip: gzipSync(buf).length,
            })
        }
    }
    return out
}

/** Aliases: strip hash suffix (e.g. "index-ABC123.js" → "index.js") so
 *  baseline entries survive rebuild-hash changes. */
function normalize(path) {
    return path.replace(/-[A-Za-z0-9_-]{8,}\.(js|css)$/, '.$1')
}

/** Sum per-normalized-name totals. */
function summarize(entries) {
    const byName = new Map()
    for (const e of entries) {
        const k = normalize(e.path)
        const cur = byName.get(k) ?? { raw: 0, gzip: 0 }
        cur.raw += e.raw
        cur.gzip += e.gzip
        byName.set(k, cur)
    }
    return Object.fromEntries([...byName.entries()].sort())
}

function totals(byName) {
    return Object.values(byName).reduce(
        (acc, { raw, gzip }) => ({ raw: acc.raw + raw, gzip: acc.gzip + gzip }),
        { raw: 0, gzip: 0 },
    )
}

function fmt(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

const current = summarize(walk(distDir))
const currentTotal = totals(current)

if (update) {
    writeFileSync(baselinePath, JSON.stringify({ entries: current, total: currentTotal }, null, 2) + '\n')
    console.log(`✓ Wrote baseline: ${baselinePath}`)
    console.log(`  Total: ${fmt(currentTotal.raw)} raw / ${fmt(currentTotal.gzip)} gzip`)
    process.exit(0)
}

if (!existsSync(baselinePath)) {
    console.error(`✗ ${baselinePath} not found — run with --update to create.`)
    process.exit(1)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
const baselineEntries = baseline.entries ?? {}
const baselineTotal = baseline.total ?? totals(baselineEntries)

const rows = []
const issues = []
for (const [name, { raw, gzip }] of Object.entries(current)) {
    const prev = baselineEntries[name]
    const prevGzip = prev?.gzip ?? 0
    const diff = gzip - prevGzip
    const pct = prev ? diff / prevGzip : 1
    rows.push({ name, gzip, prevGzip, diff, pct, isNew: !prev })
    if (prev && pct > threshold) {
        issues.push({ name, prevGzip, gzip, pct })
    }
}
for (const name of Object.keys(baselineEntries)) {
    if (!(name in current)) {
        rows.push({ name, gzip: 0, prevGzip: baselineEntries[name].gzip, diff: -baselineEntries[name].gzip, pct: -1, isRemoved: true })
    }
}

const totalPctChange = (currentTotal.gzip - baselineTotal.gzip) / baselineTotal.gzip

console.log('Bundle size (gzipped):')
console.log('─'.repeat(72))
for (const r of rows) {
    const arrow = r.isNew ? '+NEW' : r.isRemoved ? '−GONE' : (r.diff >= 0 ? `+${fmt(r.diff)}` : `−${fmt(-r.diff)}`)
    const pctStr = r.isNew ? '' : r.isRemoved ? '' : ` (${(r.pct * 100).toFixed(1)}%)`
    console.log(`  ${r.name.padEnd(42)} ${fmt(r.gzip).padStart(10)}   ${arrow}${pctStr}`)
}
console.log('─'.repeat(72))
const totalDiff = currentTotal.gzip - baselineTotal.gzip
console.log(`  ${'TOTAL'.padEnd(42)} ${fmt(currentTotal.gzip).padStart(10)}   ${totalDiff >= 0 ? '+' : '−'}${fmt(Math.abs(totalDiff))} (${(totalPctChange * 100).toFixed(1)}%)`)

if (issues.length > 0) {
    console.error('')
    console.error(`✗ ${issues.length} asset(s) grew more than ${(threshold * 100).toFixed(0)}%:`)
    for (const i of issues) {
        console.error(`  ${i.name}: ${fmt(i.prevGzip)} → ${fmt(i.gzip)} (+${(i.pct * 100).toFixed(1)}%)`)
    }
    process.exit(1)
}

console.log('')
console.log(`✓ All assets within ${(threshold * 100).toFixed(0)}% of baseline.`)

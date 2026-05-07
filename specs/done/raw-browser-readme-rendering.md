# `/raw/*` browser: render `README.md` per directory

## Status (2026-05-07)

EC2 side done; FE side open. Companion to
`specs/done/mirror-bulk-to-r2.md` and `specs/raw-file-browser.md`.

## Motivation

`/raw/` is the demo surface for the upcoming DOT-BTDS conversation.
The `<DirListing>` component currently just lists keys; the
`<Footnote>` has the high-level pitch but the same text on every page.
Per-directory context (what's in `2023/` vs `2022/`, what `fields/`
is for, what the table layout means) is more naturally a
`README.md` sidecar than hardcoded copy.

EC2 has uploaded curated `README.md` files to four prefixes:

```
r2://nj-crashes/raw/README.md
r2://nj-crashes/raw/njdot/data/README.md
r2://nj-crashes/raw/njdot/data/2022/README.md
r2://nj-crashes/raw/njdot/data/2023/README.md
```

Re-runnable via `scripts/mirror_raw_readmes_to_r2.sh`. Source files
git-tracked under `data/raw-readmes/<r2-path>/README.md` (path
mirrors the R2 layout 1:1). To edit copy, edit the source file and
re-run the sync script.

## What to build

When `<DirListing>` renders a directory, also fetch
`<prefix>README.md` via `/v1/raw/get?path=…`. If it 200s, render the
markdown above the directory table (and below the breadcrumb).

### UX

```
┌─────────────────────────────────────┐
│ Breadcrumb: raw / njdot / data / 2023 / │
│                                     │
│ # njdot/data/2023/ — per-county …  │  ← rendered README
│                                     │
│ First year of the per-county …      │
│                                     │
│ ─────────────────────                │
│                                     │
│ Name           Size     Modified    │  ← directory table
│ Atlantic2023*.zip  …               │
│ ...                                 │
└─────────────────────────────────────┘
```

(README first, separator line, then the existing dir table.)

### Implementation sketch

In `www/src/raw/DirListing.tsx`:

```tsx
const readmeUrl = rawGetUrl(`${prefix}README.md`)
const { data: readmeText } = useQuery({
    queryKey: ['readme', prefix],
    queryFn: async () => {
        const r = await fetch(readmeUrl)
        if (r.status === 404) return null  // common: no readme
        if (!r.ok) throw new Error(`README fetch failed: ${r.status}`)
        return r.text()
    },
    staleTime: 1000 * 60 * 60,  // 1h — they barely change
    retry: false,
})

return (
    <>
        {readmeText && <DirReadme markdown={readmeText} />}
        <DirTable entries={entries} />
    </>
)
```

`<DirReadme>` is a thin markdown renderer. `react-markdown` is the
standard pick; if added, also include `remark-gfm` for tables (the
`njdot/data/README.md` uses one) and a small `style={{ maxWidth: 800
}}` wrapper to keep paragraph width readable.

### Cache + 404 behavior

- Cache `staleTime` 1h is fine — these files barely change. The
  bulk-mirror's `Cache-Control` is `public, max-age=86400` already
  (forwarded by the worker for `raw/` keys); the FE cache complements
  it.
- 404s are common (most leaf dirs won't have a README). Don't display
  an error; just don't render the section. The fetch should NOT
  retry or display a spinner — silent fall-through.

### Footnote interaction

The current `<Footnote>` is tied to *all* `/raw/*` pages. Once
README rendering exists, consider whether it stays the same on every
page or whether the top-level `raw/README.md` *replaces* it (probably
not — the footnote handles "what is this site, why" framing while
READMEs handle "what's in this dir specifically").

Recommendation: keep the footnote, let READMEs add per-dir context
above it.

## Out of scope

- Editing READMEs from the browser. Edit-source-and-re-sync workflow
  is fine for the demo.
- Sub-directory READMEs we haven't written yet. Only 4 prefixes have
  files today; others get the existing dir-listing-only experience.
- Rendering README inside zip-entry-list / zip-entry-preview. Just
  directory-level for now.

## Done when

- [ ] `react-markdown` (+ `remark-gfm`) added to `www/`
- [ ] `<DirListing>` fetches `<prefix>README.md` via `rawGetUrl`,
      renders above the table when present
- [ ] 404s silent (no error UI)
- [ ] CIC: `/raw/`, `/raw/njdot/data/`, `/raw/njdot/data/2022/`,
      `/raw/njdot/data/2023/` all render their respective READMEs
- [ ] CIC: `/raw/njdot/data/fields/` (no README uploaded yet) renders
      cleanly without a section break or empty space

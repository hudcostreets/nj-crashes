# og:image and favicon audit

Site: https://crashes.hudcostreets.org/

## Current state (2026-04-07)
- **GitHub social preview**: custom 1200x700 — wrong AR (should be 1200x630)
- **Site og:image**: 1200x600 — also wrong dimensions
- **Favicon**: .ico format

The `ryan-williams` profile README now uses site OG images when available, falling back to GitHub OG. This repo's GH OGI is 1200x700 (1.71:1 AR), which renders poorly alongside other cards at 1200x630 (1.90:1).

## Tasks

### Fix OG image dimensions to 1200x630
Regenerate or resize the OG image to **1200x630** (standard ~1.91:1 ratio). This is the standard for Facebook/Twitter/LinkedIn/WhatsApp. Keep under 300KB.

Update both:
1. The site's og:image
2. The GitHub repo social preview (Settings → Social preview)

### Upgrade favicon
Replace `.ico` with SVG favicon (or at minimum PNG). Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`.

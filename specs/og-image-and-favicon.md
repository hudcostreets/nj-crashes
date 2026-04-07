# og:image and favicon audit

Site: https://crashes.hudcostreets.org/

## Current state
- **GitHub social preview**: custom (1200x700, 86KB png) — good
- **Site og:image**: 1200x600, 76KB png — wrong dimensions
- **Favicon**: .ico format

## Tasks

### Fix site og:image dimensions
Current image is 1200x600. Resize/regenerate to **1200x630** (standard 1.91:1 ratio for Facebook/Twitter/LinkedIn/WhatsApp). Keep under 300KB.

### Upgrade favicon
Replace `.ico` with SVG favicon (or at minimum PNG). Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`. Consider also adding `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` (180x180 PNG).

### Set GitHub social preview to match site og:image
The GH social preview is already custom but at 1200x700. Upload the corrected 1200x630 image as the repo's social preview (Settings → Social preview).

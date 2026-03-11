# Table views

## Status: DONE

All three table views are implemented, wired into `Home.tsx`, and served via Cloudflare D1 API.

### Implemented tables

| Table | Component | API endpoint | Features |
|-------|-----------|-------------|----------|
| Annual Statistics | `YearStatsSection.tsx` | `/njdot/year-stats?cc=&mc=` | Year selection, multi-year summaries, range select |
| NJSP Fatal Crashes | `NjspCrashesSection.tsx` | `/njsp/crashes?cc=&mc=&offset=&limit=` | Page-based pagination |
| NJDOT Crash Details | `NjdotCrashesSection.tsx` | `/njdot/crashes?cc=&mc=&before=&limit=` | Date-based pagination, vehicle/injury detail icons |

### Key files
- `www/src/tables/YearStatsSection.tsx` — annual stats with row selection
- `www/src/tables/NjspCrashesSection.tsx` — NJSP fatal crashes
- `www/src/tables/NjdotCrashesSection.tsx` — NJDOT crash details
- `www/src/use-year-stats.ts` — year stats data hook (D1 API)
- `www/src/use-njsp-crashes.tsx` — NJSP crash rows hook (D1 API)
- `www/src/use-njdot-crashes.tsx` — NJDOT crash rows hook (D1 API)
- `www/src/api.ts` — API client (`VITE_API_URL` → CF Worker)
- `api/src/index.ts` — CF Worker with D1 bindings

### Data backend
All table data is served from Cloudflare D1 databases (6 databases, ~33.5M rows total), replacing the previous sql.js-httpvfs browser-side approach. The D1 API supports cc/mc geo-filtering on all endpoints.

### Remaining
- Link table rows to crash detail pages (see `crash-detail-pages.md`)

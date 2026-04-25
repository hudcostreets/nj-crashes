/** Base URL for sharded map data (parquet + geojson).
 *
 *  Local dev: unset → falls back to `/njdot/map`, which Vite serves
 *  directly out of `www/public/njdot/map/`.
 *
 *  Prod build: set `VITE_MAP_BASE_URL=https://nj-crashes.s3.amazonaws.com/njdot/map`
 *  so shards are fetched from S3 instead of bundled into the CFP deploy.
 */
export const MAP_BASE_URL = (
    (import.meta.env.VITE_MAP_BASE_URL as string | undefined) ?? "/njdot/map"
).replace(/\/+$/, "")

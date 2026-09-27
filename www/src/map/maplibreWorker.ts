/** maplibre-gl 6 loads its worker from `./maplibre-gl-worker.mjs` next to its own module, which
 *  doesn't exist once Vite renames and bundles that module. Point it at a Vite-built worker chunk
 *  (the worker imports `maplibre-gl-shared.mjs`, so a plain `?url` asset would 404 on that). */
import { setWorkerUrl } from "maplibre-gl"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"

setWorkerUrl(workerUrl)

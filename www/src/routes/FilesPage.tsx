/** `/files/*` — `<FileTree>` from `@rdub/file-tree`, parallel to `/raw/*`.
 *
 *  Validates the storage-agnostic `Store` abstraction using the same R2
 *  bucket as `/raw/*`. Plugs in the file-tree lib's parquet preview slot
 *  via `<ParquetViewer>` (shared with `/raw/*`). */
import { useMemo } from "react"
import { FileTree } from "@rdub/file-tree/react"
import { HttpStore } from "@rdub/file-tree/stores/http"
import { CELLS_API_BASE } from "../map/config"
import { ParquetViewer } from "../lib/ParquetViewer"

export default function FilesPage() {
    const store = useMemo(() => HttpStore(`${CELLS_API_BASE}/v1/files`), [])
    return (
        <div style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "1em 1.5em",
            fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
            <FileTree
                store={store}
                routeBase="/files"
                rootPrefix="raw/"
                title="Files (PoC: @rdub/file-tree)"
                parquetRenderer={ParquetViewer}
            />
        </div>
    )
}

// Browser-compatible path utilities

export function basename(path: string, ext?: string): string {
    let base = path.split('/').pop() || path
    if (ext && base.endsWith(ext)) {
        base = base.slice(0, -ext.length)
    }
    return base
}

export function dirname(path: string): string {
    const parts = path.split('/')
    parts.pop()
    return parts.join('/') || '.'
}

export function join(...parts: string[]): string {
    return parts.join('/').replace(/\/+/g, '/')
}

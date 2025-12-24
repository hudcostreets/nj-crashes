// Vite replacement for @rdub/next-base/basePath
// In Vite, base path is configured in vite.config.ts and available via import.meta.env.BASE_URL
export function getBasePath(): string {
    return import.meta.env.BASE_URL.replace(/\/$/, '') || ''
}

import { useAction } from "use-kbd"

/** `g d` — toggle the current URL's host between the local dev server
 *  (`localhost:4006`) and prod (`crashes.hudcostreets.org`). Preserves
 *  path, query, and hash. Chooses the "other" side based on the
 *  current hostname: any localhost/127.0.0.1/tailscale IP → prod;
 *  anything else → dev. Registered at `App` level so every route
 *  inherits it. */
const DEV_ORIGIN  = "http://localhost:4006"
const PROD_ORIGIN = "https://crashes.hudcostreets.org"

function isDevHost(host: string): boolean {
    return host === "localhost"
        || host === "127.0.0.1"
        || host.endsWith(".local")
        // Tailscale (typical 100.64/10 net) — treat as dev
        || /^100\.\d+\.\d+\.\d+$/.test(host)
}

export function useDomainToggle(): void {
    useAction("nav:toggleDomain", {
        label: "Toggle dev ⇄ prod",
        group: "Navigation",
        defaultBindings: ["g d"],
        handler: () => {
            const { hostname, pathname, search, hash } = window.location
            const target = isDevHost(hostname) ? PROD_ORIGIN : DEV_ORIGIN
            window.location.href = `${target}${pathname}${search}${hash}`
        },
    })
}

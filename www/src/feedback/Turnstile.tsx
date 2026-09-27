/** Cloudflare Turnstile widget (explicit render, `interaction-only`: invisible
 *  unless Cloudflare decides to challenge). Loads the script on first use. */
import { useEffect, useRef } from "react"

type TurnstileApi = {
    render: (el: HTMLElement, opts: Record<string, unknown>) => string
    remove: (id: string) => void
    reset: (id: string) => void
}

declare global {
    interface Window {
        turnstile?: TurnstileApi
    }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

let scriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile)
    if (!scriptPromise) {
        scriptPromise = new Promise((resolve, reject) => {
            const s = document.createElement("script")
            s.src = SCRIPT_URL
            s.async = true
            s.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing after load"))
            s.onerror = () => {
                scriptPromise = null
                reject(new Error("failed to load Turnstile"))
            }
            document.head.appendChild(s)
        })
    }
    return scriptPromise
}

export function Turnstile({
    siteKey,
    theme,
    onToken,
    resetKey,
}: {
    siteKey: string
    theme: "light" | "dark"
    onToken: (token: string | null) => void
    /** Change to force a fresh challenge (tokens are single-use). */
    resetKey?: number
}) {
    const ref = useRef<HTMLDivElement | null>(null)
    const onTokenRef = useRef(onToken)
    onTokenRef.current = onToken
    useEffect(() => {
        let id: string | null = null
        let cancelled = false
        onTokenRef.current(null)
        loadTurnstile().then(api => {
            if (cancelled || !ref.current) return
            id = api.render(ref.current, {
                sitekey: siteKey,
                theme,
                appearance: "interaction-only",
                action: "feedback",
                callback: (token: string) => onTokenRef.current(token),
                "expired-callback": () => onTokenRef.current(null),
                "error-callback": () => onTokenRef.current(null),
            })
        }).catch(err => console.warn("feedback:", err))
        return () => {
            cancelled = true
            if (id && window.turnstile) window.turnstile.remove(id)
        }
    }, [siteKey, theme, resetKey])
    return <div ref={ref} />
}

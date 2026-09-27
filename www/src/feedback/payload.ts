/** Feedback report wire shape + client-side validation. Mirrors
 *  `api/src/feedback/schema.ts` (the worker re-validates everything). */
import type { ActionEntry } from "./actionLog"

export const LIMITS = {
    comment: 5000,
    email: 254,
    actions: 100,
} as const

export type FeedbackForm = {
    comment: string
    email: string
    includeScreenshot: boolean
}

export type ReportContext = {
    viewport: { w: number; h: number; dpr: number }
    ua: string
    theme: string
    actualTheme: string
    buildSha: string | null
    tz: string | null
    ts: number
}

export type FeedbackReport = {
    v: 1
    comment: string
    email: string | null
    url: string
    context: ReportContext
    actions: ActionEntry[]
    turnstileToken: string | null
}

export type FormErrors = {
    comment?: string
    email?: string
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateForm(
    f: Pick<FeedbackForm, "comment" | "email">,
    max: { comment: number; email: number } = LIMITS,
): FormErrors {
    const errors: FormErrors = {}
    const comment = f.comment.trim()
    if (!comment) errors.comment = "Please describe the issue."
    else if (comment.length > max.comment) errors.comment = `Please keep it under ${max.comment.toLocaleString()} characters (currently ${comment.length.toLocaleString()}).`
    const email = f.email.trim()
    if (email && (email.length > max.email || !EMAIL_RE.test(email))) errors.email = "That doesn't look like an email address."
    return errors
}

export const isValid = (e: FormErrors) => !e.comment && !e.email

export function buildReport({
    form,
    href,
    context,
    actions,
    turnstileToken,
}: {
    form: Pick<FeedbackForm, "comment" | "email">
    href: string
    context: ReportContext
    actions: ActionEntry[]
    turnstileToken: string | null
}): FeedbackReport {
    return {
        v: 1,
        comment: form.comment.trim(),
        email: form.email.trim() || null,
        url: href,
        context,
        actions: actions.slice(-LIMITS.actions),
        turnstileToken,
    }
}

/** Build SHA injected by `vite.config.ts` (`git rev-parse`), if any. */
export const BUILD_SHA: string | null = (import.meta.env.VITE_BUILD_SHA as string | undefined) || null

export function collectContext(theme: string, actualTheme: string, now = Date.now()): ReportContext {
    let tz: string | null = null
    try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
    } catch { /* old browsers: leave null */ }
    return {
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        ua: navigator.userAgent,
        theme,
        actualTheme,
        buildSha: BUILD_SHA,
        tz,
        ts: now,
    }
}

/** Multipart body: `report` JSON + optional `screenshot` file. */
export function toFormData(report: FeedbackReport, screenshot: Blob | null): FormData {
    const fd = new FormData()
    fd.append("report", JSON.stringify(report))
    if (screenshot) {
        const ext = screenshot.type === "image/webp" ? "webp" : screenshot.type === "image/png" ? "png" : "jpg"
        fd.append("screenshot", new File([screenshot], `screenshot.${ext}`, { type: screenshot.type }))
    }
    return fd
}

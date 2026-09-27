/** The "Report an issue" form (lazy-loaded by `Feedback.tsx`). */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { apiUrl } from "@/src/api"
import { useTheme } from "@/src/contexts/ThemeContext"
import { actionLog, IGNORE_ATTR } from "./actionLog"
import { useFeedback } from "./context"
import { buildReport, collectContext, isValid, LIMITS, toFormData, validateForm, type FeedbackReport } from "./payload"
import { Turnstile } from "./Turnstile"
import css from "./Feedback.module.scss"

type FeedbackConfig = {
    turnstileSiteKey: string | null
}

async function fetchConfig(): Promise<FeedbackConfig> {
    const res = await fetch(apiUrl("/v1/feedback/config"))
    if (!res.ok) throw new Error(`config ${res.status}`)
    return res.json()
}

async function submit({ report, screenshot }: { report: FeedbackReport; screenshot: Blob | null }): Promise<{ id: string }> {
    const res = await fetch(apiUrl("/v1/feedback"), { method: "POST", body: toFormData(report, screenshot) })
    const body = await res.json().catch(() => ({})) as { id?: string; error?: string }
    if (!res.ok || !body.id) throw new Error(body.error ?? `HTTP ${res.status}`)
    return { id: body.id }
}

const fmtBytes = (n: number) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export default function FeedbackDialog() {
    const { closeFeedback, form, setForm, resetForm, shot, recapture, buttonHidden, setButtonHidden } = useFeedback()
    const { theme, actualTheme } = useTheme()
    const [touched, setTouched] = useState(false)
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
    const [turnstileReset, setTurnstileReset] = useState(0)

    // Snapshot of what's attached, taken when the form opens (so the
    // "what's included" list matches what's sent).
    const [actions] = useState(() => actionLog.entries())
    const href = window.location.href

    const config = useQuery({ queryKey: ["feedback-config"], queryFn: fetchConfig, retry: 1, staleTime: 5 * 60_000 })
    const siteKey = config.data?.turnstileSiteKey ?? null

    const mutation = useMutation({
        mutationFn: submit,
        onSuccess: () => resetForm(),
        // Turnstile tokens are single-use: get a fresh one for a retry.
        onError: () => setTurnstileReset(n => n + 1),
    })

    const errors = useMemo(() => validateForm(form), [form])
    const shotReady = shot.status === "ready"
    const waitingOnTurnstile = !!siteKey && !turnstileToken

    const onSubmit = useCallback((e?: FormEvent) => {
        e?.preventDefault()
        setTouched(true)
        if (!isValid(errors) || mutation.isPending || waitingOnTurnstile) return
        const report = buildReport({
            form,
            href,
            context: collectContext(theme, actualTheme),
            actions,
            turnstileToken,
        })
        mutation.mutate({ report, screenshot: form.includeScreenshot && shot.status === "ready" ? shot.blob : null })
    }, [errors, mutation, waitingOnTurnstile, form, href, theme, actualTheme, actions, turnstileToken, shot])

    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation()
                closeFeedback()
            }
        }
        window.addEventListener("keydown", onKey, true)
        return () => window.removeEventListener("keydown", onKey, true)
    }, [closeFeedback])

    const onTextKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit()
    }

    const url = new URL(href)
    const done = mutation.isSuccess

    return createPortal(
        <div
            className={css.backdrop}
            {...{ [IGNORE_ATTR]: "" }}
            onMouseDown={e => { if (e.target === e.currentTarget) closeFeedback() }}
        >
            <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="feedback-title">
                <div className={css.header}>
                    <h2 id="feedback-title">Report an issue</h2>
                    <button type="button" className={css.close} aria-label="Close" onClick={closeFeedback}>×</button>
                </div>
                {done ? (
                    <div className={css.thanks}>
                        <p>Thanks! Your report was sent.</p>
                        <p className={css.muted}>Reference: <code>{mutation.data.id.slice(0, 8)}</code></p>
                        <div className={css.buttons}>
                            <span className={css.spacer} />
                            <button type="button" className={css.primary} onClick={closeFeedback} autoFocus>Close</button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} noValidate>
                        <label className={css.field}>
                            <span>What happened? <span className={css.muted}>(required)</span></span>
                            <textarea
                                autoFocus
                                rows={5}
                                maxLength={LIMITS.comment + 100}
                                value={form.comment}
                                placeholder="What looks wrong, or what did you expect to see?"
                                onChange={e => setForm({ ...form, comment: e.target.value })}
                                onKeyDown={onTextKeyDown}
                                aria-invalid={touched && !!errors.comment}
                            />
                            {touched && errors.comment && <span className={css.error}>{errors.comment}</span>}
                        </label>
                        <label className={css.field}>
                            <span>Email <span className={css.muted}>(optional, if you'd like a reply)</span></span>
                            <input
                                type="email"
                                autoComplete="email"
                                value={form.email}
                                placeholder="you@example.com"
                                onChange={e => setForm({ ...form, email: e.target.value })}
                                onKeyDown={onTextKeyDown}
                                aria-invalid={touched && !!errors.email}
                            />
                            {touched && errors.email && <span className={css.error}>{errors.email}</span>}
                        </label>
                        <div className={css.shot}>
                            <label className={css.check}>
                                <input
                                    type="checkbox"
                                    checked={form.includeScreenshot}
                                    onChange={e => setForm({ ...form, includeScreenshot: e.target.checked })}
                                />
                                Include a screenshot of this page
                            </label>
                            {form.includeScreenshot && (
                                <div className={css.preview}>
                                    {shot.status === "capturing" && <span className={css.muted}>Capturing screenshot…</span>}
                                    {shot.status === "error" && (
                                        <span className={css.error}>
                                            Screenshot failed ({shot.error}).{" "}
                                            <button type="button" className={css.link} onClick={recapture}>Retry</button>
                                        </span>
                                    )}
                                    {shotReady && (
                                        <>
                                            <a href={shot.url} target="_blank" rel="noreferrer">
                                                <img src={shot.url} alt="Screenshot to be attached" />
                                            </a>
                                            <span className={css.muted}>{fmtBytes(shot.blob.size)}</span>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                        <details className={css.included}>
                            <summary>
                                Also included: this page's URL, your last {actions.length} action{actions.length === 1 ? "" : "s"} on
                                the site, and browser/screen size, theme, and site version.
                            </summary>
                            <dl>
                                <dt>URL</dt>
                                <dd><code>{url.pathname}{url.search}</code></dd>
                                <dt>Recent actions</dt>
                                <dd>
                                    {actions.length ? (
                                        <ol className={css.actions}>
                                            {actions.slice(-15).map((a, i) => (
                                                <li key={i}><span className={css.kind}>{a.kind}</span> {a.label}</li>
                                            ))}
                                        </ol>
                                    ) : "none"}
                                    {actions.length > 15 && <span className={css.muted}>(+{actions.length - 15} earlier)</span>}
                                </dd>
                                <dt>Browser</dt>
                                <dd>{window.innerWidth}×{window.innerHeight} @{window.devicePixelRatio}x, {actualTheme} theme</dd>
                            </dl>
                            <p className={css.muted}>No cookies or tracking; your email is only used to follow up on this report.</p>
                        </details>
                        {siteKey && (
                            <Turnstile siteKey={siteKey} theme={actualTheme} onToken={setTurnstileToken} resetKey={turnstileReset} />
                        )}
                        {mutation.isError && <p className={css.error}>Couldn't send: {mutation.error.message}</p>}
                        <div className={css.buttons}>
                            {!buttonHidden && (
                                <button type="button" className={css.link} onClick={() => setButtonHidden(true)}>
                                    Hide the feedback button
                                </button>
                            )}
                            <span className={css.spacer} />
                            <button type="button" onClick={closeFeedback}>Cancel</button>
                            <button
                                type="submit"
                                className={css.primary}
                                disabled={mutation.isPending || (touched && !isValid(errors)) || (form.includeScreenshot && shot.status === "capturing")}
                            >
                                {mutation.isPending ? "Sending…" : waitingOnTurnstile ? "Verifying…" : "Send"}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>,
        document.body,
    )
}

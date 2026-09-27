/** "Report an issue" flow: context + floating button + ⌘K actions.
 *
 *  - `<FeedbackProvider>` owns open/closed state, the in-progress draft, the
 *    screenshot (captured when the form opens), and the persisted
 *    "hide the floating button" preference.
 *  - `<FeedbackButton>` is the always-visible (unless hidden) button to the
 *    left of use-kbd's SpeedDial; `useFeedbackSpeedDialAction` adds the same
 *    entry inside the SpeedDial, so it stays reachable when the button's hidden.
 *  - `feedback:open` (`g f`) / `feedback:toggleButton` are ⌘K-searchable. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { MdClose, MdOutlineFeedback } from "react-icons/md"
import type { SpeedDialAction } from "use-kbd"
import { useAction } from "@/src/lib/kbd"
import { Tooltip } from "@/src/tooltip"
import { IGNORE_ATTR } from "./actionLog"
import type { FeedbackForm } from "./payload"
import { FeedbackContext, useFeedback, type FeedbackCtx, type Shot } from "./context"
import css from "./Feedback.module.scss"

const FeedbackDialog = lazy(() => import("./FeedbackDialog"))

export const OPEN_BINDING = "g f"
const HIDDEN_KEY = "nj-crashes-feedback-button-hidden"

const EMPTY_FORM: FeedbackForm = { comment: "", email: "", includeScreenshot: true }

function readHidden(): boolean {
    try {
        return localStorage.getItem(HIDDEN_KEY) === "1"
    } catch {
        return false
    }
}

/** Let an opening omnibar/SpeedDial close before the page is captured. */
const CAPTURE_DELAY_MS = 200

export function FeedbackProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false)
    const [buttonHidden, setHiddenState] = useState(readHidden)
    const [form, setForm] = useState<FeedbackForm>(EMPTY_FORM)
    const [shot, setShot] = useState<Shot>({ status: "idle" })
    const captureSeq = useRef(0)

    const setButtonHidden = useCallback((hidden: boolean) => {
        setHiddenState(hidden)
        try {
            if (hidden) localStorage.setItem(HIDDEN_KEY, "1")
            else localStorage.removeItem(HIDDEN_KEY)
        } catch { /* private mode etc.: in-memory only */ }
    }, [])

    const capture = useCallback(() => {
        const seq = ++captureSeq.current
        setShot(prev => {
            if (prev.status === "ready") URL.revokeObjectURL(prev.url)
            return { status: "capturing" }
        })
        setTimeout(() => {
            import("./screenshot")
                .then(m => m.captureScreenshot())
                .then(blob => {
                    if (seq !== captureSeq.current) return
                    setShot({ status: "ready", blob, url: URL.createObjectURL(blob) })
                })
                .catch(err => {
                    if (seq !== captureSeq.current) return
                    console.warn("feedback: screenshot failed", err)
                    setShot({ status: "error", error: err instanceof Error ? err.message : String(err) })
                })
        }, CAPTURE_DELAY_MS)
    }, [])

    const openRef = useRef(false)
    const openFeedback = useCallback(() => {
        if (openRef.current) return
        openRef.current = true
        setOpen(true)
        capture()
    }, [capture])

    const closeFeedback = useCallback(() => {
        captureSeq.current++
        openRef.current = false
        setOpen(false)
        setShot(prev => {
            if (prev.status === "ready") URL.revokeObjectURL(prev.url)
            return { status: "idle" }
        })
    }, [])

    const resetForm = useCallback(() => setForm(EMPTY_FORM), [])

    useAction("feedback:open", {
        label: "Report an issue",
        description: "Send feedback about this page (with an optional screenshot)",
        group: "Help",
        keywords: ["feedback", "bug", "issue", "problem", "report", "contact"],
        defaultBindings: [OPEN_BINDING],
        handler: openFeedback,
    })
    useAction("feedback:toggleButton", {
        label: buttonHidden ? "Show feedback button" : "Hide feedback button",
        group: "Help",
        keywords: ["feedback", "button", "hide", "show"],
        handler: () => setButtonHidden(!buttonHidden),
    })

    const value = useMemo<FeedbackCtx>(() => ({
        open, openFeedback, closeFeedback, buttonHidden, setButtonHidden, form, setForm, resetForm, shot, recapture: capture,
    }), [open, openFeedback, closeFeedback, buttonHidden, setButtonHidden, form, resetForm, shot, capture])

    return (
        <FeedbackContext.Provider value={value}>
            {children}
            {open && (
                <Suspense fallback={null}>
                    <FeedbackDialog />
                </Suspense>
            )}
        </FeedbackContext.Provider>
    )
}

/** Floating button left of the SpeedDial. Hover reveals a × to hide it
 *  (restorable from the SpeedDial / ⌘K). */
export function FeedbackButton() {
    const { openFeedback, buttonHidden, setButtonHidden, open } = useFeedback()
    // Warm the dialog chunk so the first open doesn't wait on it.
    useEffect(() => {
        const id = setTimeout(() => { void import("./FeedbackDialog") }, 3000)
        return () => clearTimeout(id)
    }, [])
    if (buttonHidden || open) return null
    return (
        <div className={css.fab} {...{ [IGNORE_ATTR]: "" }}>
            <Tooltip title={`Report an issue (${OPEN_BINDING})`} placement="top">
                <button type="button" className={css.fabButton} aria-label="Report an issue" onClick={openFeedback}>
                    <MdOutlineFeedback />
                </button>
            </Tooltip>
            <Tooltip title="Hide this button (still in the ⌃ menu and ⌘K)" placement="top">
                <button type="button" className={css.fabHide} aria-label="Hide feedback button" onClick={() => setButtonHidden(true)}>
                    <MdClose />
                </button>
            </Tooltip>
        </div>
    )
}

export function useFeedbackSpeedDialAction(): SpeedDialAction {
    const { openFeedback } = useFeedback()
    return useMemo(() => ({
        key: "feedback",
        label: "Report an issue",
        icon: <MdOutlineFeedback />,
        onClick: openFeedback,
    }), [openFeedback])
}

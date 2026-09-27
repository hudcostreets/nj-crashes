/** Feedback context, in its own module so HMR of the components doesn't
 *  mint a second context object. */
import { createContext, useContext } from "react"
import type { FeedbackForm } from "./payload"

export type Shot =
    | { status: "idle" }
    | { status: "capturing" }
    | { status: "ready"; blob: Blob; url: string }
    | { status: "error"; error: string }

export type FeedbackCtx = {
    open: boolean
    openFeedback: () => void
    closeFeedback: () => void
    buttonHidden: boolean
    setButtonHidden: (hidden: boolean) => void
    form: FeedbackForm
    setForm: (f: FeedbackForm) => void
    resetForm: () => void
    shot: Shot
    recapture: () => void
}

export const FeedbackContext = createContext<FeedbackCtx | null>(null)

export function useFeedback(): FeedbackCtx {
    const c = useContext(FeedbackContext)
    if (!c) throw new Error("useFeedback must be used within <FeedbackProvider>")
    return c
}

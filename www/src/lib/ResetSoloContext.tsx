import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

type ResetSoloContextType = {
    /** Monotonic counter — increments on each global "unpin all" */
    resetCount: number
    /** Fire a global unpin-all signal */
    resetAll: () => void
}

const ResetSoloContext = createContext<ResetSoloContextType>({ resetCount: 0, resetAll: () => {} })

export function ResetSoloProvider({ children }: { children: React.ReactNode }) {
    const [resetCount, setResetCount] = useState(0)
    const resetAll = useCallback(() => setResetCount(c => c + 1), [])
    return (
        <ResetSoloContext.Provider value={{ resetCount, resetAll }}>
            {children}
        </ResetSoloContext.Provider>
    )
}

/**
 * Subscribe to global "unpin all" signals. Calls `onReset` whenever a reset fires.
 * Skips the initial mount (only reacts to changes).
 */
export function useResetSolo(onReset: () => void) {
    const { resetCount } = useContext(ResetSoloContext)
    // Track the last-observed count rather than a "mounted" flag. StrictMode
    // (dev) re-invokes effects after cleanup, which with a mounted flag would
    // spuriously fire onReset on remount even though resetCount didn't change.
    const lastCountRef = useRef(resetCount)
    useEffect(() => {
        if (resetCount === lastCountRef.current) return
        lastCountRef.current = resetCount
        onReset()
    }, [resetCount])
}

/**
 * Get the resetAll function for firing global unpin signals.
 */
export function useResetAllSolo() {
    return useContext(ResetSoloContext).resetAll
}

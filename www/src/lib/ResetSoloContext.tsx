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
    const mountedRef = useRef(false)
    useEffect(() => {
        if (!mountedRef.current) {
            mountedRef.current = true
            return
        }
        onReset()
    }, [resetCount])
}

/**
 * Get the resetAll function for firing global unpin signals.
 */
export function useResetAllSolo() {
    return useContext(ResetSoloContext).resetAll
}

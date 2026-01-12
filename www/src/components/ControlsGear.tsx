import { ReactNode, useRef } from "react"
import css from "./ControlsGear.module.scss"

export type ControlsGearProps = {
    open: boolean
    onToggle: (open: boolean) => void
    children: ReactNode
    /** Optional class name for the content wrapper */
    contentClassName?: string
}

export function ControlsGear({ open, onToggle, children, contentClassName }: ControlsGearProps) {
    const detailsRef = useRef<HTMLDetailsElement>(null)

    return (
        <details
            ref={detailsRef}
            className={css.controls}
            open={open}
            onToggle={e => {
                // Only handle toggle events from this element, not nested details
                if (e.target === detailsRef.current) {
                    onToggle((e.target as HTMLDetailsElement).open)
                }
            }}
        >
            <summary><span className={css.settingsGear}>⚙️</span></summary>
            <div className={contentClassName ?? css.controlsContent}>
                {children}
            </div>
        </details>
    )
}

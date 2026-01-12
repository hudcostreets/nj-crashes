import { ReactNode, useRef } from "react"
import css from "./ControlsGear.module.scss"

export type ControlsGearProps = {
    open: boolean
    onToggle: (open: boolean) => void
    children: ReactNode
    /** Optional class name for the content wrapper */
    contentClassName?: string
    /** Optional element to render next to the gear icon (e.g., info icon) */
    extra?: ReactNode
    /** Set to true when the plot has a horizontal legend below - adds space to clear it */
    bottomLegend?: boolean
    /** Set to true to align gear vertically with a bottom legend (pulls gear up) */
    inlineWithLegend?: boolean
}

export function ControlsGear({ open, onToggle, children, contentClassName, extra, bottomLegend, inlineWithLegend }: ControlsGearProps) {
    const detailsRef = useRef<HTMLDetailsElement>(null)

    return (
        <div className={`${css.controlsWrapper} ${bottomLegend ? css.bottomLegend : ''} ${inlineWithLegend ? css.inlineWithLegend : ''}`}>
            <div className={css.controlsHeader}>
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
                </details>
                {extra}
            </div>
            {open && (
                <div className={contentClassName ?? css.controlsContent}>
                    {children}
                </div>
            )}
        </div>
    )
}

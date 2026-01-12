import { ReactNode } from "react"
import css from "./ControlsGear.module.scss"

export type ControlsGearProps = {
    open: boolean
    onToggle: (open: boolean) => void
    children: ReactNode
    /** Optional class name for the content wrapper */
    contentClassName?: string
}

export function ControlsGear({ open, onToggle, children, contentClassName }: ControlsGearProps) {
    return (
        <details
            className={css.controls}
            open={open}
            onToggle={e => onToggle((e.target as HTMLDetailsElement).open)}
        >
            <summary><span className={css.settingsGear}>⚙️</span></summary>
            <div className={contentClassName ?? css.controlsContent}>
                {children}
            </div>
        </details>
    )
}

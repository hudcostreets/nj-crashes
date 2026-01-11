import React, { ReactNode } from "react"
import css from "@/src/home.module.scss"

export type PlotContainerProps = {
    children: ReactNode
    showHr?: boolean
}

export function PlotContainer({ children, showHr = true }: PlotContainerProps) {
    return (
        <div className={css["plot-container"]}>
            {children}
            {showHr && <hr />}
        </div>
    )
}

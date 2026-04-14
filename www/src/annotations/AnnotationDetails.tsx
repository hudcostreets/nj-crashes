import { useCallback, useState } from "react"
import { useResetSolo } from "@/src/lib/ResetSoloContext"
import type { Annotation } from "./types"
import css from "./Annotation.module.scss"

const ICON: Record<Annotation['severity'], string> = {
    warning: '⚠',
    caveat: '⚑',
    info: 'ⓘ',
}

/** Shared state for an annotation trigger+body pair. */
export type AnnotationOpenState = {
    hovered: boolean
    setHovered: (v: boolean) => void
    pinned: boolean
    setPinned: (v: boolean) => void
    open: boolean
}

export function useAnnotationOpenState(externalHover?: boolean): AnnotationOpenState {
    const [hovered, setHovered] = useState(false)
    const [pinned, setPinned] = useState(false)
    useResetSolo(useCallback(() => {
        setPinned(false)
        setHovered(false)
    }, []))
    const open = !!externalHover || hovered || pinned
    return { hovered, setHovered, pinned, setPinned, open }
}

/** Small inline trigger — severity icon + disclosure chevron. Placed next to
 *  the gear (plot) or below the table. Click to pin the body open; hovering
 *  the icon itself does NOT expand the body (only hovering the associated
 *  plot bars / table rows does). */
export function AnnotationTrigger({
    annotations,
    state,
}: {
    annotations: Annotation[]
    state: AnnotationOpenState
}) {
    if (annotations.length === 0) return null
    const first = annotations[0]
    return (
        <button
            type="button"
            className={`${css.trigger} ${css[first.severity]} ${state.open ? css.open : ''} ${state.pinned ? css.pinned : ''}`}
            aria-label={first.title}
            aria-expanded={state.open}
            title={state.pinned ? `${first.title} — click to unpin` : `${first.title} — click to pin`}
            onClick={() => state.setPinned(!state.pinned)}
        >
            <span className={css.triggerIcon}>{ICON[first.severity]}</span>
            <span className={css.triggerChevron} aria-hidden>{state.open ? '▾' : '▸'}</span>
        </button>
    )
}

/** Body-only panel for annotations. Renders below the plot/table when open. */
export function AnnotationBody({
    annotations,
    state,
    alwaysOpen,
}: {
    annotations: Annotation[]
    state?: AnnotationOpenState
    /** If true, ignore `state` and render the body unconditionally. */
    alwaysOpen?: boolean
}) {
    if (annotations.length === 0) return null
    const visible = alwaysOpen || state?.open
    if (!visible) return null
    return (
        <div
            className={css.bodyWrap}
            onMouseEnter={() => state?.setHovered(true)}
            onMouseLeave={() => state?.setHovered(false)}
        >
            {annotations.map(a => (
                <div key={a.id} className={`${css.bodyPanel} ${css[a.severity]}`}>
                    <div className={css.bodyHeader}>
                        <span className={css.bodyIcon}>{ICON[a.severity]}</span>
                        <span className={css.bodyTitle}>{a.title}</span>
                        {state?.pinned && (
                            <button
                                type="button"
                                className={css.bodyUnpin}
                                onClick={() => state.setPinned(false)}
                                title="Unpin"
                            >✕</button>
                        )}
                    </div>
                    <div className={css.bodyText}>
                        {a.body.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}
                        {a.refs.length > 0 && (
                            <ul className={css.bodyRefs}>
                                {a.refs.map((r, i) => (
                                    <li key={i}>
                                        <a href={r.url} target="_blank" rel="noreferrer">{r.label}</a>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className={css.bodyMeta}>
                            Note by {a.authored.author} · {a.authored.date}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

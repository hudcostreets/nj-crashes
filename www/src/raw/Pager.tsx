/** Theme-aware pagination buttons + jump-to-page input. Used by both
 *  `<TextViewer>` and `<ParquetTable>`. Native <button> with `disabled`
 *  was rendering with browser-default chrome that didn't fit the dark
 *  theme. */

const navButtonStyle = (disabled: boolean): React.CSSProperties => ({
    padding: "0.2em 0.6em",
    borderRadius: 4,
    border: "1px solid rgba(127,127,127,0.4)",
    background: disabled ? "rgba(127,127,127,0.05)" : "rgba(127,127,127,0.15)",
    color: disabled ? "rgba(127,127,127,0.5)" : "inherit",
    cursor: disabled ? "default" : "pointer",
    fontSize: "0.85em",
    fontFamily: "inherit",
})

export function NavButton({
    disabled, onClick, children,
}: {
    disabled: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            disabled={disabled}
            onClick={onClick}
            style={navButtonStyle(disabled)}
        >
            {children}
        </button>
    )
}

export function Pager({
    page, pages, setPage, label, jump = true,
}: {
    page: number
    pages: number
    setPage: (n: number) => void
    /** Middle-area label, e.g. "page 3 / 35 · rows 400–600 / 6,931". */
    label: React.ReactNode
    /** Show the jump-to-page input (right side). */
    jump?: boolean
}) {
    return (
        <div style={{
            display: "flex", gap: "0.5em", alignItems: "center",
            marginBottom: "0.5em", fontSize: "0.9em", opacity: 0.95,
        }}>
            <NavButton disabled={page === 0} onClick={() => setPage(0)}>« first</NavButton>
            <NavButton disabled={page === 0} onClick={() => setPage(page - 1)}>‹ prev</NavButton>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{label}</span>
            <NavButton disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>next ›</NavButton>
            <NavButton disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>last »</NavButton>
            {jump && (
                <input
                    type="number" min={1} max={pages}
                    value={page + 1}
                    onChange={e => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 1 && v <= pages) setPage(v - 1)
                    }}
                    style={{
                        width: "5em", marginLeft: "auto",
                        padding: "0.2em 0.4em",
                        borderRadius: 4,
                        border: "1px solid rgba(127,127,127,0.4)",
                        background: "rgba(127,127,127,0.08)",
                        color: "inherit",
                        fontFamily: "inherit",
                    }}
                />
            )}
        </div>
    )
}

export type Props = {
    value: number
    min: number
    max: number
    onChange: (y: number) => void
    theme: "light" | "dark"
}

export function YearSelect({ value, min, max, onChange, theme }: Props) {
    const bg = theme === "dark" ? "#2a2a2a" : "#fff"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const border = `1px solid ${theme === "dark" ? "#444" : "#ccc"}`
    const opts: number[] = []
    for (let y = min; y <= max; y++) opts.push(y)
    return (
        <select
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            style={{
                background: bg, color: fg, border, borderRadius: 3,
                padding: "1px 4px", fontSize: "0.95em",
            }}
        >
            {opts.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
    )
}

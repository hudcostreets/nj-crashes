import { ReactNode } from "react"
import css from "./controls.module.css"

type CheckboxData<T> = {
    name: string
    label?: ReactNode
    data: T
    checked?: boolean
    disabled?: boolean
    color?: string
}

export function Checklist<T>({
    label,
    data,
    cb,
    nowrap = true,
}: {
    label: string | ReactNode
    data: CheckboxData<T>[]
    cb: (ts: T[]) => void
    nowrap?: boolean
}) {
    const state: { [name: string]: { data: T; checked: boolean } } = Object.fromEntries(
        data.map(({ name, data, checked }) => [
            name,
            { data, checked: checked ?? false },
        ])
    )

    function onChange(e: React.ChangeEvent<HTMLInputElement>) {
        const name = e.target.value
        const checked = e.target.checked
        const { data: datum } = state[name]
        const newState = { ...state }
        newState[name] = { data: datum, checked }
        const checkeds = Object.keys(newState)
            .filter((name) => newState[name].checked)
            .map((name) => newState[name].data)
        cb(checkeds)
    }

    const labels = data.map((d) => {
        const { name, label: itemLabel, disabled, color } = d
        const checked = state[name].checked
        return (
            <label key={name} className={nowrap ? css.nowrap : ""}>
                <input
                    type="checkbox"
                    name={name}
                    value={name}
                    checked={checked}
                    disabled={disabled}
                    onChange={onChange}
                />
                {color && <span style={{ color, fontWeight: 'bold' }}>■ </span>}
                {itemLabel ?? name}
            </label>
        )
    })

    return (
        <div className={css.control}>
            <div className={css.controlHeader}>{label}</div>
            <div className={css.subControl}>{labels}</div>
        </div>
    )
}

import { ReactNode } from "react"
import css from "./controls.module.css"

type Option<T> = {
    label?: string | ReactNode
    data: T
    disabled?: boolean
}

export function Radios<T extends string>({
    label,
    name: groupName,
    options,
    choice,
    cb,
    nowrap = true,
}: {
    label: string | ReactNode
    name: string
    options: (Option<T> | T)[]
    choice: T
    cb: (choice: T) => void
    nowrap?: boolean
}) {
    const labels = options.map((option) => {
        const { label: text, data: value, disabled } =
            typeof option === "string"
                ? { label: option, data: option, disabled: false }
                : option
        return (
            <label key={value} className={nowrap ? css.nowrap : ""}>
                <input
                    type="radio"
                    name={groupName}
                    value={value}
                    checked={value === choice}
                    disabled={disabled}
                    onChange={() => cb(value)}
                />
                {text ?? value}
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

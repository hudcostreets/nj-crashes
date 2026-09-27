/** In-memory log of recent user actions, attached to feedback reports.
 *
 *  Fed by `ActionLogRecorder` (route/param changes, clicks on controls) and
 *  the `useAction`/`useActions` wrappers in `lib/kbd.ts` (use-kbd actions,
 *  whether fired by hotkey or ⌘K). Never persisted; lost on reload. */

/** Fixed-capacity FIFO: pushing past capacity drops the oldest entry. */
export class RingBuffer<T> {
    readonly capacity: number
    private buf: T[] = []
    private start = 0

    constructor(capacity: number) {
        if (!(capacity > 0)) throw new Error(`RingBuffer capacity must be positive, got ${capacity}`)
        this.capacity = capacity
    }

    get size(): number {
        return this.buf.length
    }

    push(x: T): void {
        if (this.buf.length < this.capacity) {
            this.buf.push(x)
        } else {
            this.buf[this.start] = x
            this.start = (this.start + 1) % this.capacity
        }
    }

    /** Most recently pushed entry. */
    last(): T | undefined {
        if (!this.buf.length) return undefined
        return this.buf[(this.start + this.buf.length - 1) % this.buf.length]
    }

    /** Overwrite the most recent entry (no-op when empty). */
    replaceLast(x: T): void {
        if (!this.buf.length) return
        this.buf[(this.start + this.buf.length - 1) % this.buf.length] = x
    }

    /** Oldest first. */
    toArray(): T[] {
        return [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)]
    }

    clear(): void {
        this.buf = []
        this.start = 0
    }
}

export type ActionKind = "nav" | "param" | "action" | "click" | "change"

export type ActionEntry = {
    /** Epoch ms. */
    t: number
    kind: ActionKind
    label: string
}

export const ACTION_LOG_CAPACITY = 50
export const ACTION_LABEL_MAX = 200

type Logged = ActionEntry & { key?: string }

export class ActionLog {
    private ring: RingBuffer<Logged>

    constructor(capacity = ACTION_LOG_CAPACITY) {
        this.ring = new RingBuffer(capacity)
    }

    /** Append an entry. With `coalesceKey`, an entry that immediately follows
     *  one with the same key replaces it instead (e.g. `?llz=` updating on
     *  every map pan collapses to one entry until something else happens). */
    log(kind: ActionKind, label: string, opts: { coalesceKey?: string; now?: number } = {}): void {
        const { coalesceKey, now = Date.now() } = opts
        const entry: Logged = { t: now, kind, label: label.slice(0, ACTION_LABEL_MAX), ...(coalesceKey ? { key: coalesceKey } : {}) }
        if (coalesceKey && this.ring.last()?.key === coalesceKey) {
            this.ring.replaceLast(entry)
        } else {
            this.ring.push(entry)
        }
    }

    entries(): ActionEntry[] {
        return this.ring.toArray().map(({ t, kind, label }) => ({ t, kind, label }))
    }

    clear(): void {
        this.ring.clear()
    }
}

/** App-wide singleton. */
export const actionLog = new ActionLog()

export function logAction(kind: ActionKind, label: string, coalesceKey?: string): void {
    actionLog.log(kind, label, { coalesceKey })
}

const VAL_MAX = 60
const fmtVal = (v: string | null) => v === null ? "∅" : v.length > VAL_MAX ? `${v.slice(0, VAL_MAX)}…` : v

/** Per-key changes between two query strings, as `[key, "key: old → new"]`
 *  pairs sorted by key. Absent params render as `∅`. */
export function paramDiff(prev: string, next: string): [string, string][] {
    const a = new URLSearchParams(prev)
    const b = new URLSearchParams(next)
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
    const out: [string, string][] = []
    for (const k of keys) {
        const va = a.getAll(k).join(",") || (a.has(k) ? "" : null)
        const vb = b.getAll(k).join(",") || (b.has(k) ? "" : null)
        if (va !== vb) out.push([k, `${k}: ${fmtVal(va)} → ${fmtVal(vb)}`])
    }
    return out
}

/** Elements whose clicks are worth logging. */
export const CONTROL_SELECTOR = [
    "button", "a[href]", "summary",
    "input[type=checkbox]", "input[type=radio]",
    "[role=button]", "[role=tab]", "[role=menuitem]", "[role=option]",
    "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=link]",
].join(", ")

/** Subtrees marked with this attribute are skipped by the click logger (and
 *  excluded from screenshots): the feedback UI itself. */
export const IGNORE_ATTR = "data-feedback-ignore"

const collapse = (s: string) => s.replace(/\s+/g, " ").trim()

/** Human-readable description of the control a click landed on, or `null`
 *  when it didn't land on one (or landed in an ignored subtree). Uses
 *  accessible names / visible text only; never input values. */
export function describeControl(target: Element): string | null {
    if (target.closest(`[${IGNORE_ATTR}]`)) return null
    const el = target.closest(CONTROL_SELECTOR)
    if (!el) return null
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute("role")
    const type = tag === "input" ? (el as HTMLInputElement).type : null
    const kind = role ?? type ?? tag
    let name =
        el.getAttribute("aria-label") ??
        (el.getAttribute("aria-labelledby") && el.ownerDocument.getElementById(el.getAttribute("aria-labelledby")!)?.textContent) ??
        (type && el.closest("label")?.textContent) ??
        el.textContent ??
        ""
    name = collapse(name)
    if (!name) name = el.getAttribute("title") ?? el.getAttribute("data-testid") ?? (el.id ? `#${el.id}` : "")
    name = collapse(name).slice(0, 80)
    let desc = name ? `${kind} "${name}"` : kind
    if (tag === "a") {
        const href = el.getAttribute("href") ?? ""
        desc += ` → ${href.slice(0, 100)}`
    }
    if (type === "checkbox" || type === "radio" || role === "checkbox" || role === "switch") {
        const checked = type ? (el as HTMLInputElement).checked : el.getAttribute("aria-checked") === "true"
        desc += checked ? " (on)" : " (off)"
    }
    return desc
}

/** Description of a `<select>` change (clicks on selects are skipped: they
 *  only open the dropdown, and their text is every option). */
export function describeSelectChange(el: Element): string | null {
    if (!(el instanceof HTMLSelectElement) || el.closest(`[${IGNORE_ATTR}]`)) return null
    const name = collapse(el.getAttribute("aria-label") ?? el.closest("label")?.firstChild?.textContent ?? el.name ?? "")
    const opt = el.selectedOptions[0]
    const val = collapse(opt?.textContent ?? el.value).slice(0, 60)
    return name ? `select "${name.slice(0, 80)}" = ${val}` : `select = ${val}`
}

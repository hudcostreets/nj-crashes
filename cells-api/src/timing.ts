/** Per-request phase timings, emitted as a `Server-Timing` header so the
 *  browser's DevTools (Network → Timing) and Resource Timing's
 *  `serverTiming` show where a `/v1/cells` request spent its time.
 *
 *  Phases accumulate (`add` sums repeated names), because the pyramid path
 *  reads shards concurrently: `r2` is the summed wall time of every R2 range
 *  GET, which can exceed the request's wall clock. Workers freeze
 *  `Date.now()` between I/O events (Spectre mitigation), so CPU-only phases
 *  (decode, serialize) read 0 unless they straddle an I/O boundary — `total`
 *  minus the I/O phases is the honest CPU estimate. */
export class Timing {
    private phases = new Map<string, number>()
    private descs = new Map<string, string>()

    /** Add `ms` to phase `name` (created on first use, insertion-ordered). */
    add(name: string, ms: number, desc?: string): void {
        this.phases.set(name, (this.phases.get(name) ?? 0) + ms)
        if (desc !== undefined) this.descs.set(name, desc)
    }

    /** Attach a zero-duration marker (e.g. `cache;desc=hit`, `src;desc=pyramid`). */
    note(name: string, desc: string): void {
        if (!this.phases.has(name)) this.phases.set(name, 0)
        this.descs.set(name, desc)
    }

    /** Accumulate a counter (bytes, rows), rendered as `name;desc="<n>"`. */
    count(name: string, n: number): void {
        const prev = Number(this.descs.get(name) ?? 0)
        this.note(name, String(prev + n))
    }

    /** Time an async phase. */
    async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const t0 = Date.now()
        try {
            return await fn()
        } finally {
            this.add(name, Date.now() - t0)
        }
    }

    get(name: string): number | undefined {
        return this.phases.get(name)
    }

    /** `Server-Timing` header value, e.g. `r2;dur=412, decode;dur=88, cache;desc="miss"`. */
    header(): string {
        const parts: string[] = []
        for (const [name, dur] of this.phases) {
            const desc = this.descs.get(name)
            let p = `${name};dur=${Math.round(dur)}`
            if (desc !== undefined) p += `;desc="${desc.replace(/["\\]/g, "")}"`
            parts.push(p)
        }
        return parts.join(", ")
    }
}

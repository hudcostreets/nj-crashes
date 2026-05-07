/** Minimal CSV line parser. Handles quoted fields with embedded
 *  commas and escaped quotes (`""` → `"`). Does NOT handle multi-line
 *  quoted fields (a quote that opens on one line and closes on the
 *  next) — those are rare in NJDOT data and would require a streaming
 *  parser since byte-paginated chunks can split mid-row.
 *
 *  Trailing `\r` should be stripped by the caller before passing in. */
export function parseCsvLine(line: string): string[] {
    const out: string[] = []
    let cur = ""
    let inQuotes = false
    let i = 0
    while (i < line.length) {
        const c = line[i]
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i += 2; continue }
                inQuotes = false
                i++
            } else {
                cur += c
                i++
            }
        } else {
            if (c === ",") { out.push(cur); cur = ""; i++ }
            else if (c === '"' && cur === "") { inQuotes = true; i++ }
            else { cur += c; i++ }
        }
    }
    out.push(cur)
    return out
}

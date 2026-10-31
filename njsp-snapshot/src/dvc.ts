/**
 * `data/FAUQStats{year}.xml.dvc` read + update, byte-identical to
 * `njsp/cli/refresh_data.py:render_xml_dvc` (PyYAML `safe_load` → mutate →
 * `dump(sort_keys=False, default_flow_style=False)`).
 *
 * Rather than a full YAML round-trip, edits are applied line-wise to the
 * existing text. That's exact as long as the input is already in PyYAML's
 * canonical dump form (every `.dvc` refresh_data has touched is: it rewrites
 * the whole file each fetch; `njsp/tests/test_refresh_data.py` asserts all
 * committed `FAUQStats*.xml.dvc`s round-trip), and lets the folded
 * `user_agent` line pass through untouched. Golden-tested against the Python
 * writer (`test/fixtures/dvc-golden.json`).
 */

export type Headers_ = { etag?: string | null, lastModified?: string | null }

export type XmlDvc = {
  /** `deps[0].checksum` (the ETag recorded at last fetch) */
  etag?: string
  /** `deps[0].mtime` (ISO; Last-Modified at last fetch) */
  mtime?: string
  /** `outs[0].md5` */
  md5?: string
  /** `outs[0].size` */
  size?: number
}

// PyYAML (YAML 1.1) implicit resolvers: a str matching any of these must be quoted.
const IMPLICIT: RegExp[] = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:<<)$/,
  /^(?:~|null|Null|NULL|)$/,
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  /^(?:=)$/,
]

/** Emit a str scalar the way PyYAML's block-style emitter would (subset: single-line, printable ASCII). */
export function yamlStr(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) {
    throw new Error(`yamlStr: unsupported (non-printable-ASCII) scalar ${JSON.stringify(s)}`)
  }
  const first = s[0]
  const plain = !(
    IMPLICIT.some(re => re.test(s))
    || s.startsWith('---') || s.startsWith('...')
    || s.startsWith(' ') || s.endsWith(' ')
    || '#,[]{}&*!|>\'"%@`'.includes(first)
    || ('?:-'.includes(first) && (s.length === 1 || s[1] === ' '))
    || /: |:$/.test(s)
    || s.includes(' #')
  )
  return plain ? s : `'${s.replaceAll("'", "''")}'`
}

/** Python `email.utils.parsedate_to_datetime(lm).isoformat()` for an HTTP-date. */
export function httpDateToIso(lm: string): string {
  const m = lm.match(/^(?:\w{3}, )?(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|UTC|UT|Z|[+-]\d{4})$/)
  if (!m) throw new Error(`Unparseable Last-Modified: ${JSON.stringify(lm)}`)
  const [, d, mon, y, H, M, S, tz] = m
  const month = MONTHS.indexOf(mon) + 1
  if (!month) throw new Error(`Unparseable Last-Modified month: ${JSON.stringify(lm)}`)
  const p2 = (n: number | string) => String(n).padStart(2, '0')
  const base = `${y}-${p2(month)}-${p2(d)}T${H}:${M}:${S}`
  // Python treats `-0000` as "no tz info" → naive isoformat.
  if (tz === '-0000') return base
  const off = tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '+00:00'
  return `${base}${off}`
}

/** Epoch ms of an aware ISO datetime (as written by `httpDateToIso`), or undefined if naive / invalid. */
export function isoToEpoch(iso: string): number | undefined {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return undefined
  const t = Date.parse(iso)
  return isNaN(t) ? undefined : t
}

/** Epoch ms of an HTTP-date, or undefined. */
export function httpDateToEpoch(lm: string | null | undefined): number | undefined {
  if (!lm) return undefined
  try {
    return isoToEpoch(httpDateToIso(lm))
  } catch {
    return undefined
  }
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type Section = { key: string, start: number, end: number }

/** Top-level `key:` sections, as [start, end) line ranges (the key line included). */
function sections(lines: string[]): Section[] {
  const out: Section[] = []
  lines.forEach((line, i) => {
    const m = line.match(/^([A-Za-z_][\w-]*):/)
    if (m) {
      if (out.length) out[out.length - 1].end = i
      out.push({ key: m[1], start: i, end: lines.length })
    }
  })
  return out
}

/** [start, end) of the first `- ` list item in a top-level list section. */
function firstItem(lines: string[], sec: Section): { start: number, end: number } | undefined {
  let start: number | undefined
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (lines[i].startsWith('- ')) {
      if (start === undefined) start = i
      else return { start, end: i }
    }
  }
  return start === undefined ? undefined : { start, end: sec.end }
}

/** Key lines in a mapping whose keys sit at column `indent` (the first may carry a `- ` prefix). */
function keyLines(lines: string[], start: number, end: number, indent: number): Map<string, { line: number, end: number }> {
  const out = new Map<string, { line: number, end: number }>()
  const pad = ' '.repeat(indent)
  let prev: string | undefined
  for (let i = start; i < end; i++) {
    const line = lines[i]
    const body = i === start && line.startsWith('- ') ? line.slice(2) : line.startsWith(pad) ? line.slice(indent) : undefined
    const m = body !== undefined && !body.startsWith(' ') ? body.match(/^([A-Za-z_][\w-]*):(?: |$)/) : null
    if (m) {
      if (prev) out.get(prev)!.end = i
      out.set(m[1], { line: i, end })
      prev = m[1]
    }
  }
  return out
}

function scalarOf(line: string): string {
  const v = line.replace(/^(?:- )?\s*[\w-]+: ?/, '')
  if (v.startsWith("'")) return v.slice(1, -1).replaceAll("''", "'")
  return v
}

export function parseXmlDvc(text: string): XmlDvc {
  const lines = text.split('\n')
  const secs = sections(lines)
  const out: XmlDvc = {}
  const deps = secs.find(s => s.key === 'deps')
  const depItem = deps && firstItem(lines, deps)
  if (depItem) {
    const keys = keyLines(lines, depItem.start, depItem.end, 2)
    const c = keys.get('checksum')
    if (c) out.etag = scalarOf(lines[c.line])
    const m = keys.get('mtime')
    if (m) out.mtime = scalarOf(lines[m.line])
  }
  const outs = secs.find(s => s.key === 'outs')
  const outItem = outs && firstItem(lines, outs)
  if (outItem) {
    const keys = keyLines(lines, outItem.start, outItem.end, 2)
    const m = keys.get('md5')
    if (m) out.md5 = scalarOf(lines[m.line])
    const s = keys.get('size')
    if (s) out.size = Number(scalarOf(lines[s.line]))
  }
  return out
}

/**
 * Set `key: value` in the mapping [start, end) at `indent`: replace in place
 * (dropping any folded continuation lines) or append after the last key.
 */
function setKey(lines: string[], start: number, end: number, indent: number, key: string, value: string): void {
  const keys = keyLines(lines, start, end, indent)
  const existing = keys.get(key)
  const pad = ' '.repeat(indent)
  if (existing) {
    const prefix = existing.line === start && lines[start].startsWith('- ') ? '- ' : pad
    lines.splice(existing.line, existing.end - existing.line, `${prefix}${key}: ${value}`)
  } else {
    lines.splice(end, 0, `${pad}${key}: ${value}`)
  }
}

/** TS port of `render_xml_dvc`; `headers === null` ↔ Python `response=None`. */
export function renderXmlDvc(
  text: string,
  out: { md5: string, size: number },
  headers: Headers_ | null,
  fetched: string,
): string {
  if (!text.endsWith('\n')) throw new Error('renderXmlDvc: expected trailing newline')
  const lines = text.slice(0, -1).split('\n')
  const sec = (key: string) => sections(lines).find(s => s.key === key)

  const outs = sec('outs')
  const outItem = outs && firstItem(lines, outs)
  if (outItem) {
    setKey(lines, outItem.start, outItem.end, 2, 'md5', yamlStr(out.md5))
    const again = firstItem(lines, sec('outs')!)!
    setKey(lines, again.start, again.end, 2, 'size', String(out.size))
  }

  const deps = sec('deps')
  if (deps && headers !== null) {
    const item = () => firstItem(lines, sec('deps')!)!
    let it = item()
    setKey(lines, it.start, it.end, 2, 'size', String(out.size))
    if (headers.etag) {
      it = item()
      setKey(lines, it.start, it.end, 2, 'checksum', yamlStr(headers.etag))
    }
    if (headers.lastModified) {
      it = item()
      setKey(lines, it.start, it.end, 2, 'mtime', yamlStr(httpDateToIso(headers.lastModified)))
    }
  }

  const meta = sec('meta')
  if (meta) {
    const keys = keyLines(lines, meta.start + 1, meta.end, 2)
    const imp = keys.get('import')
    if (!imp) {
      lines.splice(meta.end, 0, '  import:', `    fetched: ${yamlStr(fetched)}`)
    } else {
      if (lines[imp.line] !== '  import:') {
        throw new Error(`renderXmlDvc: unsupported meta.import line ${JSON.stringify(lines[imp.line])}`)
      }
      setKey(lines, imp.line + 1, imp.end, 4, 'fetched', yamlStr(fetched))
    }
  }
  return lines.join('\n') + '\n'
}

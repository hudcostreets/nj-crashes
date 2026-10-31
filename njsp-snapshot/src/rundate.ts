import { MONTHS } from './dvc'

/** `<RUNDATE>` text from an FAUQStats XML (`refresh_data.parse_rundate`). */
export function parseRundate(xml: Uint8Array | string): string | undefined {
  const text = typeof xml === 'string' ? xml : new TextDecoder().decode(xml)
  const m = text.match(/<RUNDATE>([^<]+)<\/RUNDATE>/)
  return m ? m[1] : undefined
}

const RUNDATE_RE = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\w{3}) +(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2}) (?:EDT |EST )?(\d{4})$/

function rundateParts(rundate: string): { year: number, month: number, day: number } | undefined {
  const m = rundate.match(RUNDATE_RE)
  if (!m) return undefined
  const month = MONTHS.indexOf(m[1]) + 1
  if (!month) return undefined
  return { year: Number(m[6]), month, day: Number(m[2]) }
}

/** `refresh_data.rundate_short`: 'Thu Apr 09 10:00:01 EDT 2026' → '4/9' (input unchanged if unparseable). */
export function rundateShort(rundate: string): string {
  const p = rundateParts(rundate)
  return p ? `${p.month}/${p.day}` : rundate
}

/** RUNDATE's (ET, wall-clock) calendar date as `YYYY-MM-DD`. */
export function rundateDate(rundate: string): string | undefined {
  const p = rundateParts(rundate)
  if (!p) return undefined
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`
}

/** `refresh_data`'s commit message, from the current-year XML's RUNDATE (if any). */
export function commitMessage(currentYearRundate: string | undefined): string {
  return currentYearRundate ? `Refresh NJSP data (${rundateShort(currentYearRundate)})` : 'Refresh NJSP data'
}

export type EtParts = { year: number, date: string, hour: number }

/** Wall-clock date/hour in America/New_York. */
export function etParts(now: Date): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  return {
    year: Number(parts.year),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  }
}

/** `YYYY-MM-DD` ± `days`. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000
  return new Date(t).toISOString().slice(0, 10)
}

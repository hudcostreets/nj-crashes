/**
 * One cron tick: capture changed NJSP FAUQStats XMLs into Git (mirroring
 * `njsp refresh_data`), dispatch the daily, and raise dead-man alerts.
 * See `specs/njsp-snapshot-worker.md`.
 */
import { createHash } from 'node:crypto'

import { httpDateToEpoch, isoToEpoch, parseXmlDvc, renderXmlDvc, type XmlDvc } from './dvc'
import type { FileChange, Head, Person, Repo } from './github'
import { addDays, commitMessage, etParts, isRollback, parseRundate, rundateDate, rundateShort } from './rundate'

/** `refresh_data.UA` + request headers, so NJSP's WAF sees the same client as the daily. */
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
export const REQUEST_HEADERS: Record<string, string> = {
  Accept: 'text/xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent': UA,
}

export const xmlUrl = (year: number) => `https://njsp.njoag.gov/wp/wp-content/plugins/fatal-crash-data/xml/FAUQStats${year}.xml`
export const xmlPath = (year: number) => `data/FAUQStats${year}.xml`
export const dvcPath = (year: number) => `${xmlPath(year)}.dvc`

/** Small KV subset (Workers KV implements it; tests use a Map). */
export interface Kv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export type Alerter = (text: string) => Promise<void>

export type Config = {
  author: Person
  dryRun: boolean
  /** Dispatch the daily after a commit (off for the staging env, whose branch the daily mustn't build/deploy). */
  dispatch: boolean
  /** ET hour from which a missing same-day capture alerts (default 13). */
  alertHour: number
  /** Minutes a dispatched daily may take to conclude `success` before alerting. */
  dailyTimeoutMin: number
  /** Consecutive failed ticks before alerting. */
  errorThreshold: number
  /** Side branch for NJSP rollbacks (versions older than the main branch's); see `Deps.rollbackRepo`. */
  rollbackBranch: string
}

export const DEFAULT_CONFIG: Omit<Config, 'author' | 'dryRun'> = {
  dispatch: true,
  alertHour: 13,
  dailyTimeoutMin: 120,
  errorThreshold: 3,
  rollbackBranch: 'njsp-rollbacks',
}

/** Upstream version last seen per year (from a GET), so metadata-only bumps don't re-GET hourly. */
export type Observed = { etag?: string, lastModified?: string, md5: string, rundate?: string }

export type YearResult = {
  year: number
  /**
   * - `absent`: current-year file 404 upstream (January)
   * - `unchanged`: HEAD ETag/LM match `main`'s `.dvc` (refresh_data's skip rule)
   * - `meta`: ETag/LM moved but content identical (NJSP re-publishes all files daily)
   * - `content`: new XML content
   * - `rollback`: new content whose RUNDATE is older than `main`'s (NJSP re-published an old
   *   version): committed to `config.rollbackBranch` instead, `main` untouched
   */
  status: 'absent' | 'unchanged' | 'meta' | 'content' | 'rollback'
  rundate?: string
}

export type TickResult = {
  at: string
  /**
   * - `no-change`: no new content upstream
   * - `daily-running`: new content, but a `daily` run is queued/in progress → retry next tick
   * - `dry-run`: would have committed (DRY_RUN)
   * - `committed`: committed + dispatched the daily
   */
  outcome: 'no-change' | 'daily-running' | 'dry-run' | 'committed'
  years: YearResult[]
  message?: string
  sha?: string
  files?: string[]
  /** Rollback versions captured this tick, on `config.rollbackBranch`. */
  rollback?: { sha?: string, message: string, files: string[] }
}

export type State = {
  lastTick?: TickResult
  lastError?: { at: string, message: string }
  consecutiveErrors: number
  observed: Record<string, Observed>
  /** Last RUNDATE seen on `main` per year, keyed to the `.dvc`'s md5 (avoids re-reading the XML). */
  mainRundates: Record<string, { md5: string, rundate?: string }>
  dispatch?: { at: string, sha: string }
  alerts: string[]
  /** Last rollback captured per year: its md5, and `main`'s md5 at the time (re-capture if either moves). */
  rollbacks: Record<string, { md5: string, mainMd5: string }>
}

export const STATE_KEY = 'state'

export async function loadState(kv: Kv): Promise<State> {
  const raw = await kv.get(STATE_KEY)
  const init: State = { consecutiveErrors: 0, observed: {}, mainRundates: {}, alerts: [], rollbacks: {} }
  return raw ? { ...init, ...JSON.parse(raw) } : init
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

/** refresh_data's HEAD-skip rule: ETag equal, or Last-Modified equal as instants. */
/** Strong form of an ETag. Responses fetched through CF's network arrive compressed, so a GET's
 *  ETag comes back weakened (`W/"…"`) while HEAD's (and `refresh_data`'s, from the runner) don't. */
export function strongEtag(etag: string | null): string | null {
  return etag?.replace(/^W\//, '') ?? null
}

export function headMatches(prior: { etag?: string, mtime?: string }, etag: string | null, lastModified: string | null): boolean {
  if (etag && prior.etag && etag === prior.etag) return true
  const head = httpDateToEpoch(lastModified)
  const prv = prior.mtime ? isoToEpoch(prior.mtime) : undefined
  return head !== undefined && prv !== undefined && head === prv
}

export const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])

const enc = new TextEncoder()
const dec = new TextDecoder()

type Plan = {
  year: number
  status: YearResult['status']
  rundate?: string
  files: FileChange[]
  /** `rollback` not yet captured: files for the rollback branch. */
  rollbackFiles?: FileChange[]
  md5?: string
  mainMd5?: string
}

type Deps = {
  repo: Repo
  /** `config.rollbackBranch` (created from `repo`'s head on first use). */
  rollbackRepo: Repo
  upstream: typeof fetch
  kv: Kv
  alert: Alerter
  now: Date
  config: Config
  log?: (msg: string) => void
}

async function planYear(year: number, isCurrent: boolean, head: Head, state: State, fetched: string, d: Deps): Promise<Plan | undefined> {
  const { repo, upstream } = d
  const log = d.log ?? (() => {})
  let dvcText: string | undefined
  const dvcBytes = await repo.readFile(dvcPath(year), head.sha)
  if (dvcBytes) {
    dvcText = dec.decode(dvcBytes)
  } else {
    // New year: no `.dvc` yet (refresh_data would commit the bare XML). Seed one from the prior year's.
    const prv = await repo.readFile(dvcPath(year - 1), head.sha)
    if (!prv) {
      log(`${year}: no ${dvcPath(year)} or prior-year .dvc on main; skipping`)
      return undefined
    }
    dvcText = dec.decode(prv).replaceAll(`FAUQStats${year - 1}.xml`, `FAUQStats${year}.xml`)
  }
  const prior: XmlDvc = dvcBytes ? parseXmlDvc(dvcText) : {}

  const url = xmlUrl(year)
  const headRes = await upstream(url, { method: 'HEAD', headers: REQUEST_HEADERS, redirect: 'follow' })
  if (headRes.status === 404 && isCurrent) return { year, status: 'absent', files: [] }
  const etag = strongEtag(headRes.headers.get('ETag'))
  const lastModified = headRes.headers.get('Last-Modified')
  if (headRes.status === 200 && dvcBytes && headMatches(prior, etag, lastModified)) {
    return { year, status: 'unchanged', files: [] }
  }

  const obs = state.observed[year]
  const captured = (md5: string) => {
    const rb = state.rollbacks[year]
    return !!rb && rb.md5 === md5 && rb.mainMd5 === prior.md5
  }
  if (headRes.status === 200 && obs && captured(obs.md5) && observedMatches(obs, etag, lastModified)) {
    return { year, status: 'rollback', rundate: obs.rundate, files: [] }
  }
  if (headRes.status === 200 && obs && prior.md5 === obs.md5 && observedMatches(obs, etag, lastModified)) {
    // Already GET'd this upstream version: same bytes as `main`, only the headers moved.
    const dvc = renderXmlDvc(dvcText, { md5: prior.md5!, size: prior.size! }, { etag, lastModified }, fetched)
    return { year, status: 'meta', rundate: obs.rundate, files: [{ path: dvcPath(year), content: enc.encode(dvc) }] }
  }

  const res = await upstream(url, { method: 'GET', headers: REQUEST_HEADERS, redirect: 'follow' })
  if (res.status === 404 && isCurrent) return { year, status: 'absent', files: [] }
  if (res.status !== 200) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`)
  const ct = res.headers.get('Content-Type')
  if (ct !== 'text/xml') throw new Error(`Unexpected content type for ${url}: ${ct}`)
  const content = new Uint8Array(await res.arrayBuffer())
  const md5 = md5Hex(content)
  const rundate = parseRundate(content)
  const getEtag = strongEtag(res.headers.get('ETag'))
  const getLm = res.headers.get('Last-Modified')
  state.observed[year] = {
    ...(getEtag ? { etag: getEtag } : {}),
    ...(getLm ? { lastModified: getLm } : {}),
    md5,
    ...(rundate ? { rundate } : {}),
  }
  const dvc = renderXmlDvc(dvcText, { md5, size: content.length }, { etag: getEtag, lastModified: getLm }, fetched)
  const files: FileChange[] = [{ path: dvcPath(year), content: enc.encode(dvc) }]
  if (md5 === prior.md5) return { year, status: 'meta', rundate, files }
  if (dvcBytes && isRollback(rundate, await mainRundate(year, head, state, repo))) {
    if (captured(md5)) return { year, status: 'rollback', rundate, files: [] }
    return { year, status: 'rollback', rundate, files: [], rollbackFiles: [{ path: xmlPath(year), content }, ...files], md5, mainMd5: prior.md5 }
  }
  return { year, status: 'content', rundate, files: [{ path: xmlPath(year), content }, ...files] }
}

/** `headMatches`, against a previously-observed GET's headers (both HTTP-dates). */
export function observedMatches(obs: Observed, etag: string | null, lastModified: string | null): boolean {
  if (etag && obs.etag && etag === obs.etag) return true
  const head = httpDateToEpoch(lastModified)
  return head !== undefined && head === httpDateToEpoch(obs.lastModified)
}

async function mainRundate(year: number, head: Head, state: State, repo: Repo): Promise<string | undefined> {
  const dvcBytes = await repo.readFile(dvcPath(year), head.sha)
  if (!dvcBytes) return undefined
  const { md5 } = parseXmlDvc(dec.decode(dvcBytes))
  if (!md5) return undefined
  const cached = state.mainRundates[year]
  if (cached && cached.md5 === md5) return cached.rundate
  const xml = await repo.readFile(xmlPath(year), head.sha)
  const rundate = xml ? parseRundate(xml) : undefined
  state.mainRundates = { ...state.mainRundates, [year]: { md5, ...(rundate ? { rundate } : {}) } }
  return rundate
}

async function alertOnce(key: string, text: string, state: State, d: Deps): Promise<void> {
  if (state.alerts.includes(key)) return
  if (d.config.dryRun) {
    d.log?.(`[DRY_RUN] alert ${key}: ${text}`)
  } else {
    await d.alert(text)
  }
  state.alerts = [...state.alerts, key].slice(-50)
}

/**
 * Dead-man checks, after a *successful* capture step (a failing capture is
 * alerted via `errorThreshold` consecutive failed ticks in `runTick`):
 * (a) from `alertHour` ET, the current-year (prior-year while the current-year
 *     file 404s) RUNDATE — on `main`, which a successful tick has just synced
 *     to upstream — is older than yesterday, i.e. NJSP hasn't published for
 *     ≥2 days. Single skipped days are routine (~1/month, see spec) and not
 *     alerted. Skipped while `daily-running` (capture pending behind the daily);
 * (b) a dispatched daily hasn't concluded `success` within `dailyTimeoutMin`.
 */
async function checkAlerts(head: Head, tick: TickResult, state: State, d: Deps): Promise<void> {
  const { now, config, repo } = d
  const et = etParts(now)
  const { years, outcome } = tick

  if (et.hour >= config.alertHour && outcome !== 'daily-running') {
    const cur = years.find(y => y.year === et.year && y.status !== 'absent') ?? years.find(y => y.year === et.year - 1)
    if (cur) {
      const rundate = cur.status === 'unchanged' || cur.status === 'rollback' ? await mainRundate(cur.year, head, state, repo) : cur.rundate
      const date = rundate && rundateDate(rundate)
      if (!date || date < addDays(et.date, -1)) {
        await alertOnce(
          `stale:${et.date}`,
          `:warning: *njsp-snapshot*: NJSP's FAUQStats${cur.year}.xml RUNDATE is \`${rundate ?? '?'}\` (no update yesterday or today, as of ${et.hour}:00 ET).`,
          state, d,
        )
      }
    }
  }

  if (state.dispatch) {
    const since = Date.parse(state.dispatch.at)
    const runs = (await repo.runs()).filter(r => r.event === 'workflow_dispatch' && Date.parse(r.createdAt) >= since - 60_000)
    if (runs.some(r => r.conclusion === 'success')) {
      state.dispatch = undefined
    } else if (now.getTime() - since > config.dailyTimeoutMin * 60_000) {
      const run = runs[0]
      await alertOnce(
        `daily:${state.dispatch.sha}`,
        `:hourglass: *njsp-snapshot*: daily dispatched at ${state.dispatch.at} (after committing \`${state.dispatch.sha.slice(0, 7)}\`) hasn't succeeded within ${config.dailyTimeoutMin}m: ${run ? `<${run.url}|run ${run.id}> ${run.status}/${run.conclusion ?? '-'}` : 'no dispatched run found'}`,
        state, d,
      )
      state.dispatch = undefined
    }
  }
}

/** Commit not-yet-captured rollback versions to `config.rollbackBranch` (one commit), alerting once per version. */
async function captureRollbacks(plans: Plan[], head: Head, state: State, d: Deps): Promise<TickResult['rollback']> {
  const { config, rollbackRepo } = d
  const rbs = plans.filter(p => p.rollbackFiles)
  if (!rbs.length) return undefined
  const mainRds = await Promise.all(rbs.map(p => mainRundate(p.year, head, state, d.repo)))
  const desc = rbs.map((p, i) => `${p.year}: ${rundateShort(mainRds[i] ?? '?')} → ${rundateShort(p.rundate ?? '?')}`)
  const message = `NJSP rollback (${desc.join(', ')})`
  const files = rbs.flatMap(p => p.rollbackFiles!)
  const paths = files.map(f => f.path)
  if (config.dryRun) return { message, files: paths }
  const side = await rollbackRepo.head(head)
  const sha = await rollbackRepo.commit(side, files, message, config.author)
  if (sha === null) throw new Error(`rollback commit to ${config.rollbackBranch}: non-fast-forward`)
  for (const [i, p] of rbs.entries()) {
    state.rollbacks = { ...state.rollbacks, [p.year]: { md5: p.md5!, mainMd5: p.mainMd5! } }
    await alertOnce(
      `rollback:${p.year}:${p.md5}`,
      `:rewind: *njsp-snapshot*: NJSP re-published an older FAUQStats${p.year}.xml (RUNDATE \`${p.rundate}\`; \`main\` has \`${mainRds[i]}\`). Captured to \`${config.rollbackBranch}\` (\`${sha.slice(0, 7)}\`); \`main\` untouched.`,
      state, d,
    )
  }
  return { sha, message, files: paths }
}

async function capture(state: State, d: Deps): Promise<{ head: Head, result: TickResult }> {
  const { repo, now, config } = d
  const et = etParts(now)
  const years = [et.year - 2, et.year - 1, et.year]
  for (let attempt = 1; ; attempt++) {
    const head = await repo.head()
    const plans: Plan[] = []
    for (const year of years) {
      const plan = await planYear(year, year === et.year, head, state, et.date, d)
      if (plan) plans.push(plan)
    }
    const yearResults: YearResult[] = plans.map(({ year, status, rundate }) => ({ year, status, ...(rundate ? { rundate } : {}) }))
    const rollback = await captureRollbacks(plans, head, state, d)
    const base = { at: now.toISOString(), years: yearResults, ...(rollback ? { rollback } : {}) }
    if (!plans.some(p => p.status === 'content')) {
      return { head, result: { ...base, outcome: 'no-change' } }
    }
    const active = (await repo.runs()).filter(r => ACTIVE_STATUSES.has(r.status))
    if (active.length) {
      return { head, result: { ...base, outcome: 'daily-running' } }
    }
    const curPlan = plans.find(p => p.year === et.year)
    const curRundate = curPlan?.status === 'content' || curPlan?.status === 'meta'
      ? curPlan.rundate
      : curPlan ? await mainRundate(et.year, head, state, repo) : undefined
    const message = commitMessage(curRundate)
    const files = plans.flatMap(p => p.files)
    const paths = files.map(f => f.path)
    if (config.dryRun) {
      return { head, result: { ...base, outcome: 'dry-run', message, files: paths } }
    }
    const sha = await repo.commit(head, files, message, config.author)
    if (sha === null) {
      if (attempt >= 3) throw new Error(`commit: ${attempt} non-fast-forward attempts`)
      d.log?.(`commit: non-fast-forward (attempt ${attempt}); retrying from new head`)
      continue
    }
    if (config.dispatch) {
      await repo.dispatch()
      state.dispatch = { at: now.toISOString(), sha }
    }
    return { head, result: { ...base, outcome: 'committed', message, sha, files: paths } }
  }
}

export async function runTick(d: Deps): Promise<State> {
  const state = await loadState(d.kv)
  try {
    const { head, result } = await capture(state, d)
    state.lastTick = result
    state.consecutiveErrors = 0
    await checkAlerts(head, result, state, d)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    state.lastError = { at: d.now.toISOString(), message }
    state.consecutiveErrors += 1
    if (state.consecutiveErrors >= d.config.errorThreshold) {
      await alertOnce(
        `errors:${etParts(d.now).date}`,
        `:x: *njsp-snapshot*: ${state.consecutiveErrors} consecutive failed ticks; last: ${message}`,
        state, d,
      )
    }
    await d.kv.put(STATE_KEY, JSON.stringify(state))
    throw e
  }
  await d.kv.put(STATE_KEY, JSON.stringify(state))
  return state
}

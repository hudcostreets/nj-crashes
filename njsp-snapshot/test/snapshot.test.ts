import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, md5Hex, runTick, type Config, type State } from '../src/snapshot'
import { FakeKv, FakeRepo, FakeUpstream, type UpstreamFile } from './fakes'

const enc = new TextEncoder()
const AUTHOR = { name: 'GitHub Actions', email: 'ryan-williams@users.noreply.github.com' }
const CONFIG: Config = { ...DEFAULT_CONFIG, author: AUTHOR, dryRun: false }

const UA_LINES = [
  '  user_agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML,',
  '    like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

function xml(year: number, rundate: string): string {
  return `<FAUQSTATS>\n  <RUNDATE>${rundate}</RUNDATE>\n  <STATSYEAR>${year}</STATSYEAR>\n</FAUQSTATS>\n`
}

function dvc(year: number, f: { etag: string, mtime: string, content: string, fetched: string }): string {
  const bytes = enc.encode(f.content)
  return [
    'deps:',
    `- path: https://njsp.njoag.gov/wp/wp-content/plugins/fatal-crash-data/xml/FAUQStats${year}.xml`,
    `  checksum: '${f.etag}'`,
    `  size: ${bytes.length}`,
    `  mtime: '${f.mtime}'`,
    ...UA_LINES,
    'outs:',
    `- md5: ${md5Hex(bytes)}`,
    `  size: ${bytes.length}`,
    '  hash: md5',
    `  path: FAUQStats${year}.xml`,
    'meta:',
    '  git_tracked: true',
    '  import:',
    `    fetched: '${f.fetched}'`,
    '',
  ].join('\n')
}

const OLD_RUNDATE = 'Sun Nov 01 10:00:04 EST 2026'
const NEW_RUNDATE = 'Mon Nov 02 10:00:03 EST 2026'
const OLD_LM = 'Sun, 01 Nov 2026 15:20:04 GMT'
const NEW_LM = 'Mon, 02 Nov 2026 15:20:05 GMT'
const OLD_MTIME = '2026-11-01T15:20:04+00:00'
// 10:07 EST (DST ended 2026-11-01)
const TICK = new Date('2026-11-02T15:07:00Z')

/** `main` as of 11/1's capture: 2024 (stable content), 2025 + 2026 (RUNDATE-stamped). */
function mainAt11_1(): FakeRepo {
  const files: Record<string, string> = {}
  for (const year of [2024, 2025, 2026]) {
    const content = year === 2024 ? xml(2024, 'Thu Jan 02 10:00:00 EST 2025') : xml(year, OLD_RUNDATE)
    files[`data/FAUQStats${year}.xml`] = content
    files[`data/FAUQStats${year}.xml.dvc`] = dvc(year, { etag: `"old-${year}"`, mtime: OLD_MTIME, content, fetched: '2026-11-01' })
  }
  return new FakeRepo(files)
}

function upstreamFrom(repo: FakeRepo, overrides: Record<number, Partial<UpstreamFile>> = {}): FakeUpstream {
  const files: Record<number, UpstreamFile> = {}
  for (const year of [2024, 2025, 2026]) {
    files[year] = {
      etag: `"old-${year}"`,
      lastModified: OLD_LM,
      content: repo.text(`data/FAUQStats${year}.xml`)!,
      ...overrides[year],
    }
  }
  return new FakeUpstream(files)
}

/** NJSP's daily 10:00 run: every file re-published (new ETag/LM); 2025/2026 get a new RUNDATE. */
function upstream11_2(repo: FakeRepo): FakeUpstream {
  return upstreamFrom(repo, {
    2024: { etag: '"new-2024"', lastModified: NEW_LM },
    2025: { etag: '"new-2025"', lastModified: NEW_LM, content: xml(2025, NEW_RUNDATE) },
    2026: { etag: '"new-2026"', lastModified: NEW_LM, content: xml(2026, NEW_RUNDATE) },
  })
}

type Ctx = { repo: FakeRepo, side: FakeRepo, up: FakeUpstream, kv: FakeKv, alerts: string[], config?: Config }

function tick(ctx: Ctx, now: Date = TICK): Promise<State> {
  return runTick({
    repo: ctx.repo,
    rollbackRepo: ctx.side,
    upstream: ctx.up.fetch,
    kv: ctx.kv,
    alert: async text => { ctx.alerts.push(text) },
    now,
    config: ctx.config ?? CONFIG,
  })
}

function ctx(repo: FakeRepo, up: FakeUpstream, config?: Config): Ctx {
  const side = new FakeRepo({})
  side.missing = true
  return { repo, side, up, kv: new FakeKv(), alerts: [], config }
}

const HEADS = ['HEAD 2024', 'HEAD 2025', 'HEAD 2026']

describe('skip rule (refresh_data.update_years)', () => {
  it('skips when ETag matches', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstreamFrom(repo))
    const state = await tick(c)
    expect(state.lastTick).toEqual({
      at: TICK.toISOString(),
      outcome: 'no-change',
      years: [2024, 2025, 2026].map(year => ({ year, status: 'unchanged' })),
    })
    expect(c.up.calls).toEqual(HEADS)
    expect(repo.commits).toEqual([])
  })

  it('skips when only Last-Modified matches (as an instant)', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstreamFrom(repo, { 2026: { etag: '"rotated"', lastModified: OLD_LM } }))
    const state = await tick(c)
    expect(state.lastTick?.outcome).toBe('no-change')
    expect(c.up.calls).toEqual(HEADS)
  })
})

describe('capture', () => {
  it('commits all changed files in one commit, then dispatches the daily', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstream11_2(repo))
    const state = await tick(c)
    expect(c.up.calls).toEqual(['HEAD 2024', 'GET 2024', 'HEAD 2025', 'GET 2025', 'HEAD 2026', 'GET 2026'])
    expect(repo.commits).toEqual([{
      sha: 'c1',
      parent: 'base',
      message: 'Refresh NJSP data (11/2)',
      author: AUTHOR,
      paths: [
        'data/FAUQStats2024.xml.dvc',
        'data/FAUQStats2025.xml',
        'data/FAUQStats2025.xml.dvc',
        'data/FAUQStats2026.xml',
        'data/FAUQStats2026.xml.dvc',
      ],
    }])
    const content = xml(2026, NEW_RUNDATE)
    expect(repo.text('data/FAUQStats2026.xml')).toBe(content)
    expect(repo.text('data/FAUQStats2026.xml.dvc')).toBe(
      dvc(2026, { etag: '"new-2026"', mtime: '2026-11-02T15:20:05+00:00', content, fetched: '2026-11-02' }),
    )
    // Metadata-only year: same bytes, `.dvc` headers + `fetched` refreshed (as refresh_data does).
    expect(repo.text('data/FAUQStats2024.xml.dvc')).toBe(dvc(2024, {
      etag: '"new-2024"',
      mtime: '2026-11-02T15:20:05+00:00',
      content: xml(2024, 'Thu Jan 02 10:00:00 EST 2025'),
      fetched: '2026-11-02',
    }))
    expect(repo.dispatches).toBe(1)
    expect(state.lastTick).toEqual({
      at: TICK.toISOString(),
      outcome: 'committed',
      years: [
        { year: 2024, status: 'meta', rundate: 'Thu Jan 02 10:00:00 EST 2025' },
        { year: 2025, status: 'content', rundate: NEW_RUNDATE },
        { year: 2026, status: 'content', rundate: NEW_RUNDATE },
      ],
      message: 'Refresh NJSP data (11/2)',
      sha: 'c1',
      files: repo.commits[0].paths,
    })
    expect(state.dispatch).toEqual({ at: TICK.toISOString(), sha: 'c1' })

    // Next tick: `main` now matches upstream → HEAD-only nop (as the daily's `refresh.dvc` will be).
    c.up.calls = []
    const next = await tick(c, new Date('2026-11-02T16:07:00Z'))
    expect(next.lastTick?.outcome).toBe('no-change')
    expect(c.up.calls).toEqual(HEADS)
    expect(repo.commits.length).toBe(1)
  })

  it('records the strong ETag when the GET comes back weak (CF egress)', async () => {
    const repo = mainAt11_1()
    const up = upstream11_2(repo)
    for (const f of Object.values(up.files)) f.weakGetEtag = true
    const c = ctx(repo, up)
    await tick(c)
    const content = xml(2026, NEW_RUNDATE)
    expect(repo.text('data/FAUQStats2026.xml.dvc')).toBe(
      dvc(2026, { etag: '"new-2026"', mtime: '2026-11-02T15:20:05+00:00', content, fetched: '2026-11-02' }),
    )
    c.up.calls = []
    const next = await tick(c, new Date('2026-11-02T16:07:00Z'))
    expect(next.lastTick?.outcome).toBe('no-change')
    expect(c.up.calls).toEqual(HEADS)
  })

  it('`dispatch: false` (staging): commits without dispatching the daily', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstream11_2(repo), { ...CONFIG, dispatch: false })
    const state = await tick(c)
    expect(repo.commits.map(c => c.message)).toEqual(['Refresh NJSP data (11/2)'])
    expect(repo.dispatches).toBe(0)
    expect(state.lastTick?.outcome).toBe('committed')
    expect(state.dispatch).toBeUndefined()
  })

  it("doesn't race an in-progress daily; retries next tick", async () => {
    const repo = mainAt11_1()
    repo.runsList = [{ id: 1, status: 'in_progress', conclusion: null, event: 'schedule', createdAt: '2026-11-02T15:00:00Z', headSha: 'base', url: 'u' }]
    const c = ctx(repo, upstream11_2(repo))
    expect((await tick(c)).lastTick?.outcome).toBe('daily-running')
    expect(repo.commits).toEqual([])
    expect(repo.dispatches).toBe(0)

    repo.runsList = [{ ...repo.runsList[0], status: 'completed', conclusion: 'success' }]
    expect((await tick(c, new Date('2026-11-02T16:07:00Z'))).lastTick?.outcome).toBe('committed')
    expect(repo.commits.map(c => c.message)).toEqual(['Refresh NJSP data (11/2)'])
    expect(repo.dispatches).toBe(1)
  })

  it('retries from the new head on a non-fast-forward', async () => {
    const repo = mainAt11_1()
    repo.racers = 1
    const c = ctx(repo, upstream11_2(repo))
    const state = await tick(c)
    expect(state.lastTick?.outcome).toBe('committed')
    expect(repo.commits.map(({ sha, parent }) => ({ sha, parent }))).toEqual([{ sha: 'c1', parent: 'racer0' }])
  })

  it("metadata-only re-publish: no commit, and later ticks don't re-GET", async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstreamFrom(repo, {
      2024: { etag: '"new-2024"', lastModified: NEW_LM },
      2025: { etag: '"new-2025"', lastModified: NEW_LM },
      2026: { etag: '"new-2026"', lastModified: NEW_LM },
    }))
    const state = await tick(c)
    expect(state.lastTick?.outcome).toBe('no-change')
    expect(state.lastTick?.years.map(y => y.status)).toEqual(['meta', 'meta', 'meta'])
    expect(c.up.calls).toEqual(['HEAD 2024', 'GET 2024', 'HEAD 2025', 'GET 2025', 'HEAD 2026', 'GET 2026'])
    expect(repo.commits).toEqual([])

    c.up.calls = []
    await tick(c, new Date('2026-11-02T16:07:00Z'))
    expect(c.up.calls).toEqual(HEADS)
  })

  it('rollback (older RUNDATE than `main`): captured once to the side branch, `main` untouched', async () => {
    const repo = mainAt11_1()
    const OLDER = 'Wed Oct 28 10:00:01 EDT 2026'
    const older = xml(2026, OLDER)
    const c = ctx(repo, upstreamFrom(repo, { 2026: { etag: '"rb-2026"', lastModified: NEW_LM, content: older } }))
    const state = await tick(c)
    expect(repo.commits).toEqual([])
    expect(repo.dispatches).toBe(0)
    expect(c.side.created).toBe('base')
    expect(c.side.commits).toEqual([{
      sha: 'c1',
      parent: 'base',
      message: 'NJSP rollback (2026: 11/1 → 10/28)',
      author: AUTHOR,
      paths: ['data/FAUQStats2026.xml', 'data/FAUQStats2026.xml.dvc'],
    }])
    expect(c.side.text('data/FAUQStats2026.xml')).toBe(older)
    expect(c.side.text('data/FAUQStats2026.xml.dvc')).toBe(
      dvc(2026, { etag: '"rb-2026"', mtime: '2026-11-02T15:20:05+00:00', content: older, fetched: '2026-11-02' }),
    )
    expect(state.lastTick).toEqual({
      at: TICK.toISOString(),
      outcome: 'no-change',
      years: [
        { year: 2024, status: 'unchanged' },
        { year: 2025, status: 'unchanged' },
        { year: 2026, status: 'rollback', rundate: OLDER },
      ],
      rollback: { sha: 'c1', message: 'NJSP rollback (2026: 11/1 → 10/28)', files: c.side.commits[0].paths },
    })
    expect(c.alerts).toEqual([
      ':rewind: *njsp-snapshot*: NJSP re-published an older FAUQStats2026.xml (RUNDATE `Wed Oct 28 10:00:01 EDT 2026`; `main` has `Sun Nov 01 10:00:04 EST 2026`). Captured to `njsp-rollbacks` (`c1`); `main` untouched.',
    ])

    // Still served next tick: HEAD-only, no re-capture / re-alert.
    c.up.calls = []
    const next = await tick(c, new Date('2026-11-02T16:07:00Z'))
    expect(c.up.calls).toEqual(HEADS)
    expect(next.lastTick?.years[2]).toEqual({ year: 2026, status: 'rollback', rundate: OLDER })
    expect(c.side.commits.length).toBe(1)
    expect(c.alerts.length).toBe(1)

    // NJSP moves forward again: normal capture to `main`.
    c.up.files[2026] = { etag: '"new-2026"', lastModified: 'Mon, 02 Nov 2026 16:20:05 GMT', content: xml(2026, NEW_RUNDATE) }
    const fwd = await tick(c, new Date('2026-11-02T17:07:00Z'))
    expect(fwd.lastTick?.outcome).toBe('committed')
    expect(repo.commits.map(c => c.message)).toEqual(['Refresh NJSP data (11/2)'])
    expect(c.side.commits.length).toBe(1)
  })

  it('DRY_RUN: plans the commit but writes nothing to GitHub', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstream11_2(repo), { ...CONFIG, dryRun: true })
    const state = await tick(c)
    expect(state.lastTick).toEqual({
      at: TICK.toISOString(),
      outcome: 'dry-run',
      years: [
        { year: 2024, status: 'meta', rundate: 'Thu Jan 02 10:00:00 EST 2025' },
        { year: 2025, status: 'content', rundate: NEW_RUNDATE },
        { year: 2026, status: 'content', rundate: NEW_RUNDATE },
      ],
      message: 'Refresh NJSP data (11/2)',
      files: [
        'data/FAUQStats2024.xml.dvc',
        'data/FAUQStats2025.xml',
        'data/FAUQStats2025.xml.dvc',
        'data/FAUQStats2026.xml',
        'data/FAUQStats2026.xml.dvc',
      ],
    })
    expect(repo.commits).toEqual([])
    expect(repo.dispatches).toBe(0)
  })

  it('new year: seeds the `.dvc` from the prior year when NJSP starts publishing', async () => {
    const repo = mainAt11_1()
    const content = xml(2027, 'Tue Jan 05 10:00:02 EST 2027')
    const up = upstreamFrom(repo, {
      2025: { etag: '"new-2025"', lastModified: 'Tue, 05 Jan 2027 15:20:05 GMT' },
      2026: { etag: '"new-2026"', lastModified: 'Tue, 05 Jan 2027 15:20:05 GMT' },
    })
    up.files[2027] = { etag: '"first-2027"', lastModified: 'Tue, 05 Jan 2027 15:20:05 GMT', content }
    const c = ctx(repo, up)
    const state = await tick(c, new Date('2027-01-05T15:07:00Z'))
    expect(state.lastTick?.outcome).toBe('committed')
    expect(repo.commits[0].message).toBe('Refresh NJSP data (1/5)')
    expect(repo.commits[0].paths).toEqual([
      'data/FAUQStats2025.xml.dvc',
      'data/FAUQStats2026.xml.dvc',
      'data/FAUQStats2027.xml',
      'data/FAUQStats2027.xml.dvc',
    ])
    expect(repo.text('data/FAUQStats2027.xml.dvc')).toBe(
      dvc(2027, { etag: '"first-2027"', mtime: '2027-01-05T15:20:05+00:00', content, fetched: '2027-01-05' }),
    )
  })

  it('January before NJSP publishes the new year: current year 404 → `absent`', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstreamFrom(repo))
    const state = await tick(c, new Date('2027-01-02T15:07:00Z'))
    expect(state.lastTick?.years).toEqual([
      { year: 2025, status: 'unchanged' },
      { year: 2026, status: 'unchanged' },
      { year: 2027, status: 'absent' },
    ])
  })
})

describe('alerts', () => {
  // 13:07 EST
  const AFTERNOON = new Date('2026-11-02T18:07:00Z')

  it('NJSP stale ≥2 days: alerts once per day', async () => {
    const repo = mainAt11_1()
    // main + upstream both at 10/31's RUNDATE
    const stale = xml(2026, 'Sat Oct 31 10:00:04 EDT 2026')
    repo.files.set('data/FAUQStats2026.xml', enc.encode(stale))
    repo.files.set('data/FAUQStats2026.xml.dvc', enc.encode(dvc(2026, { etag: '"old-2026"', mtime: OLD_MTIME, content: stale, fetched: '2026-10-31' })))
    const c = ctx(repo, upstreamFrom(repo))
    await tick(c, AFTERNOON)
    await tick(c, new Date('2026-11-02T19:07:00Z'))
    expect(c.alerts).toEqual([
      ":warning: *njsp-snapshot*: NJSP's FAUQStats2026.xml RUNDATE is `Sat Oct 31 10:00:04 EDT 2026` (no update yesterday or today, as of 13:00 ET).",
    ])
  })

  it("a single skipped day (RUNDATE = yesterday) doesn't alert", async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstreamFrom(repo))
    await tick(c, AFTERNOON)
    expect(c.alerts).toEqual([])
  })

  it("before alertHour, a stale RUNDATE doesn't alert", async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstreamFrom(repo))
    await tick(c, new Date('2026-11-04T15:07:00Z'))
    expect(c.alerts).toEqual([])
  })

  it('consecutive failed ticks: alerts once at the threshold', async () => {
    const repo = mainAt11_1()
    // NJSP's WAF answering with an HTML challenge page.
    const c = ctx(repo, upstreamFrom(repo, { 2026: { etag: '"waf"', lastModified: NEW_LM, contentType: 'text/html' } }))
    const errors: string[] = []
    for (let i = 0; i < 4; i++) {
      await tick(c, new Date(TICK.getTime() + i * 3600_000)).catch(e => errors.push(e.message))
    }
    const msg = 'Unexpected content type for https://njsp.njoag.gov/wp/wp-content/plugins/fatal-crash-data/xml/FAUQStats2026.xml: text/html'
    expect(errors).toEqual([msg, msg, msg, msg])
    expect(c.alerts).toEqual([`:x: *njsp-snapshot*: 3 consecutive failed ticks; last: ${msg}`])
    const state = JSON.parse(c.kv.map.get('state')!) as State
    expect(state.consecutiveErrors).toBe(4)
  })

  it("dispatched daily that hasn't succeeded within the timeout: alerts once", async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstream11_2(repo))
    await tick(c)
    const run = { id: 7, status: 'in_progress', conclusion: null, event: 'workflow_dispatch', createdAt: '2026-11-02T15:07:05Z', headSha: 'c1', url: 'https://github.com/r/actions/runs/7' }
    repo.runsList = [run]
    await tick(c, new Date('2026-11-02T16:07:00Z'))
    expect(c.alerts).toEqual([])
    await tick(c, new Date('2026-11-02T17:08:00Z'))
    await tick(c, new Date('2026-11-02T18:08:00Z'))
    expect(c.alerts).toEqual([
      ":hourglass: *njsp-snapshot*: daily dispatched at 2026-11-02T15:07:00.000Z (after committing `c1`) hasn't succeeded within 120m: <https://github.com/r/actions/runs/7|run 7> in_progress/-",
    ])
  })

  it('dispatched daily that succeeds: clears, no alert', async () => {
    const repo = mainAt11_1()
    const c = ctx(repo, upstream11_2(repo))
    await tick(c)
    repo.runsList = [{ id: 7, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', createdAt: '2026-11-02T15:07:05Z', headSha: 'c1', url: 'u' }]
    const state = await tick(c, new Date('2026-11-02T17:30:00Z'))
    expect(state.dispatch).toBeUndefined()
    expect(c.alerts).toEqual([])
  })
})

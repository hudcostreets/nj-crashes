import { useEffect, useMemo, useState } from "react"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import css from "./MatchReview.module.scss"

type NjspSide = {
    date: string | null
    cc: number | null
    mc: number | null
    tk: number | null
    highway: string | null
    location: string | null
    street: string | null
}
type NjdotSide = {
    year: number
    cc: number
    mc: number
    case: string
    date: string | null
    tk: number | null
    route: number | string | null
    mp: number | null
    road: string | null
    cross_street: string | null
}
type Pair = { njsp_id: number; pass: number; njsp: NjspSide; njdot: NjdotSide }
type PassBucket = { pass: number; description: string; count: number; pairs: Pair[] }
type CandidateRow = Record<string, string | number | null>
type ManualRow = { njsp_id: number; year: number; cc: number; mc: number; case: string; note: string | null }
type Summary = {
    njsp_total: number
    njdot_total: number
    matched: number
    njsp_residual: number
    njdot_residual: number
    years: [number, number]
}
type Payload = {
    summary: Summary
    passes: PassBucket[]
    candidates: { columns: string[]; rows: CandidateRow[] }
    manual: ManualRow[]
}

type Decision = { action: 'accept' | 'reject'; side: string; ref_id: string; rank: number; row: CandidateRow }
const STORAGE_KEY = 'match-review-decisions'

function fmtMp(mp: number | null | undefined): string {
    if (mp == null) return ''
    return mp.toFixed(2).replace(/\.?0+$/, '')
}

function passLabel(p: number): string {
    return p === 0 ? 'Manual' : `Pass ${p}`
}

function PassTable({ pairs }: { pairs: Pair[] }) {
    const PER_PAGE = 50
    const [page, setPage] = useState(0)
    const totalPages = Math.max(1, Math.ceil(pairs.length / PER_PAGE))
    const pageClamped = Math.min(page, totalPages - 1)
    const start = pageClamped * PER_PAGE
    const slice = pairs.slice(start, start + PER_PAGE)
    return (
        <>
            <div className={css.pager}>
                <button disabled={pageClamped === 0} onClick={() => setPage(0)}>«</button>
                <button disabled={pageClamped === 0} onClick={() => setPage(pageClamped - 1)}>‹</button>
                <span>Page {pageClamped + 1} of {totalPages} ({pairs.length} pairs)</span>
                <button disabled={pageClamped >= totalPages - 1} onClick={() => setPage(pageClamped + 1)}>›</button>
                <button disabled={pageClamped >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
            </div>
            <div className={css.tableWrap}>
                <table className={css.matchTable}>
                    <thead>
                        <tr>
                            <th colSpan={4}>NJSP</th>
                            <th colSpan={6}>NJDOT</th>
                        </tr>
                        <tr>
                            <th>Date</th><th>CC/MC</th><th>TK</th><th>Location</th>
                            <th>Date</th><th>CC/MC</th><th>Case</th><th>TK</th><th>Route · MP</th><th>Road</th>
                        </tr>
                    </thead>
                    <tbody>
                        {slice.map(p => (
                            <tr key={p.njsp_id}>
                                <td>{p.njsp.date}</td>
                                <td>{p.njsp.cc}/{p.njsp.mc}</td>
                                <td>{p.njsp.tk}</td>
                                <td>{p.njsp.location || p.njsp.highway || p.njsp.street || ''}</td>
                                <td>{p.njdot.date}</td>
                                <td>{p.njdot.cc}/{p.njdot.mc}</td>
                                <td className={css.mono}>{p.njdot.case}</td>
                                <td>{p.njdot.tk}{p.njsp.tk !== p.njdot.tk && <sup className={css.warn}> Δ</sup>}</td>
                                <td>{p.njdot.route ? `${p.njdot.route} · ${fmtMp(p.njdot.mp)}` : ''}</td>
                                <td>{p.njdot.road || ''}{p.njdot.cross_street ? ` @ ${p.njdot.cross_street}` : ''}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    )
}

function scoreClass(score: number): string {
    if (score >= 100) return css.scoreHigh
    if (score >= 50) return css.scoreMid
    return css.scoreLow
}

function CandidatesSection({ rows, decisions, setDecisions }: {
    rows: CandidateRow[]
    decisions: Record<string, Decision>
    setDecisions: (d: Record<string, Decision>) => void
}) {
    const [minScore, setMinScore] = useState(50)
    const [hideDecided, setHideDecided] = useState(true)

    const filtered = useMemo(() => {
        return rows.filter(r => {
            const s = Number(r.score ?? 0)
            if (s < minScore) return false
            if (hideDecided) {
                const k = `${r.side}|${r.ref_id}|${r.rank}`
                if (decisions[k]) return false
            }
            return true
        })
    }, [rows, minScore, hideDecided, decisions])

    const PER_PAGE = 50
    const [page, setPage] = useState(0)
    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
    const pageClamped = Math.min(page, totalPages - 1)
    const slice = filtered.slice(pageClamped * PER_PAGE, pageClamped * PER_PAGE + PER_PAGE)

    const act = (r: CandidateRow, action: 'accept' | 'reject') => {
        const k = `${r.side}|${r.ref_id}|${r.rank}`
        const next = { ...decisions }
        if (next[k]?.action === action) {
            delete next[k]
        } else {
            next[k] = { action, side: String(r.side), ref_id: String(r.ref_id), rank: Number(r.rank), row: r }
        }
        setDecisions(next)
    }

    return (
        <section className={css.section}>
            <h2>Candidates ({rows.length} total; {filtered.length} shown)</h2>
            <div className={css.controls}>
                <label>Min score:
                    <input type="range" min={0} max={200} step={10} value={minScore} onChange={e => setMinScore(parseInt(e.target.value))} />
                    <span className={css.mono}>{minScore}</span>
                </label>
                <label>
                    <input type="checkbox" checked={hideDecided} onChange={e => setHideDecided(e.target.checked)} />
                    Hide decided
                </label>
            </div>
            <div className={css.pager}>
                <button disabled={pageClamped === 0} onClick={() => setPage(0)}>«</button>
                <button disabled={pageClamped === 0} onClick={() => setPage(pageClamped - 1)}>‹</button>
                <span>Page {pageClamped + 1} of {totalPages}</span>
                <button disabled={pageClamped >= totalPages - 1} onClick={() => setPage(pageClamped + 1)}>›</button>
                <button disabled={pageClamped >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
            </div>
            <div className={css.tableWrap}>
                <table className={css.matchTable}>
                    <thead>
                        <tr>
                            <th colSpan={2}></th>
                            <th colSpan={7}>Ref</th>
                            <th colSpan={7}>Candidate</th>
                            <th></th>
                        </tr>
                        <tr>
                            <th>Side</th><th>Score</th>
                            <th>Date</th><th>CC</th><th>MC</th><th>Case/ID</th><th>TK</th><th>Route · MP</th><th>Hint</th>
                            <th>Date</th><th>CC</th><th>MC</th><th>Case</th><th>TK</th><th>Route · MP</th><th>Hint</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {slice.map(r => {
                            const k = `${r.side}|${r.ref_id}|${r.rank}`
                            const d = decisions[k]
                            const score = Number(r.score ?? 0)
                            const refCase = r.side === 'njsp' ? `NJSP#${r.ref_id}` : String(r.ref_id)
                            return (
                                <tr key={k} className={d ? (d.action === 'accept' ? css.rowAccept : css.rowReject) : ''}>
                                    <td>{r.side}</td>
                                    <td><span className={`${css.badge} ${scoreClass(score)}`}>{score}</span><div className={css.signals}>{String(r.signals ?? '')}</div></td>
                                    <td>{String(r.ref_date ?? '')}</td>
                                    <td>{String(r.ref_cc ?? '')}</td>
                                    <td>{String(r.ref_mc ?? '')}</td>
                                    <td className={css.mono}>{refCase}</td>
                                    <td>{String(r.ref_tk ?? '')}</td>
                                    <td>{r.ref_route ? `${r.ref_route} · ${fmtMp(Number(r.ref_mp))}` : ''}</td>
                                    <td>{String(r.ref_hint ?? '')}</td>
                                    <td>{String(r.cand_date ?? '')}</td>
                                    <td>{r.cand_cc != null ? String(r.cand_cc) : ''}</td>
                                    <td>{r.cand_mc != null ? String(r.cand_mc) : ''}</td>
                                    <td className={css.mono}>{String(r.cand_case ?? '')}</td>
                                    <td>{r.cand_tk != null ? String(r.cand_tk) : ''}</td>
                                    <td>{r.cand_route ? `${r.cand_route} · ${fmtMp(Number(r.cand_mp))}` : ''}</td>
                                    <td>{String(r.cand_hint ?? '')}</td>
                                    <td className={css.actions}>
                                        <button className={`${css.btn} ${d?.action === 'accept' ? css.active : ''}`} onClick={() => act(r, 'accept')}>✓</button>
                                        <button className={`${css.btn} ${d?.action === 'reject' ? css.active : ''}`} onClick={() => act(r, 'reject')}>✗</button>
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    )
}

function decisionsToCsv(decisions: Record<string, Decision>): string {
    const header = 'njsp_id,year,cc,mc,case,note'
    const lines = [header]
    for (const d of Object.values(decisions)) {
        const r = d.row
        let njsp_id = ''
        let year = '', cc = '', mc = '', caseStr = ''
        const note = d.action === 'reject' ? 'rejected' : ''
        if (d.side === 'njsp') {
            njsp_id = String(r.ref_id ?? '')
            if (d.action === 'accept') {
                year = String(r.cand_year ?? '')
                cc = String(r.cand_cc ?? '')
                mc = String(r.cand_mc ?? '')
                caseStr = String(r.cand_case ?? '').replace(/^NJSP#/, '')
            }
        } else {
            if (d.action === 'accept') {
                const candCase = String(r.cand_case ?? '')
                njsp_id = candCase.startsWith('NJSP#') ? candCase.slice(5) : candCase
                year = String(r.ref_year ?? '')
                cc = String(r.ref_cc ?? '')
                mc = String(r.ref_mc ?? '')
                caseStr = '' // rejected only
            } else {
                year = String(r.ref_year ?? '')
                cc = String(r.ref_cc ?? '')
                mc = String(r.ref_mc ?? '')
            }
        }
        const esc = (v: string) => /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
        lines.push([njsp_id, year, cc, mc, caseStr, note].map(esc).join(','))
    }
    return lines.join('\n') + '\n'
}

export default function MatchReview() {
    const [payload, setPayload] = useState<Payload | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [activePass, setActivePass] = useState<number>(1)
    const [decisions, setDecisionsState] = useState<Record<string, Decision>>(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            return raw ? JSON.parse(raw) : {}
        } catch {
            return {}
        }
    })

    const setDecisions = (next: Record<string, Decision>) => {
        setDecisionsState(next)
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
    }

    useEffect(() => {
        fetch('/match-review.json')
            .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
            .then((p: Payload) => {
                setPayload(p)
                if (p.passes.length && !p.passes.some(x => x.pass === activePass)) {
                    setActivePass(p.passes[0].pass)
                }
            })
            .catch(e => setError(String(e)))
    }, [])

    const download = () => {
        const csv = decisionsToCsv(decisions)
        const blob = new Blob([csv], { type: 'text/csv' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'njsp_njdot_manual_matches.csv'
        a.click()
        URL.revokeObjectURL(a.href)
    }

    if (error) return (
        <div className={css.page}>
            <h1>NJSP-NJDOT Match Review</h1>
            <p>Failed to load <code>/match-review.json</code>: {error}.</p>
            <p>Run <code>njsp export_match_review</code> to generate it.</p>
        </div>
    )
    if (!payload) return <div className={css.page}><p>Loading match-review data…</p></div>

    const active = payload.passes.find(p => p.pass === activePass) ?? payload.passes[0]
    const pendingCount = Object.keys(decisions).length

    return (
        <div className={css.page}>
            <Head title="NJSP-NJDOT Match Review" description="Review NJSP↔NJDOT fatal-crash matches" url={`${url}/match-review`} thumbnail="" />
            <header className={css.header}>
                <h1>NJSP-NJDOT Match Review</h1>
                <p className={css.summary}>
                    Years {payload.summary.years[0]}–{payload.summary.years[1]}.{' '}
                    NJSP: <b>{payload.summary.njsp_total}</b>, NJDOT: <b>{payload.summary.njdot_total}</b>,{' '}
                    matched <b>{payload.summary.matched}</b> ({(payload.summary.matched / payload.summary.njsp_total * 100).toFixed(1)}% of NJSP).{' '}
                    Residual NJSP: <b>{payload.summary.njsp_residual}</b>, NJDOT: <b>{payload.summary.njdot_residual}</b>.
                </p>
                <div className={css.headerActions}>
                    <span className={css.pending}>{pendingCount} pending decision{pendingCount === 1 ? '' : 's'}</span>
                    <button onClick={download} disabled={pendingCount === 0}>Download CSV</button>
                    <button onClick={() => setDecisions({})} disabled={pendingCount === 0}>Clear</button>
                </div>
            </header>
            <section className={css.section}>
                <div className={css.tabs}>
                    {payload.passes.map(p => (
                        <button
                            key={p.pass}
                            className={p.pass === activePass ? css.tabActive : css.tab}
                            onClick={() => setActivePass(p.pass)}
                        >{passLabel(p.pass)} <span className={css.tabCount}>({p.count})</span></button>
                    ))}
                </div>
                {active && (
                    <div className={css.passContent}>
                        <p className={css.passDesc} dangerouslySetInnerHTML={{
                            __html: active.description.replace(/`([^`]+)`/g, '<code>$1</code>'),
                        }} />
                        <PassTable pairs={active.pairs} />
                    </div>
                )}
            </section>
            <CandidatesSection rows={payload.candidates.rows} decisions={decisions} setDecisions={setDecisions} />
        </div>
    )
}

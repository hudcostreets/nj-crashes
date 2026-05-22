/** Trailing-365 windowing for `YtdDeathsPlot` — pure, so it can be unit-tested
 *  without the React/Plotly component. */

/** A day's fatality count, as stored in `ytd.parquet`. */
export type DailyFatalities = { year: number; day_of_year: number; fatalities: number }

export const TRAILING_WINDOW = 365

export type TrailingSeries = {
    /** Shared x-axis: the current window's 365 calendar dates (`YYYY-MM-DD`).
     *  Past window-years are plotted against these by day-offset. */
    xDates: string[]
    /** One entry per window-year (oldest first): cumulative deaths over its
     *  365-day window, plus the per-day delta (for hover). */
    series: { year: number; cumulative: number[]; daily: number[] }[]
}

/** Local-time `YYYY-MM-DD` (avoids `toISOString`, which would UTC-shift the date). */
export function ymd(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
}

/** The 365 calendar dates ending on `year`'s `endMonth`/`endDate`. */
function windowDates(year: number, endMonth: number, endDate: number): string[] {
    const out: string[] = []
    for (let k = 0; k < TRAILING_WINDOW; k++) {
        const d = new Date(year, endMonth, endDate)
        d.setDate(d.getDate() - (TRAILING_WINDOW - 1 - k))
        out.push(ymd(d))
    }
    return out
}

/** For each year, the cumulative fatality curve over the 365 days ending on
 *  `now`'s month/day. Every window is complete and ends on the same date, so
 *  the curves are directly comparable — unlike Jan-1-anchored YTD. Window-years
 *  start at `minDataYear + 1`, since each needs the prior year's tail. */
export function trailing365Series(rows: DailyFatalities[], now: Date): TrailingSeries {
    const endMonth = now.getMonth()
    const endDate = now.getDate()
    const curYear = now.getFullYear()

    const fatByDate = new Map<string, number>()
    for (const r of rows) {
        fatByDate.set(ymd(new Date(r.year, 0, r.day_of_year)), r.fatalities)
    }

    const xDates = windowDates(curYear, endMonth, endDate)

    const years = Array.from(new Set(rows.map(r => r.year))).sort((a, b) => a - b)
    const minYear = years.length ? years[0] : curYear

    const series: TrailingSeries['series'] = []
    for (let year = minYear + 1; year <= curYear; year++) {
        const cumulative: number[] = []
        const daily: number[] = []
        let cum = 0
        for (const iso of windowDates(year, endMonth, endDate)) {
            const f = fatByDate.get(iso) ?? 0
            cum += f
            cumulative.push(cum)
            daily.push(f)
        }
        series.push({ year, cumulative, daily })
    }
    return { xDates, series }
}

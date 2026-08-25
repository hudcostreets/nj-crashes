/** Pick the yearly series for `FatalitiesPerYearPlot`: `monthly.parquet` is
 *  primary, `ytc` (`year-type-county.parquet`) is the fallback that supplies
 *  the pre-2020 victim-type breakdown `monthly` only carries statewide.
 *
 *  `ytc` has NO municipality rows — it's county-grained — so for a muni an
 *  empty `monthly` result is the *answer*, not a miss. Falling through
 *  rendered the muni's COUNTY totals under the muni's name: `/delanco`
 *  (0 NJSP fatals ever, until 2026-08-12) showed Burlington County's ~50
 *  deaths/yr and "Delanco … has 22 reported deaths in 2026 so far". 43 of
 *  NJ's 564 munis had zero NJSP fatals, so this was not a corner case.
 *
 *  Lives in its own module so the test can import it without pulling
 *  `pltly` (and the rest of the plot's deps) into the unit-test env. */
export function pickYearlyRows<T>(fromMonthly: T[], ytc: T[], mc: number | null): T[] {
    if (fromMonthly.length > 0) return fromMonthly
    return mc === null ? ytc : (EMPTY as unknown as T[])
}

/** One shared instance, never a fresh `[]`. The result feeds `useMemo` deps
 *  in `FatalitiesPerYearPlot`; a new array identity per render invalidated
 *  every downstream memo and locked the renderer in a render loop (the tab
 *  froze on `/delanco`, the one muni that takes this branch). */
const EMPTY: readonly unknown[] = Object.freeze([])

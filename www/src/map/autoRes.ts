/** Preferred H3 resolution per integer camera zoom (auto mode). Half-int
 *  zooms use `floor(zoom)`, so z=14.77 uses the row for z=14. Tune
 *  individual rows without breaking the curve elsewhere.
 *
 *  Extracted from `CrashMapSection` so the picker module + tests can
 *  share this single source of truth. */
export const AUTO_RES_BY_ZOOM: Record<number, number> = {
    0: 3, 1: 4, 2: 5, 3: 6, 4: 7, 5: 7, 6: 8,
    7: 8,    // statewide aggregate
    8: 9, 9: 9,
    10: 10, 11: 10,
    12: 11, 13: 11,
    14: 12,  // user-CIC calibration: at z=14.77 wants r12 (~4.4px)
    15: 12, 16: 12,
    17: 13,
    18: 14,  // z=18: r13 would give ~16px (too chunky); r14 → ~6px
    19: 15,  // z=19: r14 → 18px (too chunky); r15 → ~7px
    20: 15,  // z=20: r14 → 35px; r15 → ~13px
}

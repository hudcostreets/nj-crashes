// Date constants for the NJDOT data. NJDOT data through 2023 came
// from the per-table archive; 2024+ is from the AASHTO dashboard
// `Crash.csv` export normalized via `njdot/aashto/normalize.py` +
// `to_njdot_schema.py`.
export const DOTStart = "2001-01-01"
export const StartYear = 2001
export const EndYear = 2025
export const DOTEnd = `${EndYear}-12-31`

// Current year constants (for NJSP data)
export const curYear = new Date().getFullYear()
export const prvYear = curYear - 1

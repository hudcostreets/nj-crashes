// NJDOT crash data types and constants

export type Severity = 'p' | 'i' | 'f'
export const Severities: Severity[] = ['f', 'i', 'p']  // stack order: fatal, injury, prop. damage
export const SeverityLabels: Record<Severity, string> = {
    f: 'Fatal',
    i: 'Injury',
    p: 'Prop. Damage',
}
export const SeverityColors: Record<Severity, string> = {
    p: '#636EFA',  // blue
    i: '#FFA15A',  // orange
    f: '#EF553B',  // red
}

// Base measures for all aggregations
export type CrashMeasures = {
    n: number      // crash count
    tk: number     // total killed
    ti: number     // total injured
    pk: number     // pedestrians killed
    pi: number     // pedestrians injured
    tv: number     // total vehicles
}

// Aggregation row types (only keeping the ones we use)
export type YmsRow = CrashMeasures & {
    y: number      // year
    m: number      // month (1-12)
    s: Severity    // severity
}

export type YmccsRow = YmsRow & {
    cc: number     // county code
}

export type YmccmcRow = CrashMeasures & {
    y: number      // year
    m: number      // month (1-12)
    cc: number     // county code
    mc: number     // municipality code
}

// Measure options for Y-axis
export type Measure = 'n' | 'tk' | 'ti' | 'pk' | 'pi' | 'tv'
export const Measures: Measure[] = ['n', 'tk', 'ti', 'pk', 'pi', 'tv']
export const MeasureLabels: Record<Measure, string> = {
    n: 'Crashes',
    tk: 'Fatalities',
    ti: 'Injuries',
    pk: 'Pedestrian Fatalities',
    pi: 'Pedestrian Injuries',
    tv: 'Vehicles',
}

// Time granularity
export type TimeGranularity = 'year' | 'month'

// Stacking options
export type StackBy = 'none' | 'severity' | 'county'
export const StackBys: StackBy[] = ['none', 'severity', 'county']
export const StackByLabels: Record<StackBy, string> = {
    none: 'None',
    severity: 'Severity',
    county: 'County',
}

// County codes and names (21 NJ counties)
export const Counties: Record<number, string> = {
    1: 'Atlantic',
    2: 'Bergen',
    3: 'Burlington',
    4: 'Camden',
    5: 'Cape May',
    6: 'Cumberland',
    7: 'Essex',
    8: 'Gloucester',
    9: 'Hudson',
    10: 'Hunterdon',
    11: 'Mercer',
    12: 'Middlesex',
    13: 'Monmouth',
    14: 'Morris',
    15: 'Ocean',
    16: 'Passaic',
    17: 'Salem',
    18: 'Somerset',
    19: 'Sussex',
    20: 'Union',
    21: 'Warren',
}

// Helper to get year-month string
export function toYM(year: number, month: number): string {
    return `${year}-${month.toString().padStart(2, '0')}`
}

// Helper to get date from year-month
export function ymToDate(year: number, month: number): Date {
    return new Date(year, month - 1, 15) // middle of month
}

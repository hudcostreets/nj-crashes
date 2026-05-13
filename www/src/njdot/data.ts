// NJDOT crash data types and constants

export type Severity = 'p' | 'i' | 'f'
export const Severities: Severity[] = ['f', 'i', 'p']  // stack order: fatal, injury, prop. damage
export const SeverityLabels: Record<Severity, string> = {
    f: 'Fatal',
    i: 'Injury',
    p: 'Other',
}
// NJTR-1 crash-level severity definitions
export const SeverityDefs: Record<Severity, string> = {
    f: 'Fatal Crash: at least one person died within 30 days of the crash as a direct result of injuries (per AASHTO Fatal Crash Indicator = "Y").',
    i: 'Injury Crash: at least one person sustained a non-fatal injury (serious, minor, or possible).',
    p: 'Property Damage Only: no injuries were reported; vehicles or property were damaged.',
}
export const SeverityColorsLight: Record<Severity, string> = {
    p: '#E0C830',  // gold
    i: '#F09030',  // orange
    f: '#EF553B',  // red
}
export const SeverityColorsDark: Record<Severity, string> = {
    p: '#D4C870',  // light gold
    i: '#FFA500',  // orange
    f: '#EF553B',  // red
}

// Victim types (who was involved)
export type VictimType = 'd' | 'o' | 'p' | 'b' | 'u'
export const VictimTypes: VictimType[] = ['d', 'o', 'p', 'b', 'u']
export const VictimTypeLabels: Record<VictimType, string> = {
    d: 'Driver',
    o: 'Passenger',
    p: 'Pedestrian',
    b: 'Cyclist',
    u: 'Unknown',
}
export const VictimTypeDefs: Record<VictimType, string> = {
    d: 'Driver: operator of a motor vehicle involved in the crash.',
    o: 'Passenger: occupant of a motor vehicle other than the driver.',
    p: 'Pedestrian: person on foot involved in the crash.',
    b: 'Cyclist: person on a bicycle or similar non-motorized vehicle involved in the crash.',
    u: 'Unknown: person type could not be determined (often AASHTO records with blank Position; common for mis-tagged pedestrian/cyclist victims).',
}
export const VictimTypeColors: Record<VictimType, string> = {
    d: '#636EFA',  // blue
    o: '#00CC96',  // green
    p: '#AB63FA',  // purple
    b: '#FFA15A',  // orange
    u: '#7F7F7F',  // gray
}

// Physical conditions (person-level injury severity, KABCO scale)
export type Condition = 'f' | 's' | 'm' | 'p' | 'n'
export const Conditions: Condition[] = ['f', 's', 'm', 'p', 'n']
export const ConditionLabels: Record<Condition, string> = {
    f: 'Fatal',
    s: 'Serious Injury',
    m: 'Minor Injury',
    p: 'Possible Injury',
    n: 'No Apparent Injury',
}
// NJTR-1 person-level injury definitions
export const ConditionDefs: Record<Condition, string> = {
    f: 'Fatal injury: death within 30 days of the crash as a direct result of injuries sustained.',
    s: 'Serious (incapacitating) injury, including:\n• Severe laceration exposing tissues/muscle/organs or causing significant blood loss\n• Broken or distorted extremity (arm or leg)\n• Crush injuries\n• Suspected skull, chest, or abdominal injury (other than bruises/minor lacerations)\n• Significant burns (2nd/3rd degree over ≥10% of body)\n• Unconsciousness when removed from the crash scene\n• Paralysis',
    m: 'Minor (non-incapacitating evident) injury: evident injury other than fatal or serious. Examples: lump on the head, abrasions, bruises, minor lacerations (cuts with minimal bleeding, no exposed tissue).',
    p: 'Possible injury: reported injury not fatal/serious/minor. Examples: momentary loss of consciousness, claim of injury, limping, complaint of pain or nausea. Person reports or behavior indicates injury, but no wounds are readily evident.',
    n: 'No apparent injury: no visible injury reported (property damage only on the person level).',
}
export const ConditionColors: Record<Condition, string> = {
    f: '#EF553B',  // red
    s: '#FFA15A',  // orange
    m: '#FECB52',  // yellow
    p: '#00CC96',  // green
    n: '#636EFA',  // blue
}

// Victim Type × Condition matrix column helper
export const vtcCol = (vt: VictimType, c: Condition) => `${vt}${c}` as const
export type VTCCol = `${VictimType}${Condition}`
export const VTC_COLS: VTCCol[] = VictimTypes.flatMap(vt => Conditions.map(c => vtcCol(vt, c)))

// Victim Type × Condition record type (25 columns)
export type VTCMeasures = {
    [K in VTCCol]: number
}

// Vehicle damage tiers (NJTR-1 "Extent of Damage"). Data starts 2017 — all
// pre-2017 vehicles land in `vdu` (Unknown). No coverage for 2023+ either
// (AASHTO has no vehicles supplement yet — see specs/vehicle-facets.md).
export type Damage = 'vdx' | 'vdo' | 'vdm' | 'vdn' | 'vdu'
export const Damages: Damage[] = ['vdx', 'vdo', 'vdm', 'vdn', 'vdu']  // stack order: disabling → unknown
export const DamageLabels: Record<Damage, string> = {
    vdx: 'Disabling',
    vdo: 'Moderate',
    vdm: 'Minor',
    vdn: 'None',
    vdu: 'Unknown',
}
export const DamageDefs: Record<Damage, string> = {
    vdx: 'Disabling damage (NJTR-1 code 4): vehicle must be towed or carried from the scene; cannot depart under its own power.',
    vdo: 'Moderate / Functional damage (code 3): vehicle is damaged in a way that affects operation, but is not disabling.',
    vdm: 'Minor damage (code 2): cosmetic / superficial damage that does not affect operation.',
    vdn: 'No damage (code 1): no visible damage reported.',
    vdu: 'Unknown: damage tier missing (NJDOT only started reporting per-vehicle damage in 2017; all earlier vehicles land here. AASHTO 2023+ has no vehicles table yet, so those years are also entirely Unknown).',
}
export const DamageColors: Record<Damage, string> = {
    vdx: '#EF553B',  // red — totaled
    vdo: '#FFA15A',  // orange
    vdm: '#FECB52',  // yellow
    vdn: '#00CC96',  // green
    vdu: '#7F7F7F',  // gray
}

// Vehicle departure (NJTR-1 "Driven/Left/Towed"). Collapsed 6 source codes
// to 3 buckets + Unknown; well-coded across all years (87-95%).
export type Departure = 'vepd' | 'vepl' | 'vept' | 'vepu'
export const Departures: Departure[] = ['vept', 'vepl', 'vepd', 'vepu']  // stack order: towed (worst) → unknown
export const DepartureLabels: Record<Departure, string> = {
    vepd: 'Driven',
    vepl: 'Left at Scene',
    vept: 'Towed',
    vepu: 'Unknown',
}
export const DepartureDefs: Record<Departure, string> = {
    vepd: 'Driven away (NJTR-1 code 1): vehicle departed the scene under its own power.',
    vepl: 'Left at Scene (code 2): vehicle was left at the crash scene (e.g. abandoned, unattended, owner returning later).',
    vept: 'Towed (codes 3-6): vehicle was towed from the scene — disabled, impounded, both, or pre-2017 "Towed" without further detail.',
    vepu: 'Unknown: departure missing from the record (~5-15% of vehicles depending on year).',
}
export const DepartureColors: Record<Departure, string> = {
    vept: '#EF553B',  // red — towed
    vepl: '#FFA15A',  // orange — abandoned
    vepd: '#00CC96',  // green — drove off
    vepu: '#7F7F7F',  // gray — unknown
}

// Vehicle Damage record type (5 columns)
export type VDMeasures = { [K in Damage]: number }
// Vehicle Departure record type (4 columns)
export type VEPMeasures = { [K in Departure]: number }

// Base measures for all aggregations
export type CrashMeasures = {
    n: number      // crash count
    tk: number     // total killed
    ti: number     // total injured
    pk: number     // pedestrians killed
    pi: number     // pedestrians injured
    tv: number     // total vehicles
} & VTCMeasures & VDMeasures & VEPMeasures

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

export type YmccmcsRow = YmccmcRow & {
    s: Severity    // severity
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

// User-facing measure choices for CrashPlot. `people` sums the 25-cell VTC
// matrix (victim type × condition) filtered by current Condition/VictimType
// selections; `crashes` and `vehicles` map directly to `n` and `tv` columns.
export type MeasureKind = 'crashes' | 'people' | 'vehicles'
export const MeasureKinds: MeasureKind[] = ['crashes', 'people', 'vehicles']
export const MeasureKindLabels: Record<MeasureKind, string> = {
    crashes: 'Crashes',
    people: 'People',
    vehicles: 'Vehicles',
}
export const MeasureKindDefs: Record<MeasureKind, string> = {
    crashes: 'Number of crash events (each row in the NJDOT crash table is one event, regardless of how many people or vehicles were involved).',
    people: 'Number of people involved (drivers + passengers + pedestrians + cyclists + unknown), summed from the 25-cell victim-type × condition matrix. Filter by Condition (injury severity) and/or Victim Type below.',
    vehicles: 'Number of vehicles involved across all crashes in the bucket.',
}

// Time granularity
export type TimeGranularity = 'year' | 'month'

// Stacking options
export type StackBy = 'none' | 'severity' | 'county' | 'municipality' | 'victim_type' | 'condition' | 'damage' | 'departure'
export const StackBys: StackBy[] = ['none', 'severity', 'county', 'municipality', 'victim_type', 'condition', 'damage', 'departure']
export const StackByLabels: Record<StackBy, string> = {
    none: 'None',
    severity: 'Severity',
    county: 'County',
    municipality: 'Municipality',
    victim_type: 'Victim Type',
    condition: 'Condition',
    damage: 'Damage',
    departure: 'Departure',
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

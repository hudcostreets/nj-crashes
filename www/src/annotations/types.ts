export type Severity = 'info' | 'caveat' | 'warning'
export type DataSource = 'njsp' | 'njdot' | 'both'

export type AnnotationRef = {
    url: string
    label: string
}

export type AnnotationGeo = {
    cc?: number
    mc?: number
}

export type AnnotationAppliesTo = {
    geo: AnnotationGeo
    pages?: string[]
    year_range?: [number, number]
    data_source?: DataSource
    /** Override the default icon position on the plot (x offset from year_range end, y in paper coords 0-1) */
    icon_offset?: { dx?: number; y?: number; anchor?: 'left' | 'right' }
}

export type Annotation = {
    id: string
    title: string
    body: string
    applies_to: AnnotationAppliesTo
    severity: Severity
    authored: { author: string; date: string }
    refs: AnnotationRef[]
}

export function matchesGeo(a: Annotation, cc: number | null, mc: number | null): boolean {
    const g = a.applies_to.geo
    const ccMatch = g.cc === undefined ? cc === null : g.cc === cc
    const mcMatch = g.mc === undefined ? mc === null : g.mc === mc
    return ccMatch && mcMatch
}

export function matchesPage(a: Annotation, page: string): boolean {
    const pages = a.applies_to.pages
    if (!pages || pages.length === 0) return true
    return pages.includes(page)
}

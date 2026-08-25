/** Placeholder for an NJSP plot whose query settled with no rows.
 *
 *  These plots used to render `<div>Loading...</div>` whenever their trace
 *  list was empty, which conflates "the query hasn't come back" with "this
 *  region has no fatalities". 42 of NJ's 564 munis have never had an NJSP
 *  fatal crash, so every one of them showed a permanent spinner. */
export function EmptyRegion({ height, label, span = "2001–present" }: {
    height: number | string
    label: string
    span?: string
}) {
    return (
        <div
            style={{
                height: typeof height === "number" ? `${height}px` : height,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                opacity: 0.7,
            }}
        >
            No recorded traffic deaths in {label}, {span}.
        </div>
    )
}

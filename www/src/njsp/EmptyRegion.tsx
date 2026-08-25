/** Placeholder for an NJSP plot whose query settled with no rows.
 *
 *  These plots used to render `<div>Loading...</div>` whenever their trace
 *  list was empty, which conflates "the query hasn't come back" with "this
 *  region has no fatalities". 42 of NJ's 564 munis have never had an NJSP
 *  fatal crash, so every one of them showed a permanent spinner.
 *
 *  Deliberately *not* sized to the plot it replaces: reserving 400-500px of
 *  blank column for one line of text left `/delanco` scrolling through
 *  screens of nothing. The heading is rendered here too, so the message is
 *  attributable — without it, the text stranded under the previous
 *  section's heading reads as if that section were the empty one. */
export function EmptyRegion({ id, title, label, span = "2001–present" }: {
    id: string
    title: string
    label: string
    span?: string
}) {
    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>{title}</a></h2>
            <p style={{ opacity: 0.7, margin: "0.5em 0 1.5em" }}>
                No recorded traffic deaths in {label}, {span}.
            </p>
        </div>
    )
}

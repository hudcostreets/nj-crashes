import { Row } from "@/server/crime/vs-homicides"

export function VsHomicidesPlot({ rows }: { rows: Row[] }) {
  return (
    <div>
      {JSON.stringify(rows)}
    </div>
  )
}

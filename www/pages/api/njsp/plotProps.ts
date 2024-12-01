import { decode } from "@rdub/next-params/query"
import { NextApiRequest, NextApiResponse } from "next"
import { cc2mc2mn } from "@/server/county"
import { loadProps } from "@/server/njsp/plot"
import { Props } from "@/src/njsp/plot"
import { NjspPlot } from "@/src/query"

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Props>
) {
  const { cc } = decode(req, NjspPlot)
  console.log("/api/njsp/plotProps req.query:", req.query, cc)
  const county = cc === null ? null : cc2mc2mn[cc].cn
  const props = await loadProps({ county })
  res.status(200).json(props)
}

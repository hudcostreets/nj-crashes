import { decode } from "@rdub/next-params/query"
import { NextApiRequest, NextApiResponse } from "next"
import { spDdb } from "@/server/njsp/ddb"
import { CrashPage } from "@/src/njsp/crash"
import * as q from "@/src/query"

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page, pp: perPage, cc, mc } = decode(req, q.CrashPage)
  const crashPage = await spDdb.crashPage({ cc, mc, page, perPage, })
  res.status(200).json(crashPage)
}

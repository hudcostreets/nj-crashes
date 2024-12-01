import { decode } from "@rdub/next-params/query"
import { NextApiRequest, NextApiResponse } from "next"
import { dotDdb } from "@/server/njdot/ddb"
import { CrashPage } from "@/src/njdot/crash"
import * as q from "@/src/query"

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page, pp: perPage, cc, mc } = decode(req, q.CrashPage)
  const crashPage = await dotDdb.crashPage({ cc, mc, page, perPage, })
  res.status(200).json(crashPage)
}

import { NextApiRequest, NextApiResponse } from "next";
import { CrashPageOpts } from "@/src/query";
import { DefaultPageSize } from "@/src/pagination";
import { DOTDbs } from "@/server/njdot/sql";
import { getUrls } from "@/src/urls";
import { CrashPage } from "@/src/njdot/crash";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page = 0, pp: perPage = DefaultPageSize, cc = null, mc = null } = req.query as CrashPageOpts
  const urls = getUrls({ local: true })
  const db = new DOTDbs(urls.dot)
  const crashPage = await db.crashPage({ cc, mc, page, perPage, })
  res.status(200).json(crashPage)
}

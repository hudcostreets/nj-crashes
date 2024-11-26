import { NextApiRequest, NextApiResponse } from "next";
import { CrashPageOpts } from "@/src/query";
import { DefaultPageSize } from "@/src/pagination";
import { Crashes } from "@/server/njsp/sql";
import { getUrls } from "@/src/urls";
import { CrashPage } from "@/src/njsp/crash";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page = 0, pp: perPage = DefaultPageSize, cc = null, mc = null } = req.query as CrashPageOpts
  const urls = getUrls({ local: true })
  const crashDb = new Crashes(urls.njsp.crashes)
  const [ crashes, total, ] = await Promise.all([
    crashDb.crashes({ cc, mc, page, perPage, }),
    crashDb.total({ cc, mc, }),
  ])
  res.status(200).json({ crashes, total })
}

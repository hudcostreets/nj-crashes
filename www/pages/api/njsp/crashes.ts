import { NextApiRequest, NextApiResponse } from "next";
import { CrashDB } from "@/server/njsp/sql";
import { getUrls } from "@/src/urls";
import { CrashPage } from "@/src/njsp/crash";
import { decode } from "@rdub/next-params/query";
import * as q from "@/src/query";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page, pp: perPage, cc, mc } = decode(req, q.CrashPage)
  const urls = getUrls({ local: true })
  const crashDb = new CrashDB(urls.njsp.crashes)
  const crashPage = await crashDb.crashPage({ cc, mc, page, perPage, })
  res.status(200).json(crashPage)
}

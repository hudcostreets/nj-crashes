import { NextApiRequest, NextApiResponse } from "next";
import { getUrls } from "@/src/urls";
import { CrashPage } from "@/src/njsp/crash";
import { decode } from "@rdub/next-params/query";
import * as q from "@/src/query";
import { CrashDDB } from "@/server/njsp/ddb";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page, pp: perPage, cc, mc } = decode(req, q.CrashPage)
  const urls = getUrls()
  const crashDdb = new CrashDDB(urls.njsp.crashesPqt)
  const crashPage = await crashDdb.crashPage({ cc, mc, page, perPage, })
  res.status(200).json(crashPage)
}

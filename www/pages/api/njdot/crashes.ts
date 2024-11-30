import { NextApiRequest, NextApiResponse } from "next";
import * as q from "@/src/query";
import { DotSql } from "@/server/njdot/sql";
import { getUrls } from "@/src/urls";
import { CrashPage } from "@/src/njdot/crash";
import { decode } from "@rdub/next-params/query";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CrashPage>
) {
  console.log("/api/njsp/crashes req.query:", req.query)
  const { p: page, pp: perPage, cc, mc } = decode(req, q.CrashPage)
  const urls = getUrls({ local: true })
  const db = new DotSql(urls.dot)
  const crashPage = await db.crashPage({ cc, mc, page, perPage, })
  res.status(200).json(crashPage)
}

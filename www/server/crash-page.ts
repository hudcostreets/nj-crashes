import { CrashPage } from "@/src/crash"
import { CCMC } from "@/src/njsp/region"
import { PageOpts } from "@/src/pagination"

export interface HasCrashPage<Crash> {
  total({ cc, mc, }: CCMC): Promise<number>
  crashes({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<Crash[]>

}

export async function getCrashPage<Crash>(self: HasCrashPage<Crash>, { cc, mc, page, perPage, }: CCMC & PageOpts): Promise<CrashPage<Crash>> {
  const [ crashes, total, ] = await Promise.all([
    self.crashes({ cc, mc, page, perPage, }),
    self.total({ cc, mc, }),
  ])
  return { crashes, total }
}

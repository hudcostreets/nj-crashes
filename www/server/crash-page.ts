import { CCMC } from "@/src/njsp/region";
import { PageOpts } from "@/src/pagination";
import { CrashPage } from "@/src/crash";

export abstract class HasCrashPage<Crash> {
  abstract total({ cc, mc, }: CCMC): Promise<number>
  abstract crashes({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<Crash[]>

  async crashPage({ cc, mc, page, perPage, }: CCMC & PageOpts): Promise<CrashPage<Crash>> {
    const [ crashes, total, ] = await Promise.all([
      this.crashes({ cc, mc, page, perPage, }),
      this.total({ cc, mc, }),
    ])
    return { crashes, total }
  }
}

import { mapEntries } from "@rdub/base/objs";
import { loadSync } from "@rdub/base/load";
import { CC2MC2MN, normalize } from "@/src/county";
import { CC2MC2MN_RELPATH } from "@/server/paths";

export const cc2mc2mn = loadSync<CC2MC2MN>(CC2MC2MN_RELPATH)
export const CountyCodes: Record<string, number> = mapEntries(cc2mc2mn, (cc, { cn }) => [ normalize(cn), cc ])

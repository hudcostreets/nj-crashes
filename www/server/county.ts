import { mapEntries } from "@rdub/base/objs";
import { loadSync } from "@rdub/base/load";
import { CC2MC2MN, normalize } from "@/src/county";

export const cc2mc2mn = loadSync<CC2MC2MN>('public/njdot/cc2mc2mn.json')
export const CountyCodes: Record<string, number> = mapEntries(cc2mc2mn, (cc, { cn }) => [ normalize(cn), cc ])

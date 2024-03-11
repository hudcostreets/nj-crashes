import { County, normalize } from "@/src/county";
import A from "@rdub/next-base/a";

export default function CityLink({ cc, mc, county, cc2mc2mn, }: {
    cc: number
    mc: number
    county?: County
    cc2mc2mn?: { [cc: number]: County }
}) {
    let _county: County
    if (county) {
        _county = county
    } else {
        if (!cc2mc2mn) {
            throw new Error('`cc2mc2mn` is required for `mc` col')
        }
        _county = cc2mc2mn[cc]
    }
    const { cn, mc2mn } = _county
    const mn = mc2mn[mc]
    const city = normalize(mn)
    return <A href={`/c/${normalize(cn)}/${city}`}>{mn}</A>
}

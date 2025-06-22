import Link from "next/link"
import { County, normalize } from "@/src/county"
import { MC } from "./muni"

export default function CityLink({ cc, mc, cc2mc2mn, }: MC & {
    cc2mc2mn: { [cc: number]: County }
}) {
  const county = cc2mc2mn[cc]
  const { cn, mc2mn } = county
  // console.log(`cc ${cc} cn ${cn} mc ${mc} _county`, _county)
  const mn = mc2mn[mc]
  const city = normalize(mn)
  return <Link href={`/c/${normalize(cn)}/${city}`}>{mn}</Link>
}

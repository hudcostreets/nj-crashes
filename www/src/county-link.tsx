import { normalize } from "@/src/county"
import { Link } from "react-router-dom"

export default function CountyLink({ cc, cc2mc2mn, }: {
    cc: number
    cc2mc2mn?: { [cc: number]: { cn: string } }
}) {
    if (!cc2mc2mn) {
        throw new Error('`cc2mc2mn` is required for `mc` col')
    }
    const { cn } = cc2mc2mn[cc]
    return <Link to={`/c/${normalize(cn)}`}>{cn}</Link>
}

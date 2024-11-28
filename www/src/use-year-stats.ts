import { useMemo } from "react";
import { Either, map } from "fp-ts/Either";
import { Row } from "@/src/result-table";
import { o2a } from "@rdub/base/objs";
import { EndYear } from "@/pages/c/[[...region]]";
import { CCMC } from "@/src/njsp/region";

export type Stats = {
    num_crashes: number
    total: number
}

export type YearStats = {
    y: number
    condition: number
} & Stats

export type YearStatsDict = {
    k: number
    si: number
    mi: number
    pi: number
    ni: number
    fc: number
    sic: number
    mic: number
    pic: number
    nic: number
}
export type YearStatsDicts = {
    [y: number]: YearStatsDict
    totals: YearStatsDict
}

export const ColTitles = {
    "Serious Injuries": "If victim has a serious non-fatal injury which includes:\n" +
        "• Severe laceration resulting in exposure of underlying tissues/muscle/organs or resulting in significant loss of blood\n" +
        "• Broken or distorted extremity (arm or leg)\n" +
        "• Crush injuries\n" +
        "• Suspected skull, chest or abdominal injury other than bruises or minor lacerations\n" +
        "• Significant burns (second and third degree burns over 10% or more of the body)\n" +
        "• Unconsciousness when taken from the crash scene\n" +
        "• Paralysis",
    "Minor Injuries": "An evident injury, other than fatal and serious injuries. Examples include lump on the head, abrasions, bruises, minor lacerations (cuts on the skin surface with minimal bleeding and no exposure of deeper tissue/muscle).",
    "Other Reported Injuries": "Reported injury that is not fatal, serious or minor. Examples include momentary loss of consciousness, claim of injury, limping, or complaint of pain or nausea. Possible injuries are those which are reported by the person or are indicated by his/her behavior, but no wounds or injuries are readily evident.",
}

export function yearStatsRows({ ysds }: { ysds: YearStatsDicts, }): Row[] {
    const rows: Row[] = o2a(
        ysds,
        (y, { k, fc, si, sic, mi, mic, pi, pic, nic }) => {
            return {
                key: y,
                "Year": y === 'totals' ? `2001–${EndYear}` : y,
                "Total crashes": (fc + sic + mic + pic + nic).toLocaleString(),
                "Deaths": k.toLocaleString(),
                "Serious Injuries": si.toLocaleString(),
                "Minor Injuries": mi.toLocaleString(),
                "Other Reported Injuries": pi.toLocaleString(),
            }
        }
    )
    return rows
}

export type Props = CCMC

const YSD = {
     k: 0,  fc: 0,
    si: 0, sic: 0,
    mi: 0, mic: 0,
    pi: 0, pic: 0,
    ni: 0, nic: 0,
}
export function toYearStatsDicts(years: YearStats[]): YearStatsDicts {
    const totals = { ...YSD }
    const ysds = {} as YearStatsDicts
    years.forEach(({ y, condition, total, num_crashes }) => {
        if (!(y in ysds)) {
            ysds[y] = { ...YSD }
        }
        const k = [ null, 'k', 'si', 'mi', 'pi', 'ni' ][condition] as keyof YearStatsDict
        ysds[y][k] += total
        totals[k] += total
        const ck = [ null, 'fc', 'sic', 'mic', 'pic', 'nic' ][condition] as keyof YearStatsDict
        ysds[y][ck] += num_crashes
        totals[ck] += num_crashes
    })
    ysds.totals = totals
    return ysds
}

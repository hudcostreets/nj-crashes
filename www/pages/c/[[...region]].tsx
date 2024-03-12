import type { GetStaticProps } from "next";
import { cc2mc2mn, Counties, County2Code } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { CC2MC2MN, denormalize, normalize } from "@/src/county";
import A from "@rdub/next-base/a";
import { getUrls, Urls } from "@/src/urls";
import RegionPage from "@/src/region-page";
import * as Njsp from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";

export type Params = {
    region: string[]
}

export type Props = {
    urls: Urls
    cc: number | null
    cp: string | null
    cn: string | null
    mc: number | null
    mn: string | null
    cc2mc2mn: CC2MC2MN
    barProps: Njsp.Props | null
    Counties: string[]
}

export function getStaticPaths() {
    const paths = concat([
        [{ params: { region: [] } }],  // NJ
        ...values(cc2mc2mn).map(({ cn, mc2mn }) =>
            [
                { params: { region: [ normalize(cn) ] } },  // Counties
                ...values(mc2mn).map(city => (
                    { params: { region: [ normalize(cn), normalize(city) ] } }  // Cities
                ))
            ]
        )
    ])
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getUrls()
    let { region = [] } = params
    if (region.length > 2) {
        return { notFound: true }
    }
    const cp = region.length > 0 ? region[0] : null
    const mp = region.length > 1 ? region[1] : null
    let cc = null, cn = null, mc = null, mn = null
    if (cp) {
        cc = County2Code[cp]
        const county = cc2mc2mn[cc]
        const { mc2mn } = county
        cn = county.cn
        const mn2mc = mapEntries(mc2mn, (mc, mn) => [ normalize(mn), mc ])
        if (mp) {
            mc = mn2mc[mp]
            mn = denormalize(mp)
        }
    }
    const barProps = mn === null ? await loadProps({ county: cn }) : null
    return { props: { urls, cp, cn, cc, mc, mn, cc2mc2mn, Counties, barProps, } }
}

export default function CityPage({ urls, cc, mc, mn, cc2mc2mn, barProps, cp, cn, Counties }: Props) {
    return <RegionPage
        urls={urls}
        cc={cc}
        mc={mc}
        Counties={Counties}
        title={mn ?? cn ? `${mn} County` : "New Jersey"}
        cc2mc2mn={cc2mc2mn}
        barProps={barProps}
        subtitle={
            mn &&
            <span>
                (<A href={`/c/${cp}`}>{cn} County</A>)
            </span>
        }
    />
}

import type { GetStaticProps } from "next";
import { cc2mc2mn, Counties, County2Code } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { denormalize, MC2MN, normalize } from "@/src/county";
import A from "@rdub/next-base/a";
import { getUrls, Urls } from "@/src/urls";
import RegionPage from "@/src/region-page";

export type Params = {
    county: string
    city: string
}

export type Props = {
    urls: Urls
    countyParam: string
    cc: number
    cn: string
    mc: number
    mn: string
    mc2mn: MC2MN
    Counties: string[]
}

export function getStaticPaths() {
    const paths = concat(
        values(cc2mc2mn).map(({ cn, mc2mn }) =>
            values(mc2mn).map(city => ({
                params: {
                    county: normalize(cn),
                    city: normalize(city),
                }
            }))
        )
    )
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getUrls()
    let { county: countyParam, city, } = params
    countyParam = normalize(countyParam)
    city = normalize(city)
    const cc = County2Code[countyParam]
    const { cn, mc2mn } = cc2mc2mn[cc]
    const mn2mc = mapEntries(mc2mn, (mc, mn) => [ normalize(mn), mc ])
    const mc = mn2mc[city]
    const mn = denormalize(city)
    return { props: { urls, countyParam, cn, cc, mc, mn, mc2mn, Counties } }
}

export default function CityPage({ urls, countyParam, cc, cn, mc, mn, mc2mn, Counties }: Props) {
    return <RegionPage
        urls={urls}
        cc={cc} cn={cn}
        mc={mc}
        mc2mn={mc2mn}
        Counties={Counties}
        title={mn}
        subtitle={
            <span>
                (<A href={`/c/${countyParam}`}>{cn} County</A>)
            </span>
        }
    />
}

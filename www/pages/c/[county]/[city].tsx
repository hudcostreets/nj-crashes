import type { GetStaticProps } from "next";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { denormalize, normalize } from "@/src/county";
import A from "@rdub/next-base/a";
import { getDOTDbUrls, DOTUrls } from "@/src/urls";
import CountyCityPage from "@/src/county-city-page";

export type Params = {
    county: string
    city: string
}

export type Props = {
    urls: DOTUrls
    countyParam: string
    cc: number
    cn: string
    mc: number
    mn: string
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
    const urls = getDOTDbUrls()
    let { county: countyParam, city, } = params
    countyParam = normalize(countyParam)
    city = normalize(city)
    const cc = CountyCodes[countyParam]
    const { cn, mc2mn } = cc2mc2mn[cc]
    const mn2mc = mapEntries(mc2mn, (mc, mn) => [ normalize(mn), mc ])
    const mc = mn2mc[city]
    const mn = denormalize(city)
    return { props: { urls, countyParam, cn, cc, mc, mn } }
}

export default function CityPage({ urls, countyParam, cc, cn, mc, mn }: Props) {
    return <CountyCityPage
        urls={urls}
        cc={cc} cn={cn}
        mc={mc}
        title={mn}
        subtitle={<A href={`/c/${countyParam}`}>{cn} County</A>}
    />
}

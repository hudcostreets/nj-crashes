import type { GetStaticProps } from "next";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, County2Code } from "@/server/county";
import { CC2MC2MN, denormalize, normalize } from "@/src/county";
import { getUrls, Urls } from "@/src/urls";
import RegionPage from "@/src/region-page";
import { loadProps } from "@/server/njsp/plot";
import * as Njsp from "@/src/njsp/plot";

export type Params = {
    county: string
}

export type Props = {
    urls: Urls
    cc: number
    barProps: Njsp.Props
    cc2mc2mn: CC2MC2MN
}

export function getStaticPaths() {
    const paths = keys(County2Code).map(county => ({ params: { county: normalize(county) } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getUrls()
    let { county: countyParam } = params
    const cn = normalize(countyParam)
    const cc = County2Code[cn]
    const county = denormalize(cn)
    const barProps = await loadProps({ county })
    return { props: { urls, cc, barProps, cc2mc2mn } }
}

export default function CountyPage({ urls, cc, barProps, cc2mc2mn, }: Props) {
    const { county } = barProps
    return <RegionPage
        urls={urls}
        cc={cc}
        cc2mc2mn={cc2mc2mn}
        barProps={barProps}
        title={`${county} County`}
        Counties={barProps.Counties}
    />
}

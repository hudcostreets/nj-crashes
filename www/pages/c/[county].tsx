import type { GetStaticProps } from "next";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, County2Code } from "@/server/county";
import { County, denormalize, normalize } from "@/src/county";
import { getUrls, Urls } from "@/src/urls";
import RegionPage from "@/src/region-page";
import { loadProps } from "@/server/njsp/plot";
import * as Njsp from "@/src/njsp/plot";
import useSetCounty from "@/src/use-set-county";

export type Params = {
    county: string
}

export type Props = {
    urls: Urls
    cc: number
    barProps: Njsp.Props
} & County

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
    const { mc2mn } = cc2mc2mn[cc]
    const county = denormalize(cn)
    const barProps = await loadProps({ county })
    return { props: { urls, cc, cn, mc2mn, barProps } }
}

export default function CountyPage({ urls, cc, cn, mc2mn, barProps, }: Props) {
    const setCounty = useSetCounty("/c")
    const { county } = barProps
    return <RegionPage
        urls={urls}
        cc={cc} cn={cn} mc2mn={mc2mn}
        barProps={barProps}
        title={`${county} County`}
        setCounty={setCounty}
    />
}

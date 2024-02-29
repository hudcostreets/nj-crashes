import type { GetStaticProps } from "next";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { County, denormalize, normalize } from "@/src/county";
import { getUrls, Urls } from "@/src/urls";
import CountyCityPage from "@/src/county-city-page";
import { loadProps } from "@/server/njsp/plot";
import * as Njsp from "@/src/njsp/plot";
import { titleCase } from "@rdub/base/str";

export type Params = {
    county: string
}

export type Props = {
    urls: Urls
    cc: number
    barProps: Njsp.Props
} & County

export function getStaticPaths() {
    const paths = keys(CountyCodes).map(county => ({ params: { county: normalize(county) } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getUrls()
    let { county: countyParam } = params
    const cn = normalize(countyParam)
    const cc = CountyCodes[cn]
    const { mc2mn } = cc2mc2mn[cc]
    const barProps = await loadProps({ county: denormalize(cn) })
    return { props: { urls, cc, cn, mc2mn, barProps } }
}

export default function CountyPage({ urls, cc, cn, mc2mn, barProps, }: Props) {
    return <CountyCityPage
        urls={urls}
        cc={cc} cn={cn} mc2mn={mc2mn}
        barProps={barProps}
        title={`${denormalize(cn)} County`}
    />
}

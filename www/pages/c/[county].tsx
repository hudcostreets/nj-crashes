import type { GetStaticProps } from "next";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { County, denormalize, normalize } from "@/src/county";
import { getDbUrls, Urls } from "@/src/urls";
import CountyCityPage from "@/src/county-city-page";

export type Params = {
    county: string
}

export type Props = {
    urls: Urls
    cc: number
} & County

export function getStaticPaths() {
    const paths = keys(CountyCodes).map(county => ({ params: { county: normalize(county) } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getDbUrls()
    let { county: countyParam } = params
    const cn = normalize(countyParam)
    const cc = CountyCodes[cn]
    const { mc2mn } = cc2mc2mn[cc]
    return { props: { urls, cc, cn, mc2mn } }
}

export default function CountyPage({ urls, cc, cn, mc2mn }: Props) {
    return <CountyCityPage
        urls={urls}
        cc={cc} cn={cn} mc2mn={mc2mn}
        title={`${denormalize(cn)} County`}
    />
}

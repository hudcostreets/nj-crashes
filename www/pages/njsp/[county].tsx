import React from 'react'
import type { GetStaticProps } from "next";
import * as Njsp from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import { denormalize, normalize } from "@/src/county";
import { keys } from "@rdub/base/objs";
import { County2Code } from "@/server/county";
import NjspPlotPage from "@/src/njsp/page";

export type Params = {
    county: string
}

export type Props = {
    barProps: Njsp.Props
    county: string
}

export function getStaticPaths() {
    const paths = keys(County2Code).map(county => ({ params: { county: normalize(county) } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    let { county: countyParam } = params
    const county = denormalize(countyParam)
    const barProps = await loadProps({ county })
    return { props: { barProps, county } }
}

export default function Page({ barProps, county, }: Props) {
    return <NjspPlotPage barProps={barProps} county={county} />
}

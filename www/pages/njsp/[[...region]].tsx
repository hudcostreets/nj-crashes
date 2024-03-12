import React from 'react'
import type { GetStaticProps } from "next";
import * as Njsp from "@/src/njsp/plot";
import { DefaultTitle, NjspPlot } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import { CC2MC2MN, normalize } from "@/src/county";
import { concat, values } from "@rdub/base/objs";
import { cc2mc2mn, County2Code } from "@/server/county";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { url } from "@/src/site";
import Footer from "@/src/footer";
import useRegion from "@/src/use-region";

export type Params = {
    region: string[]
}

export type Props = {
    barProps: Njsp.Props
    cc: number | null
    cc2mc2mn: CC2MC2MN
}

export function getStaticPaths() {
    const paths = concat([
        [{ params: { region: [] } }],  // NJ
        ...values(cc2mc2mn).map(({ cn, mc2mn }) =>
            [
                { params: { region: [ normalize(cn) ] } },  // Counties
                // TODO: cities
                // ...values(mc2mn).map(city => (
                //     { params: { region: [ normalize(cn), normalize(city) ] } }  // Cities
                // ))
            ]
        )
    ])
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    let { region = [] } = params
    if (region.length > 1) {
        return { notFound: true }
    }
    const cp = region.length > 0 ? region[0] : null
    let cc = null, cn = null
    if (cp) {
        cc = County2Code[cp]
        const county = cc2mc2mn[cc]
        const {mc2mn} = county
        cn = county.cn
    }
    const barProps = await loadProps({ county: cn })
    return { props: { barProps, cc, cc2mc2mn, } }
}

export default function Page({ barProps, cc, cc2mc2mn }: Props) {
    const { cn, setCounty } = useRegion({ cc, mc: null, cc2mc2mn, urlPrefix: '/njsp' })
    return (
        <div className={css.container}>
            <Head
                title={DefaultTitle}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />
            <main>
                <div className={css["plot-container"]}>
                    <NjspPlot
                        {...barProps}
                        Heading={'h1'}
                        county={cn ?? null}
                        setCounty={setCounty}
                        includeMoreInfoLink={true}
                    />
                    <hr/>
                </div>
                <Footer />
            </main>
        </div>
    )
}

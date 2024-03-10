import React, { useCallback } from 'react'
import type { GetStaticProps } from "next";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { url } from "@/src/site";
import * as Njsp from "@/src/njsp/plot";
import { DefaultTitle, NjspPlot } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import Footer from "@/src/footer";
import { denormalize, normalize } from "@/src/county";
import { keys } from "@rdub/base/objs";
import { County2Code } from "@/server/county";
import { useRouter } from 'next/router';

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
    const router = useRouter()
    const setCounty = useCallback(
        (county: string | null) => {
            router.push(`/njsp/${county ? normalize(county) : ""}`)
        },
        [router]
    )
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
                        // heading={<h1>{DefaultTitle}: {county} County</h1>}
                        Heading={'h1'}
                        county={county}
                        setCounty={setCounty}
                    />
                    <hr/>
                </div>
                <Footer />
            </main>
        </div>
    )
}

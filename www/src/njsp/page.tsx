import { useRouter } from "next/router";
import React, { useCallback } from "react";
import { normalize } from "@/src/county";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { DefaultTitle, NjspPlot } from "@/src/njsp/plot";
import { url } from "@/src/site";
import Footer from "@/src/footer";
import * as Njsp from "@/src/njsp/plot";

export type Props = {
    barProps: Njsp.Props
    county: string | null
}

export default function NjspPlotPage({ barProps, county, }: Props) {
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

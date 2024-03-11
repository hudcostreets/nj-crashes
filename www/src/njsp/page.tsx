import { useRouter } from "next/router";
import React, { useCallback } from "react";
import { normalize } from "@/src/county";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { DefaultTitle, NjspPlot } from "@/src/njsp/plot";
import { url } from "@/src/site";
import Footer from "@/src/footer";
import * as Njsp from "@/src/njsp/plot";
import useSetCounty from "@/src/use-set-county";

export type Props = {
    barProps: Njsp.Props
    county: string | null
}

export default function NjspPlotPage({ barProps, county, }: Props) {
    const setCounty = useSetCounty("/njsp")
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
                        includeMoreInfoLink={true}
                    />
                    <hr/>
                </div>
                <Footer />
            </main>
        </div>
    )
}

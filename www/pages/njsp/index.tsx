import React, { useState } from 'react'
import type { GetStaticProps } from "next";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { url } from "@/src/site";
import { DefaultTitle, NjspPlot, Props } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import Footer from "@/src/footer";

export const getStaticProps: GetStaticProps<Props> = async () => {
    const props = await loadProps()
    return { props }
}

export default function Page(props: Props) {
    const [ county, setCounty ] = useState<string | null>(null)
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
                        {...props}
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

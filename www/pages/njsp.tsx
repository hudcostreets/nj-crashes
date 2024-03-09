import React from 'react'
import type { GetStaticProps } from "next";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { url } from "@/src/site";
import { GitHub } from "@/src/socials"
import A from "@rdub/next-base/a";
import { Socials } from "@rdub/next-base/socials";
import { NjspPlot, Props, DefaultTitle } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import { NjspFatalAcc } from "@/src/urls";

export const getStaticProps: GetStaticProps<Props> = async () => {
    const props = await loadProps()
    return { props }
}

export default function Page(props: Props) {
    return (
        <div className={css.container}>
            <Head
                title={DefaultTitle}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />

            <main className={css.main}>
                <h1 className={css.title}>{DefaultTitle}</h1>
                <p>
                    Data comes from <A title={"NJ State Police fatal crash data"} href={NjspFatalAcc}>NJ State Police</A>, and is updated daily (though crashes sometimes take weeks or months to show up).
                </p>
                <div className={css["plot-container"]}>
                    <NjspPlot {...props} />
                    <hr/>
                </div>
                <p>Code and data are <A href={GitHub.href}>on GitHub</A>; feedback / issues <A href={`${GitHub.href}/issues/new`}>here</A>).</p>
                <Socials
                    socials={[
                        GitHub,
                        // { name: "NJSP", title: "NJ State Police fatal crash data", href: "https://nj.gov/njsp/info/fatalacc/", src: `/njsp.png`, },
                        // { name: "NJDOT", title: "NJ DOT raw crash data", href: "https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm", src: `/njdot-s.png`, },
                        {
                            name: "Hudson County Complete Streets",
                            title: "Hudson County Complete Streets",
                            href: "https://hudcostreets.org",
                            src: `/logos/hccs.png`,
                        },
                    ]}
                />
            </main>
        </div>
    )
}

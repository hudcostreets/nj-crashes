import React from "react";
import Head from "@rdub/next-base/head";
import css from "./index.module.scss"
import {Socials} from "@rdub/next-base/socials"
import { domain, url } from "@/src/site"
import { socials } from "@/src/socials"
import getBasePath from "@rdub/next-base/basePath"

const Home = () => {
    const title = "Page Not Found"
    const basePath = getBasePath()
    return (
        <div className={css.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/fatalities_per_year_by_type.png`}
            />
            <main className={css.main}>
                <h1 className={css.title}>{title}</h1>
                <p>Maybe you wanted <a href={basePath}>{basePath}</a>?</p>
                <p>Or <a href={`https://${domain}`}>{domain}</a></p>
                <Socials socials={socials} />
            </main>
        </div>
    )
}

export default Home

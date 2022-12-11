import styles from "../styles/Home.module.css";
import {Head} from "next-utils/head";
import index from "./index.module.css";
import React from "react";
import {Socials, url} from "../src/socials";
import {getBasePath} from "next-utils/basePath"

const Home = () => {
    const title = "Page Not Found"
    const basePath = getBasePath()
    return (
        <div className={styles.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/fatalities_per_year_by_type.png`}
            />
            <main className={styles.main}>
                <h1 className={index.title}>{title}</h1>
                <p>Maybe you wanted <a href={basePath}>{basePath}</a>?</p>
                <Socials />
            </main>
        </div>
    )
}

export default Home

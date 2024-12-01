import getBasePath from "@rdub/next-base/basePath"
import Head from "@rdub/next-base/head"
import React from "react"
import { Socials } from "@/src/footer"
import { domain, url } from "@/src/site"
import css from "./index.module.scss"

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
        <Socials />
      </main>
    </div>
  )
}

export default Home

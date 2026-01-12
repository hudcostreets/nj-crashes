import { Head } from "@/src/lib/head"
import { getBasePath } from "@/src/lib/basePath"
import { Socials } from "@/src/lib/socials"
import { domain, url } from "@/src/site"
import { socials } from "@/src/socials"
import css from "@/src/home.module.scss"

export default function NotFound() {
    const title = "Page Not Found"
    const basePath = getBasePath()
    return (
        <div className={css.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of car crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/fatalities_per_year_by_type.png`}
            />
            <main className={css.main}>
                <h1 className={css.title}>{title}</h1>
                <p>Maybe you wanted <a href={basePath || "/"}>{basePath || "/"}</a>?</p>
                <p>Or <a href={`https://${domain}`}>{domain}</a></p>
                <Socials socials={socials} />
            </main>
        </div>
    )
}

import A from "next-utils/a";
import React from "react";
import CssAny from "socials.module.css"
import {getBasePath} from "next-utils/basePath"

type Css = {
    social: string
    logo: string
}
const Css = CssAny as Css

export type Social = {
    name: string
    href: string
    src: string
    alt?: string
    title: string
    css?: Css
    basePath?: string
}

export const url = "https://neighbor-ryan.org/nj-crashes"

export const GitHub: Social = { name: "GitHub", title: "neighbor-ryan/nj-crashes on GitHub", href: "https://github.com/neighbor-ryan/nj-crashes", src: `/gh.png`, }
export const Twitter: Social = { name: "Twitter", title: "RunsAsCoded on Twitter", href: "https://twitter.com/RunsAsCoded", src: `/twitter.png`, }
export const YouTube: Social = { name: "YouTube", title: "Neighbor Ryan on YouTube", href: "https://instagram.com/neighbor_ryan", src: `/youtube.png`, }
export const Insta: Social = { name: "Insta", title: "Neighbor Ryan on Instagram", href: "https://youtube.com/@neighborryan", src: `/insta.png`, }

export const defaultSocials = [ GitHub, Twitter, YouTube, Insta, ]

export function Social({ name, href, src, alt, title, css = Css, basePath }: Social) {
    if (basePath === undefined) basePath = getBasePath()
    return <li className={css.social}>
        <A title={title} href={href}>
            <img alt={alt || `${name} logo`} className={css.logo} src={`${basePath || ""}${src}`} />
        </A>
    </li>
}

export function Socials({ socials = defaultSocials, className = CssAny.socials, data }: {
    socials?: Social[]
    className?: string
    data?: { [k: string]: Partial<Social> }
}) {
    const basePath = getBasePath()
    return (
        <ul className={className}>{
            socials.map(social =>
                <Social
                    key={social.name}
                    {...social}
                    basePath={basePath}
                    {...data && data[social.name] || {}}
                />
            )
        }</ul>
    )
}

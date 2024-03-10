import A from "@rdub/next-base/a";
import { crashDataEmail, GitHub } from "@/src/socials";
import { Socials } from "@rdub/next-base/socials";
import React from "react";
import css from "./footer.module.scss"

export default function Footer() {
    return (
        <div className={css.footer}>
            <p>Code and data are <A href={GitHub.href}>on GitHub</A>. <A href={`${GitHub.href}/issues/new`}>File an issue</A>, <a href={`mailto:${crashDataEmail}`}>send us an email</a>, or <A href={"https://hudcostreets.org/get-involved"}>get involved</A>.</p>
            <Socials
                socials={[
                    // GitHub,
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
        </div>
    )
}

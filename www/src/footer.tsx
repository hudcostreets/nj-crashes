import A from "@/src/lib/a"
import { crashDataEmail, GitHub } from "@/src/socials"
import { Socials } from "@/src/lib/socials"
import css from "./footer.module.scss"

export default function Footer() {
    return (
        <div className={css.footer}>
            <p>Code and data are <A href={GitHub.href}>on GitHub</A>. <A href={`${GitHub.href}/issues/new`}>File an issue</A>, <a href={`mailto:${crashDataEmail}`}>send us an email</a>, or <A href={"https://hudcostreets.org/get-involved"}>get involved</A>.</p>
            <Socials
                socials={[
                    {
                        name: "Hudson County Complete Streets",
                        title: "Hudson County Complete Streets",
                        href: "https://hudcostreets.org",
                        src: `/logos/hccs.png`,
                        alt: "HCCS logo",
                    },
                ]}
            />
        </div>
    )
}

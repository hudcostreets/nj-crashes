import * as Socials from "@/src/lib/socials"
import * as css from "@/src/lib/socials.css"
import { repoWithOwner } from "@/src/github"

export const GitHub = Socials.GitHub(repoWithOwner, css.svg)
export const Twitter = Socials.Twitter("hudcostreets")
export const Instagram = Socials.Instagram("hudcostreets")
export const YouTube = Socials.YouTube("@neighborryan")

export const socials = [GitHub, YouTube, Twitter, Instagram]

export const crashDataEmail = "crash-data@hudcostreets.org"

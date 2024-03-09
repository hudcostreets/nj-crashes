import * as Socials from "@rdub/next-base/socials"
import * as css from "./socials.css"
import { repoWithOwner } from "@/src/github";

export const GitHub: Socials.Social = Socials.GitHub(repoWithOwner, css.svg)
export const Twitter = Socials.Twitter("hudcostreets")
export const Instagram = Socials.Instagram("hudcostreets")
export const YouTube = Socials.YouTube("@neighborryan")

export const socials = [ GitHub, YouTube, Twitter, Instagram, ]

import * as Socials from "next-utils/socials"
import * as css from "./socials.css"

export const url = "https://neighbor-ryan.org/nj-crashes"

export const GitHub: Socials.Social = Socials.GitHub("neighbor-ryan/nj-crashes", css.svg)
export const Twitter = Socials.Twitter("RunsAsCoded")
export const Instagram = Socials.Instagram("neighbor_ryan")
export const YouTube = Socials.YouTube("@neighborryan")

export const socials = [ GitHub, YouTube, Twitter, Instagram, ]

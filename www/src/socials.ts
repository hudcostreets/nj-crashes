import { repoWithOwner } from "@/src/github"
import { Tooltip } from "@mui/material"
import { icons } from "@rdub/icons"

export const Icons = icons({ TooltipC: Tooltip })

export const { HudCoStreets } = Icons
export const GitHub = () => Icons.GitHub({ repo: repoWithOwner })
// export const Twitter = Logos.Twitter("hudcostreets")
// export const Instagram = Logos.Instagram("hudcostreets")
export const YouTube = () => Icons.YouTube({ href: "https://youtube.com/@hudcostreets" })

// export const socials = [ GitHub, YouTube, /*Twitter, Instagram,*/ ]

export const crashDataEmail = "crash-data@hudcostreets.org"

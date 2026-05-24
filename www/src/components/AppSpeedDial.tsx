/** SpeedDial actions used app-wide: GitHub link + theme cycler.
 *
 *  These used to live in a separate scroll-triggered `<ThemeToggle>` widget
 *  at bottom-right, which collided with use-kbd's own `<SpeedDial>` at the
 *  same corner. Folding them in as SD actions removes the second floating
 *  widget — everything sits behind the search button now. */
import { useMemo } from "react"
import { FaGithub } from "react-icons/fa"
import { MdBrightnessAuto, MdDarkMode, MdLightMode } from "react-icons/md"
import { SpeedDial, type SpeedDialAction } from "use-kbd"
import { useTheme } from "@/src/contexts/ThemeContext"
import { GitHub } from "@/src/socials"

export function AppSpeedDial() {
    const { theme, setTheme } = useTheme()
    const themeIcon =
        theme === "light" ? <MdLightMode /> :
        theme === "dark"  ? <MdDarkMode /> :
                            <MdBrightnessAuto />
    const themeLabel =
        theme === "light" ? "Light" :
        theme === "dark"  ? "Dark" :
                            "System"
    const actions: SpeedDialAction[] = useMemo(() => [
        {
            key: "github",
            label: "View on GitHub",
            icon: <FaGithub />,
            href: GitHub.href,
            external: true,
        },
        {
            key: "theme",
            label: `Theme: ${themeLabel} (click to cycle)`,
            icon: themeIcon,
            onClick: () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"),
        },
    ], [theme, themeIcon, themeLabel, setTheme])
    return <SpeedDial actions={actions} />
}

import { useState, useEffect, useRef } from 'react'
import { FaGithub } from 'react-icons/fa'
import { MdBrightnessAuto, MdLightMode, MdDarkMode } from 'react-icons/md'
import { useTheme } from '../contexts/ThemeContext'
import { GitHub } from '../socials'
import css from './ThemeToggle.module.scss'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [isVisible, setIsVisible] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const lastScrollY = useRef(0)
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY
      const scrollingDown = currentScrollY > lastScrollY.current
      const nearBottom = (window.innerHeight + currentScrollY) >= (document.body.scrollHeight - 100)

      // Clear any pending hide timeout
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current)
        hideTimeout.current = null
      }

      // Show when scrolling down past 30px OR near bottom
      if ((scrollingDown && currentScrollY > 30) || nearBottom) {
        setIsVisible(true)
        // Auto-hide after 2.5 seconds of no scrolling
        hideTimeout.current = setTimeout(() => setIsVisible(false), 2500)
      } else if (!scrollingDown) {
        // Hide when scrolling up
        setIsVisible(false)
      }

      lastScrollY.current = currentScrollY
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (hideTimeout.current) clearTimeout(hideTimeout.current)
    }
  }, [])

  const cycleTheme = () => {
    if (theme === 'light') setTheme('dark')
    else if (theme === 'dark') setTheme('system')
    else setTheme('light')
  }

  const getThemeIcon = () => {
    switch (theme) {
      case 'light': return <MdLightMode />
      case 'dark': return <MdDarkMode />
      case 'system': return <MdBrightnessAuto />
    }
  }

  const getThemeLabel = () => {
    switch (theme) {
      case 'light': return 'Light'
      case 'dark': return 'Dark'
      case 'system': return 'System'
    }
  }

  const showControls = isVisible || isHovering

  return (
    <div
      className={css.container}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div className={`${css.controls} ${showControls ? css.visible : ''}`}>
        <a
          href={GitHub.href}
          target="_blank"
          rel="noopener noreferrer"
          className={css.githubLink}
          title="View on GitHub"
          aria-label="View project on GitHub"
        >
          <FaGithub />
        </a>
        <button
          className={css.themeToggle}
          onClick={cycleTheme}
          title={`Theme: ${getThemeLabel()}`}
          aria-label={`Current theme: ${getThemeLabel()}. Click to cycle themes.`}
        >
          <span className={css.themeIcon}>{getThemeIcon()}</span>
        </button>
      </div>
    </div>
  )
}

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem('powfi-theme', theme)
  } catch {
    // localStorage unavailable (private mode etc.) — theme just won't persist.
  }
}

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 1020.354 15.354Z"/></svg>`

export function themeToggleButton(): string {
  const theme = getTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return `<button class="theme-toggle" id="theme-toggle" aria-label="Switch to ${next} theme" title="Switch to ${next} theme">${theme === 'dark' ? SUN_ICON : MOON_ICON}</button>`
}

/** Wires up the toggle button rendered by `themeToggleButton()`. Call after each render. */
export function bindThemeToggle(onToggle: () => void): void {
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark')
    onToggle()
  })
}

export function logoUrl(): string {
  const theme = getTheme()
  return `${import.meta.env.BASE_URL}${theme === 'dark' ? 'alephium-logo-white.svg' : 'alephium-logo-black.svg'}`
}

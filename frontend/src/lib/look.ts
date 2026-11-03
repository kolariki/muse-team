import { create } from 'zustand'

/**
 * Muse Team's identity («Equipo», with the dark «Taller» builder), live everywhere since 2026-10-30, and the theme the user picks:
 * - light: everything light, the builder included
 * - dark: everything dark («Taller» tokens), the home included
 * - auto: the computer's setting; in light mode the home stays light and the builder is the dark «Taller»
 * Dark is the default for everyone until they pick another one (the landing page has the light/dark switch too).
 * In development a switch (bottom left) still compares the identity with the previous look; VITE_NEW_LOOK=0 builds the previous look.
 */
const KEY = 'tably.look'
const THEME_KEY = 'tably.theme'
export const NEW_LOOK_AVAILABLE = import.meta.env.VITE_NEW_LOOK !== '0'
/** The comparison switch is a development tool: production always shows the identity. */
export const LOOK_SWITCH = import.meta.env.DEV

export type Theme = 'light' | 'dark' | 'auto'
export const useTheme = create<{ theme: Theme }>(() => ({ theme: readTheme() }))

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'auto' ? t : 'dark'  // everyone starts dark until they pick another theme
  } catch { return 'dark' }
}

export function newLookOn(): boolean {
  if (!NEW_LOOK_AVAILABLE) return false
  if (!LOOK_SWITCH) return true
  try { return localStorage.getItem(KEY) !== 'old' } catch { return true }
}

export function setNewLook(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'new' : 'old') } catch { /* private mode */ }
  applyLook()
}

export function setTheme(theme: Theme) {
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode */ }
  useTheme.setState({ theme })
  paint()
}

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
let inBuilder = false

/** The classes on <html>: the identity, and the dark tokens wherever this theme says dark. */
function paint() {
  const on = newLookOn()
  const theme = useTheme.getState().theme
  const dark = on && (theme === 'dark' || (theme === 'auto' && (systemDark() || inBuilder)))
  document.documentElement.classList.toggle('look-equipo', on)
  document.documentElement.classList.toggle('look-taller', dark)
}

let fontsLoaded = false
let watching = false
/** Puts the identity's classes on <html>, loads its typefaces once and follows the computer's light/dark setting. */
export function applyLook() {
  paint()
  if (newLookOn() && !fontsLoaded) {
    fontsLoaded = true
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400..900&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap'
    document.head.appendChild(l)
  }
  if (!watching && typeof matchMedia === 'function') {
    watching = true
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint)
  }
}

/** The builder is the dark «Taller» in the automatic theme (its modals mount on <body>, so the class goes on <html>). */
export function setBuilderLook(builder: boolean) {
  inBuilder = builder
  paint()
}

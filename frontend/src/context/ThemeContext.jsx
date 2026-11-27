import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

// Keep STORAGE_KEY / colours in sync with the no-flash script in index.html.
export const STORAGE_KEY = 'rm.theme'
export const THEMES = ['light', 'dark', 'system']
const META_COLOR = { light: '#0f766e', dark: '#0a0f1c' }

const ThemeCtx = createContext({ theme: 'system', resolved: 'light', setTheme: () => {} })

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return THEMES.includes(v) ? v : 'system'
  } catch { return 'system' }
}

function apply(resolved) {
  const root = document.documentElement
  if (root.classList.contains('dark') === (resolved === 'dark')) return
  // Switch without letting every `transition` utility animate its colours separately.
  root.classList.add('theme-switching')
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[resolved])
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored)
  const [systemDark, setSystemDark] = useState(() => Boolean(media()?.matches))
  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => { apply(resolved) }, [resolved])

  // Follow the OS setting live while on "system".
  useEffect(() => {
    const mq = media()
    if (!mq) return
    const onChange = (e) => setSystemDark(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // Keep other open tabs in step.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === STORAGE_KEY) setThemeState(THEMES.includes(e.newValue) ? e.newValue : 'system') }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((next) => {
    if (!THEMES.includes(next)) return
    try { localStorage.setItem(STORAGE_KEY, next) } catch { }
    setThemeState(next)
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export const useTheme = () => useContext(ThemeCtx)

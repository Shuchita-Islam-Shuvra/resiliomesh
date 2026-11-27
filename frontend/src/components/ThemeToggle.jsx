import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/** Header button: shows the active look (sun / moon) and opens a Light · Dark · System menu. */
export default function ThemeToggle({ className = '' }) {
  const { theme, resolved, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const Icon = resolved === 'dark' ? Moon : Sun

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); wrap.current?.querySelector('button')?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Theme: ${theme === 'system' ? `system (${resolved})` : theme}. Change theme`} title="Change theme"
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={resolved} initial={{ rotate: -90, opacity: 0, scale: 0.6 }} animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: 90, opacity: 0, scale: 0.6 }} transition={{ duration: 0.18 }} className="flex">
            <Icon className="h-5 w-5" aria-hidden />
          </motion.span>
        </AnimatePresence>
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul role="menu" aria-label="Theme" initial={{ opacity: 0, y: -4, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }} transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-[700] mt-2 w-40 origin-top-right overflow-hidden rounded-xl border border-slate-200 bg-surface p-1 shadow-xl">
            {OPTIONS.map(({ value, label, icon: OptIcon }) => (
              <li key={value} role="none">
                <button type="button" role="menuitemradio" aria-checked={theme === value}
                  onClick={() => { setTheme(value); setOpen(false) }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition hover:bg-slate-100 ${theme === value ? 'font-semibold text-brand-700' : 'text-slate-700'}`}>
                  <OptIcon className="h-4 w-4" aria-hidden />{label}
                  {theme === value && <Check className="ml-auto h-4 w-4" aria-hidden />}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Inline segmented control (used on the Account page). */
export function ThemeSegmented({ className = '' }) {
  const { theme, setTheme } = useTheme()
  return (
    <div role="radiogroup" aria-label="Theme" className={`inline-flex gap-1 rounded-xl bg-slate-100 p-1 ring-1 ring-inset ring-slate-200 ${className}`}>
      {OPTIONS.map(({ value, label, icon: OptIcon }) => {
        const active = theme === value
        return (
          <button key={value} type="button" role="radio" aria-checked={active} onClick={() => setTheme(value)}
            className={`relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
            {active && <motion.span layoutId="theme-seg" aria-hidden className="absolute inset-0 rounded-lg bg-surface shadow-sm ring-1 ring-slate-200"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            <OptIcon className="relative h-4 w-4" aria-hidden /><span className="relative">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

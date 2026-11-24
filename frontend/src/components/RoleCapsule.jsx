import { useEffect, useId, useRef } from 'react'
import { motion } from 'framer-motion'
import { ROLES } from '../lib/roles'

/**
 * Capsule-shaped segmented control listing every user type.
 * Keyboard: arrow keys / Home / End move between roles (WAI-ARIA tabs pattern).
 */
export default function RoleCapsule({ value, onChange, dark = false, compact = false, className = '', label = 'Choose your account type' }) {
  const group = useId()
  const refs = useRef([])
  const idx = Math.max(0, ROLES.findIndex((r) => r.key === value))
  // keep the selected pill visible when the bar scrolls sideways on small screens
  // (horizontal only — never scrolls the page itself)
  const bar = useRef(null)
  useEffect(() => {
    const c = bar.current, el = refs.current[idx]
    if (!c || !el || c.scrollWidth <= c.clientWidth) return
    const left = el.offsetLeft, right = left + el.offsetWidth
    if (left < c.scrollLeft) c.scrollTo({ left: left - 8, behavior: 'smooth' })
    else if (right > c.scrollLeft + c.clientWidth) c.scrollTo({ left: right - c.clientWidth + 8, behavior: 'smooth' })
  }, [idx])

  const onKey = (e) => {
    let n = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (idx + 1) % ROLES.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (idx - 1 + ROLES.length) % ROLES.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = ROLES.length - 1
    if (n === null) return
    e.preventDefault()
    onChange(ROLES[n].key)
    refs.current[n]?.focus()
  }

  return (
    <div ref={bar} role="tablist" aria-label={label} onKeyDown={onKey}
      className={`no-scrollbar relative flex max-w-full gap-1 overflow-x-auto rounded-full p-1.5 shadow-inner ring-1 ring-inset ${
        dark ? 'bg-white/10 ring-white/15 backdrop-blur' : 'bg-slate-100/90 ring-slate-200'} ${className}`}>
      {ROLES.map((r, i) => {
        const active = r.key === value
        const Icon = r.icon
        return (
          <button key={r.key} ref={(el) => { refs.current[i] = el }} type="button" role="tab"
            aria-selected={active} tabIndex={active ? 0 : -1} onClick={() => onChange(r.key)}
            aria-label={r.label} title={r.label}
            className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ${compact ? 'flex-1 justify-center px-3 py-2' : 'px-3.5 py-2'} text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
              active ? (dark ? 'text-slate-900' : 'text-white') : (dark ? 'text-slate-200 hover:text-white' : 'text-slate-600 hover:text-slate-900')}`}>
            {active && (
              <motion.span layoutId={`capsule-${group}`} aria-hidden
                className={`absolute inset-0 rounded-full shadow-md ${dark ? 'bg-white' : 'bg-gradient-to-b from-brand-600 to-brand-700 shadow-brand-900/20'}`}
                transition={{ type: 'spring', stiffness: 420, damping: 34 }} />
            )}
            <Icon className="relative h-4 w-4" aria-hidden />
            {/* phones: only the selected pill shows its name, the rest are icons */}
            <span className={`relative ${active ? '' : 'hidden sm:inline'}`}>{compact ? r.short : r.label}</span>
          </button>
        )
      })}
    </div>
  )
}

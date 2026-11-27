import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import { animate, motion, useInView } from 'framer-motion'
import { ChevronDown, ChevronUp, ChevronsUpDown, Loader2, X } from 'lucide-react'
import { RISK_COLOR, STATUS_STYLE, humanize } from '../lib/format'

export function AnimatedNumber({ value, decimals = 0, suffix = '' }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })
  const num = Number(value)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (!inView || !Number.isFinite(num)) return
    const c = animate(0, num, { duration: 0.9, ease: 'easeOut', onUpdate: setShown })
    return () => c.stop()
  }, [inView, num])
  if (value === null || value === undefined || value === '—' || !Number.isFinite(num)) return <span ref={ref}>{value ?? '—'}</span>
  return <span ref={ref} className="tabular-nums">{shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</span>
}

export const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.35, delay: Math.min(i, 8) * 0.05, ease: 'easeOut' } }),
}

export function Skeleton({ className = 'h-4 w-full' }) {
  return <div className={`skeleton ${className}`} aria-hidden />
}

export function Button({ variant = 'primary', size = 'md', loading, className = '', children, ...props }) {
  const v = {
    primary: 'bg-gradient-to-b from-brand-600 to-brand-700 text-white hover:from-brand-700 hover:to-brand-800 disabled:opacity-50',
    secondary: 'bg-surface text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-60',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-600/50',
    ghost: 'text-slate-600 hover:bg-slate-100 disabled:opacity-50',
    warning: 'bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50',
  }[variant]
  const s = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' }[size]
  return (
    <motion.button whileTap={{ scale: 0.97 }} {...props} disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium shadow-sm transition-colors disabled:cursor-not-allowed ${v} ${s} ${className}`}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </motion.button>
  )
}

export function Card({ title, subtitle, actions, icon: Icon, className = '', bodyClass = 'p-4 sm:p-5', children, index = 0 }) {
  return (
    <motion.section variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-40px' }} custom={index}
      className={`min-w-0 rounded-2xl border border-slate-200/80 bg-surface/90 shadow-sm shadow-slate-200/50 backdrop-blur-sm ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && <span className="rounded-lg bg-brand-50 p-1.5 text-brand-700"><Icon className="h-4 w-4" aria-hidden /></span>}
            <div className="min-w-0">
              {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
              {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`min-w-0 ${bodyClass}`}>{children}</div>
    </motion.section>
  )
}

export function PageHeader({ title, description, actions, children, eyebrow }) {
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
      className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">{eyebrow}</p>}
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </motion.div>
  )
}

export function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLE[status] || STATUS_STYLE.pending}`}>
      {humanize(status)}
    </span>
  )
}

export function RiskBadge({ level, score }) {
  if (!level) return <span className="text-xs text-slate-400">Not assessed</span>
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold text-white"
      style={{ background: RISK_COLOR[level] }}>
      {humanize(level)}{score !== undefined && score !== null && <span className="font-normal opacity-90">{Number(score).toFixed(0)}</span>}
    </span>
  )
}

const TONES = {
  brand: ['bg-brand-50 text-brand-700', 'from-brand-500 to-brand-300'],
  red: ['bg-rose-50 text-rose-600', 'from-rose-500 to-rose-300'],
  amber: ['bg-amber-50 text-amber-600', 'from-amber-500 to-amber-300'],
  green: ['bg-emerald-50 text-emerald-600', 'from-emerald-500 to-emerald-300'],
  sky: ['bg-sky-50 text-sky-600', 'from-sky-500 to-sky-300'],
  violet: ['bg-violet-50 text-violet-600', 'from-violet-500 to-violet-300'],
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'brand', suffix = '', decimals = 0, index = 0 }) {
  const [chip, bar] = TONES[tone] || TONES.brand
  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" custom={index} whileHover={{ y: -3 }}
      className="relative min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-surface p-4 shadow-sm transition-shadow hover:shadow-md">
      <span className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {Icon && <span className={`rounded-lg p-1.5 ${chip}`}><Icon className="h-4 w-4" aria-hidden /></span>}
      </div>
      <p className="mt-2 truncate text-2xl font-bold text-slate-900"><AnimatedNumber value={value} suffix={suffix} decimals={decimals} /></p>
      {hint && <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>}
    </motion.div>
  )
}

export function Field({ label, error, hint, required, children, className = '' }) {
  const id = useId()
  const child = typeof children === 'function'
    ? children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': error ? `${id}-err` : hint ? `${id}-hint` : undefined })
    : children
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}{required && <span className="text-rose-600" aria-hidden> *</span>}
      </label>
      {child}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-xs font-medium text-rose-600">{error}</p>}
    </div>
  )
}

const inputCls = 'block w-full rounded-lg border-0 bg-surface px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600 aria-[invalid=true]:ring-rose-500 disabled:bg-slate-50'
export const Input = (p) => <input {...p} className={`${inputCls} ${p.className || ''}`} />
export const Textarea = (p) => <textarea {...p} className={`${inputCls} ${p.className || ''}`} />
export const Select = ({ children, ...p }) => <select {...p} className={`${inputCls} pr-8 ${p.className || ''}`}>{children}</select>

export function Modal({ open, onClose, title, children, footer, wide, plain }) {
  const ref = useRef()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement
    ref.current?.querySelector('input,select,textarea,button')?.focus()
    const onKey = (e) => e.key === 'Escape' && closeRef.current?.()
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className={`fixed inset-0 z-[900] flex items-end justify-center ${plain ? 'bg-transparent' : 'bg-ink-900/50 backdrop-blur-[2px] dark:bg-black/75 dark:backdrop-blur-sm'} p-0 sm:items-center sm:p-4`} onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl sm:rounded-3xl ${plain ? 'bg-brand-900 text-white/90' : 'bg-surface'} ${plain ? 'shadow-2xl ring-1 ring-brand-400/40' : 'shadow-xl dark:shadow-2xl dark:shadow-black/60 dark:ring-1 dark:ring-white/10'} ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>
        <div className={`sticky top-0 flex items-center justify-between px-5 py-3 ${plain ? 'bg-gradient-to-r from-brand-700 to-brand-500 text-white py-6' : 'border-b border-slate-100 bg-surface'}`}>
          <h2 className={`font-semibold ${plain ? 'text-white' : 'text-slate-900'}`}>{title}</h2>
          <button onClick={onClose} className={`rounded p-1 ${plain ? 'text-white/80 hover:bg-white/20 hover:text-white' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`} aria-label="Close dialog"><X className="h-5 w-5" /></button>
        </div>
        <div className={plain ? "px-6 py-10" : "p-5"}>{children}</div>
        {footer && <div className={`flex flex-wrap justify-end gap-2 border-t px-5 ${plain ? 'border-white/10 bg-brand-800 py-5' : 'border-slate-100 py-3'}`}>{footer}</div>}
      </div>
    </div>
  , document.body)
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div role="status" className="space-y-3 py-6">
      <span className="sr-only">{label}</span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}</div>
      <Skeleton className="h-64 w-full rounded-2xl" />
      <p className="flex items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{label}</p>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      {Icon && <Icon className="mb-2 h-8 w-8 text-slate-300" aria-hidden />}
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  )
}

export function Alert({ tone = 'info', title, children, className = '' }) {
  const s = {
    info: 'border-sky-200 bg-sky-50 text-sky-900', warning: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900', success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'note'} className={`rounded-lg border px-4 py-3 text-sm ${s} ${className}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? 'mt-0.5' : ''}>{children}</div>
    </div>
  )
}

export function SortTh({ label, field, sort, onSort, className = '' }) {
  const active = sort.field === field
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ChevronUp : ChevronDown
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}>
      <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-800">
        {label}<Icon className="h-3.5 w-3.5" aria-hidden />
      </button>
    </th>
  )
}

export const Th = ({ children, className = '' }) => (
  <th scope="col" className={`px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}>{children}</th>
)

export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
      <span>{total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}</span>
      <div className="flex gap-1">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </nav>
  )
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${value === t.value ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'
import RoleCapsule from './RoleCapsule'
import ThemeToggle from './ThemeToggle'
import { ROLE_BY_KEY } from '../lib/roles'

export default function PortalLayout({
  role = 'citizen', onRoleChange, eyebrow, heading, blurb, title, subtitle, headerLink, children,
}) {
  const R = ROLE_BY_KEY[role] || ROLE_BY_KEY.citizen
  const Icon = R.icon
  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-3">
            <img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
            <span className="text-lg font-bold tracking-tight text-slate-900">ResilioMesh</span>
          </Link>
          <nav className="ml-auto flex items-center gap-1" aria-label="Account">
            <ThemeToggle />
            <Link to="/" className="hidden items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 sm:inline-flex"><ArrowLeft className="h-4 w-4" aria-hidden />Home</Link>
            {headerLink && (
              <Link to={headerLink.to} className={headerLink.primary
                ? 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700'
                : 'rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100'}>{headerLink.label}</Link>
            )}
          </nav>
        </div>
      </header>

      <main className="min-h-[calc(100%-8.5rem)] bg-gradient-to-b from-surface to-brand-50/40">
        <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-10 sm:px-6 lg:py-14">
          {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{eyebrow}</p>}
          {heading && <h1 className="mt-2 text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{heading}</h1>}
          {blurb && <p className="mx-auto mt-2 max-w-xl text-center text-sm text-slate-600">{blurb}</p>}
          {onRoleChange && <RoleCapsule value={role} onChange={onRoleChange} className="mt-8 bg-surface shadow-lg shadow-slate-200/70" />}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${role}-${title}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}
              className="mt-6 w-full max-w-3xl rounded-3xl bg-surface p-5 shadow-sm ring-1 ring-slate-200 sm:p-8">
              <div className="mb-6 flex items-start gap-4">
                <span className="rounded-2xl bg-brand-50 p-3 text-brand-700 ring-1 ring-inset ring-brand-100"><Icon className="h-6 w-6" aria-hidden /></span>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
                  {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
                </div>
              </div>
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <footer className="border-t border-slate-200/70 py-6 text-center text-xs text-slate-500">
        ResilioMesh · Hack the Vibe 2026 · World Problem Solver Track
      </footer>
    </div>
  )
}

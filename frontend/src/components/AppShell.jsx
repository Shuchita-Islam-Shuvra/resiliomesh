import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BarChart3, Boxes, BrainCircuit, ClipboardList, CloudRain, HandHeart, LayoutDashboard, LogOut, Map,
  Menu, ShieldCheck, Smartphone, Workflow, X, Wifi, WifiOff,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useOnline } from '../hooks/useOnline'
import { flushOutbox } from '../offline/sync'
import { supabase } from '../lib/supabase'
import { ROLE_LABEL } from '../lib/format'

const COORD = ['city_officer', 'ngo_coordinator', 'admin']
const SECTIONS = [
  { title: 'Overview', items: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/map', label: 'Live Risk Map', icon: Map },
    { to: '/incidents', label: 'Reports & Assets', icon: ClipboardList },
  ] },
  { title: 'Intelligence', items: [
    { to: '/risk', label: 'AI Risk Analysis', icon: BrainCircuit, roles: COORD },
    { to: '/analytics', label: 'Analytics', icon: BarChart3, roles: COORD },
  ] },
  { title: 'Operations', items: [
    { to: '/resources', label: 'Resources & Allocation', icon: Boxes, roles: COORD },
    { to: '/ngo', label: 'NGO Coordination', icon: HandHeart, roles: COORD },
    { to: '/workflows', label: 'Workflows & Tasks', icon: Workflow, roles: COORD },
    { to: '/field', label: 'Field Portal', icon: Smartphone, roles: ['field_worker', 'admin'] },
  ] },
  { title: 'Governance', items: [
    { to: '/admin', label: 'Audit & Admin', icon: ShieldCheck, roles: ['admin'] },
  ] },
]

const ROLE_TONE = {
  admin: 'bg-violet-500/15 text-violet-200 ring-violet-400/30',
  city_officer: 'bg-sky-500/15 text-sky-200 ring-sky-400/30',
  ngo_coordinator: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
  field_worker: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  citizen: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30',
}

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t) }, [])
  return <span className="tabular-nums">{now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' })} · Dhaka</span>
}

export default function AppShell() {
  const { profile, org, signOut } = useAuth()
  const online = useOnline()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const location = useLocation()
  const outlet = useOutlet()
  const mainId = 'main'

  // any queued offline reports are flushed as soon as connectivity returns
  useEffect(() => {
    if (!online) return
    flushOutbox(supabase).then((r) => {
      if (r.synced) toast.success(`${r.synced} offline item(s) synced`)
      if (r.failed) toast.error(`${r.failed} offline item(s) were rejected by the server`)
    }).catch(() => {})
  }, [online]) // eslint-disable-line react-hooks/exhaustive-deps

  // scroll back to top on navigation (main is the scroll container)
  useEffect(() => { document.getElementById(mainId)?.scrollTo({ top: 0 }) }, [location.pathname])

  const sections = SECTIONS.map((s) => ({ ...s, items: s.items.filter((n) => !n.roles || n.roles.includes(profile?.role)) }))
    .filter((s) => s.items.length)

  const sidebar = (layoutGroup) => (
    <nav aria-label="Main" className="flex h-full flex-col bg-gradient-to-b from-ink-900 via-ink-900 to-ink-800 text-slate-300">
      <div className="flex items-center gap-3 px-5 py-5">
        <motion.img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl shadow-lg shadow-brand-900/40"
          initial={{ rotate: -12, scale: 0.8 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 14 }} />
        <div>
          <p className="text-base font-bold tracking-tight text-white">ResilioMesh</p>
          <p className="text-[11px] text-slate-400">Dhaka Flood Resilience</p>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {sections.map((s) => (
          <div key={s.title}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{s.title}</p>
            <ul className="space-y-0.5">
              {s.items.map(({ to, label, icon: Icon }) => (
                <li key={to}>
                  <NavLink to={to} onClick={() => setOpen(false)}
                    className={({ isActive }) => `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'text-white' : 'hover:bg-white/5 hover:text-white'}`}>
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span layoutId={`nav-pill-${layoutGroup}`} className="absolute inset-0 rounded-lg bg-gradient-to-r from-brand-700 to-brand-600 shadow-md shadow-brand-900/40"
                            transition={{ type: 'spring', stiffness: 380, damping: 32 }} />
                        )}
                        <Icon className="relative h-4 w-4" aria-hidden />
                        <span className="relative">{label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-sky-500 text-sm font-bold text-white">
            {profile?.full_name?.split(' ').map((p) => p[0]).slice(0, 2).join('')}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{profile?.full_name}</p>
            <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${ROLE_TONE[profile?.role]}`}>{ROLE_LABEL[profile?.role]}</span>
          </div>
        </div>
        {org && <p className="mt-2 truncate text-xs text-slate-400">{org.name}</p>}
        <button onClick={async () => { await signOut(); nav('/login') }}
          className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white">
          <LogOut className="h-4 w-4" aria-hidden /> Sign out
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className="hidden h-full w-64 shrink-0 lg:block">{sidebar('desktop')}</aside>

      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-[950] lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <motion.div className="relative h-full w-72 max-w-[85%]" initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}>
              {sidebar('mobile')}
              <button onClick={() => setOpen(false)} className="absolute right-3 top-6 rounded p-1 text-slate-300 hover:text-white" aria-label="Close menu"><X className="h-5 w-5" /></button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="z-[500] flex h-14 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur-md sm:px-6">
          <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <CloudRain className="h-4 w-4 text-brand-600" aria-hidden />
            <span className="hidden sm:inline"><Clock /></span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${online ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-100 text-amber-800 ring-amber-200'}`} role="status">
              {online ? <><span className="relative h-2 w-2 rounded-full bg-emerald-500 text-emerald-500 live-dot" /><Wifi className="h-3.5 w-3.5" aria-hidden />Live</> : <><WifiOff className="h-3.5 w-3.5" aria-hidden />Offline</>}
            </span>
          </div>
        </header>
        <main id={mainId} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={location.pathname} className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}>
              {outlet}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}

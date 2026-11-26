import { Suspense, useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BarChart3, Boxes, BrainCircuit, ChevronsLeft, ChevronsRight, ClipboardList, CloudRain, HandHeart, LayoutDashboard, LogOut, Map,
  Menu, Plus, ShieldCheck, Smartphone, UserCog, Workflow, X, Wifi, WifiOff,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useOnline } from '../hooks/useOnline'
import { flushOutbox } from '../offline/sync'
import { supabase } from '../lib/supabase'
import { areaLabel } from '../lib/areas'
import { ROLE_LABEL } from '../lib/format'
import { Spinner } from './ui'

const COORD = ['city_officer', 'ngo_coordinator', 'admin']
const OFFICERS = ['city_officer', 'admin']
const SECTIONS = [
  { title: 'Overview', items: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/map', label: 'Live Risk Map', icon: Map },
    { to: '/incidents', label: 'Reports & Assets', citizenLabel: 'My reports', icon: ClipboardList },
    { to: '/incidents/new', label: 'Report waterlogging', icon: Plus, roles: ['citizen'] },
  ] },
  { title: 'Intelligence', items: [
    { to: '/risk', label: 'AI Risk Analysis', icon: BrainCircuit, roles: COORD },
    { to: '/analytics', label: 'Analytics', icon: BarChart3, roles: COORD },
  ] },
  { title: 'Operations', items: [
    { to: '/resources', label: 'Resources & Allocation', icon: Boxes, roles: COORD },
    { to: '/ngo', label: 'NGO Coordination', icon: HandHeart, roles: COORD },
    { to: '/workflows', label: 'Workflows & Tasks', icon: Workflow, roles: OFFICERS },
    { to: '/field', label: 'Field Portal', icon: Smartphone, roles: ['field_worker', 'admin'] },
  ] },
  { title: 'Governance', items: [
    { to: '/admin', label: 'Audit & Admin', icon: ShieldCheck, roles: ['admin'] },
  ] },
  { title: 'Account', items: [
    { to: '/account', label: 'Account & security', icon: UserCog },
  ] },
]

const ROLE_TONE = {
  admin: 'bg-violet-50 text-violet-700 ring-violet-200',
  city_officer: 'bg-sky-50 text-sky-700 ring-sky-200',
  ngo_coordinator: 'bg-rose-50 text-rose-700 ring-rose-200',
  field_worker: 'bg-amber-50 text-amber-700 ring-amber-200',
  citizen: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
}

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t) }, [])
  return <span className="tabular-nums">{now.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' })} · Dhaka</span>
}

export default function AppShell() {
  const { profile, area, adminScope, signOut } = useAuth()
  const online = useOnline()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('rm.sidebar') === 'collapsed' } catch { return false } })
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem('rm.sidebar', c ? 'open' : 'collapsed') } catch { }
    return !c
  })
  const nav = useNavigate()
  const location = useLocation()
  const outlet = useOutlet()
  const mainId = 'main'

  useEffect(() => {
    if (!online) return
    flushOutbox(supabase).then((r) => {
      if (r.synced) toast.success(`${r.synced} offline item(s) synced`)
      if (r.failed) toast.error(`${r.failed} offline item(s) were rejected by the server`)
    }).catch(() => {})
  }, [online])

  useEffect(() => { document.getElementById(mainId)?.scrollTo({ top: 0 }) }, [location.pathname])

  const sections = SECTIONS.map((s) => ({ ...s, items: s.items.filter((n) => !n.roles || n.roles.includes(profile?.role))
    .map((n) => (profile?.role === 'citizen' && n.citizenLabel ? { ...n, label: n.citizenLabel } : n)) }))
    .filter((s) => s.items.length)

  const initials = profile?.full_name?.split(' ').map((p) => p[0]).slice(0, 2).join('')
  const sidebar = (layoutGroup, mini = false) => (
    <nav aria-label="Main" className="flex h-full flex-col overflow-hidden border-r border-slate-200 bg-white text-slate-700">
      <div className={`flex items-center gap-3 py-6 ${mini ? 'justify-center px-2' : 'px-6'}`}>
        <motion.img src="/icon.svg" alt="" className="h-10 w-10 shrink-0 rounded-xl"
          initial={{ rotate: -12, scale: 0.8 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 14 }} />
        {!mini && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-bold tracking-tight text-slate-900">ResilioMesh</p>
            <p className="truncate text-[11px] text-slate-500">Dhaka Flood Resilience</p>
          </div>
        )}
        {layoutGroup === 'desktop' && !mini && (
          <button onClick={toggleCollapsed} aria-label="Collapse sidebar" title="Collapse sidebar"
            className="rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
            <ChevronsLeft className="h-5 w-5" />
          </button>
        )}
      </div>
      {layoutGroup === 'desktop' && mini && (
        <button onClick={toggleCollapsed} aria-label="Expand sidebar" title="Expand sidebar"
          className="mx-auto mb-2 rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
          <ChevronsRight className="h-5 w-5" />
        </button>
      )}
      <div className="flex-1 space-y-5 overflow-y-auto overflow-x-hidden pb-4">
        {sections.map((s) => (
          <div key={s.title}>
            {mini
              ? <div className="mx-4 mb-2 border-t border-slate-200" />
              : <p className="px-6 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{s.title}</p>}
            <ul>
              {s.items.map(({ to, label, icon: Icon }) => (
                <motion.li key={to} whileTap={{ scale: 0.97 }} transition={{ type: 'spring', stiffness: 500, damping: 15 }}>
                  <NavLink to={to} end={to === '/incidents'} onClick={() => setOpen(false)} title={mini ? label : undefined} aria-label={mini ? label : undefined}
                    className={({ isActive }) => `group relative flex items-center gap-3.5 overflow-hidden py-3 text-[15px] font-medium outline-offset-[-2px] transition-colors duration-200 ${mini ? 'justify-center px-0' : 'px-6'} ${isActive ? 'text-white delay-150' : 'text-slate-700 delay-100 hover:text-white hover:delay-[60ms] focus-visible:text-white'}`}>
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span layoutId={`nav-block-${layoutGroup}`} aria-hidden
                            className="absolute inset-0 bg-brand-700 shadow-[inset_4px_0_0_0_var(--color-brand-400)]"
                            transition={{ type: 'spring', stiffness: 420, damping: 26 }} />
                        )}
                        {!isActive && <span aria-hidden className="nav-fill" />}
                        <motion.span className="relative flex" whileTap={{ scale: 0.8 }}
                          animate={isActive ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                          transition={{ duration: 0.35, ease: 'easeOut' }}>
                          <Icon className={`h-5 w-5 shrink-0 transition-[color,transform] duration-200 group-hover:translate-x-0.5 ${isActive ? 'text-white' : 'text-slate-500 delay-100 group-hover:text-white group-hover:delay-[40ms] group-focus-visible:text-white'}`} aria-hidden />
                        </motion.span>
                        {!mini && <span className="relative truncate">{label}</span>}
                      </>
                    )}
                  </NavLink>
                </motion.li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-slate-200 py-2">
        <button onClick={async () => { await signOut(); nav('/') }} title={mini ? 'Sign out' : undefined} aria-label={mini ? 'Sign out' : undefined}
          className={`group relative flex w-full items-center gap-3.5 overflow-hidden py-3 text-[15px] font-medium text-slate-700 outline-offset-[-2px] transition-colors duration-200 delay-100 hover:text-white hover:delay-[60ms] focus-visible:text-white ${mini ? 'justify-center px-0' : 'px-6'}`}>
          <span aria-hidden className="nav-fill nav-fill-danger" />
          <LogOut className="relative h-5 w-5 shrink-0 text-slate-500 transition-[color,transform] duration-200 delay-100 group-hover:translate-x-0.5 group-hover:text-white group-hover:delay-[40ms] group-focus-visible:text-white" aria-hidden />
          {!mini && <span className="relative truncate">Sign out</span>}
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="skip-link">Skip to content</a>
      <motion.aside className="hidden h-full shrink-0 lg:block" initial={false} animate={{ width: collapsed ? 76 : 272 }}
        transition={{ type: 'spring', stiffness: 300, damping: 32 }}>{sidebar('desktop', collapsed)}</motion.aside>

      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-[950] lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <motion.div className="relative h-full w-72 max-w-[85%]" initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}>
              {sidebar('mobile')}
              <button onClick={() => setOpen(false)} className="absolute right-3 top-6 rounded p-1 text-slate-500 hover:text-slate-900" aria-label="Close menu"><X className="h-5 w-5" /></button>
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
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${online ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-100 text-amber-800 ring-amber-200'}`} role="status">
              {online ? <><span className="relative h-2 w-2 rounded-full bg-red-500 text-red-500 live-dot" /><Wifi className="h-3.5 w-3.5" aria-hidden />Live</> : <><WifiOff className="h-3.5 w-3.5" aria-hidden />Offline</>}
            </span>
            <div className="flex items-center gap-3 border-l border-slate-200 pl-3">
              <div className="hidden min-w-0 text-center sm:block">
                <p className="translate-y-[3px] truncate text-base font-bold leading-tight tracking-tight text-slate-900">{profile?.full_name}</p>
                <span className={`mt-1.5 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none ring-1 ring-inset ${ROLE_TONE[profile?.role] || ''}`}>{ROLE_LABEL[profile?.role]}{(profile?.role === 'city_officer' || area) && ` · ${areaLabel(area)}`}{adminScope && ` · ${adminScope === 'owner' ? 'System owner' : 'Security & audit'}`}</span>
              </div>
              <div aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white">{initials}</div>
            </div>
          </div>
        </header>
        <main id={mainId} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={location.pathname} className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}>
              <Suspense fallback={<Spinner />}>{outlet}</Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}

import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BadgeCheck, BarChart3, Boxes, BrainCircuit, Building2, ChevronsLeft, ChevronsRight, ClipboardList, CloudRain, Eye, EyeOff, HandHeart,
  KeyRound, LayoutDashboard, LogOut, Mail, Map, Menu, Phone, Plus, ShieldCheck, Smartphone, UserCog, Workflow, X, Wifi, WifiOff,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useOnline } from '../hooks/useOnline'
import { flushOutbox } from '../offline/sync'
import { supabase } from '../lib/supabase'
import { areaLabel } from '../lib/areas'
import { ROLE_LABEL } from '../lib/format'
import { isDemoEmail } from '../lib/demoAccounts'
import { errorMessage } from '../lib/errors'
import NotificationBell from './NotificationBell'
import ThemeToggle from './ThemeToggle'
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

function ProfileMenu({ initials, roleLine, onSignOut }) {
  const { profile, session, org, updatePassword } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const location = useLocation()
  const box = useRef(null)
  const [open, setOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const email = session?.user?.email || ''
  const demo = isDemoEmail(email)

  const reset = () => { setPwOpen(false); setPw(''); setPw2(''); setErr(''); setShow(false) }
  const close = () => { setOpen(false); reset() }

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  useEffect(() => { close() }, [location.pathname])

  const savePassword = async (e) => {
    e.preventDefault()
    setErr('')
    if (pw.length < 8) { setErr('Use at least 8 characters'); return }
    if (pw !== pw2) { setErr('The two passwords do not match'); return }
    setBusy(true)
    try {
      await updatePassword(pw)
      toast.success('Password updated')
      reset()
    } catch (x) {
      setErr(/reauth|recent/i.test(x?.message || '') ? 'For security, sign out and sign in again, then change your password.' : errorMessage(x))
    } finally { setBusy(false) }
  }

  const row = 'flex items-start gap-3 px-4 py-2 text-sm'
  const inp = 'block w-full rounded-lg border-0 bg-surface px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600'
  return (
    <div className="relative border-l border-slate-200 pl-3" ref={box}>
      <button type="button" onClick={() => (open ? close() : setOpen(true))} aria-haspopup="dialog" aria-expanded={open} aria-label="Open profile"
        className="flex items-center gap-3 rounded-full p-0.5 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-600">
        <span className="hidden min-w-0 text-center sm:block">
          <span className="block translate-y-[3px] truncate text-base font-bold leading-tight tracking-tight text-slate-900">{profile?.full_name}</span>
          <span className={`mt-1.5 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none ring-1 ring-inset ${ROLE_TONE[profile?.role] || ''}`}>{roleLine}</span>
        </span>
        <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white transition ${open ? 'ring-2 ring-brand-400 ring-offset-2 ring-offset-surface' : ''}`}>{initials}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div role="dialog" aria-label="Your profile"
            initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={{ duration: 0.15 }}
            className="fixed left-4 right-4 top-14 z-[600] mt-1 max-h-[85vh] overflow-y-auto rounded-xl border border-slate-200 bg-surface shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[340px]">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-4">
              <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-lg font-bold text-white">{initials}</span>
              <div className="min-w-0">
                <p className="truncate font-bold text-slate-900">{profile?.full_name}</p>
                <span className={`mt-1 inline-block max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${ROLE_TONE[profile?.role] || ''}`}>{roleLine}</span>
              </div>
            </div>

            <div className="border-b border-slate-100 py-2">
              {email && <div className={row}><Mail className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden /><span className="min-w-0 break-all text-slate-700">{email}</span></div>}
              <div className={row}><Phone className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <span className="text-slate-700">{profile?.phone || <span className="text-slate-400">No mobile number</span>}
                  {profile?.phone && profile?.phone_verified_at && <BadgeCheck className="ml-1 inline h-4 w-4 text-emerald-600" aria-label="Verified" />}</span>
              </div>
              {org?.name && <div className={row}><Building2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden /><span className="text-slate-700">{org.name}</span></div>}
            </div>

            <div className="border-b border-slate-100 p-2">
              {!pwOpen ? (
                <button type="button" onClick={() => setPwOpen(true)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100">
                  <KeyRound className="h-4 w-4 text-slate-500" aria-hidden />Change password
                </button>
              ) : demo ? (
                <div className="px-2 py-2 text-sm">
                  <p className="flex items-center gap-2 font-medium text-slate-800"><KeyRound className="h-4 w-4 text-slate-500" aria-hidden />Change password</p>
                  <p className="mt-1 text-xs text-slate-500">This is a shared demo account, so its password cannot be changed.</p>
                  <button type="button" onClick={reset} className="mt-2 text-xs font-medium text-brand-700 hover:underline">Close</button>
                </div>
              ) : (
                <form onSubmit={savePassword} noValidate className="space-y-2 px-2 py-2">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-800"><KeyRound className="h-4 w-4 text-slate-500" aria-hidden />Change password</p>
                  <div className="relative">
                    <input type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus placeholder="New password (min 8 characters)" aria-label="New password"
                      value={pw} onChange={(e) => setPw(e.target.value)} className={`${inp} pr-9`} />
                    <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}
                      className="absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-400 hover:text-slate-700">
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <input type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="Confirm new password" aria-label="Confirm new password"
                    value={pw2} onChange={(e) => setPw2(e.target.value)} className={inp} />
                  {err && <p role="alert" className="text-xs font-medium text-rose-600">{err}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={reset} className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">Cancel</button>
                    <button type="submit" disabled={busy} className="rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-60">
                      {busy ? 'Saving…' : 'Update password'}
                    </button>
                  </div>
                </form>
              )}
              <button type="button" onClick={() => { close(); nav('/account') }}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100">
                <UserCog className="h-4 w-4 text-slate-500" aria-hidden />Account &amp; security
              </button>
            </div>

            <div className="p-2">
              <button type="button" onClick={() => { close(); onSignOut() }}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm font-medium text-rose-600 transition hover:bg-rose-50">
                <LogOut className="h-4 w-4" aria-hidden />Sign out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
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
    <nav aria-label="Main" className="flex h-full flex-col overflow-hidden border-r border-slate-200 bg-surface text-slate-700">
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
            <div className="absolute inset-0 bg-ink-900/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <motion.div className="relative h-full w-72 max-w-[85%]" initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}>
              {sidebar('mobile')}
              <button onClick={() => setOpen(false)} className="absolute right-3 top-6 rounded p-1 text-slate-500 hover:text-slate-900" aria-label="Close menu"><X className="h-5 w-5" /></button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="z-[500] flex h-14 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-surface/80 px-4 backdrop-blur-md sm:px-6">
          <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <CloudRain className="h-4 w-4 text-brand-600" aria-hidden />
            <span className="hidden sm:inline"><Clock /></span>
          </div>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <ThemeToggle />
            <NotificationBell />
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${online ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-100 text-amber-800 ring-amber-200'}`} role="status">
              {online ? <><span className="relative h-2 w-2 rounded-full bg-red-500 text-red-500 live-dot" /><Wifi className="h-3.5 w-3.5" aria-hidden />Live</> : <><WifiOff className="h-3.5 w-3.5" aria-hidden />Offline</>}
            </span>
            <ProfileMenu initials={initials} roleLine={`${ROLE_LABEL[profile?.role] || ''}${(profile?.role === 'city_officer' || area) ? ` · ${areaLabel(area)}` : ''}${adminScope ? ` · ${adminScope === 'owner' ? 'System owner' : 'Security & audit'}` : ''}`}
              onSignOut={async () => { await signOut(); nav('/') }} />

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

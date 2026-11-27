import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowDown, LogIn, MailCheck, UserPlus } from 'lucide-react'
import { Alert, Button, Field, Input, Select } from '../components/ui'
import { PasswordInput } from '../components/PasswordInput'
import DemoProfiles from '../components/DemoProfiles'
import PortalLayout from '../components/PortalLayout'
import { useAuth } from '../context/AuthContext'
import { api } from '../lib/api'
import { ROLE_BY_KEY, roleOrDefault } from '../lib/roles'
import { supabase } from '../lib/supabase'
import { SIGNIN_ID_LABEL, validateEmail, validateSignIn } from '../lib/validation'

const DEMO = {
  citizen: { email: 'citizen@resiliomesh.demo' },
  city_officer: { email: 'officer@resiliomesh.demo', employee_id: 'DSCC-OFF-01' },
  ngo_coordinator: { email: 'ngo@resiliomesh.demo', organization_id: '11111111-1111-1111-1111-111111111103', org: 'Shobar Jonno Relief Network' },
  field_worker: { email: 'field1@resiliomesh.demo', employee_id: 'FW-001' },
  admin: { email: 'admin@resiliomesh.demo', employee_id: 'ADM-001' },
}
const DEMO_ADMIN2 = { email: 'admin2@resiliomesh.demo', employee_id: 'ADM-002' }
const ID_PLACEHOLDER = { city_officer: 'e.g. DSCC-OFF-01', field_worker: 'e.g. FW-001', admin: 'e.g. ADM-001' }

const MAX_FAILS = 5
const LOCK_MS = 30_000
const LOCK_KEY = 'rm_login_lock'
const readLock = () => { try { return JSON.parse(sessionStorage.getItem(LOCK_KEY)) || { fails: 0, until: 0 } } catch { return { fails: 0, until: 0 } } }
const writeLock = (v) => { try { sessionStorage.setItem(LOCK_KEY, JSON.stringify(v)) } catch { } }

const EMPTY = { email: '', password: '', employee_id: '', organization_id: '' }

export default function LoginPage() {
  const { signInAs, sendPasswordReset, session } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [params, setParams] = useSearchParams()
  const role = roleOrDefault(params.get('role'))
  const R = ROLE_BY_KEY[role]
  const idLabel = SIGNIN_ID_LABEL[role]

  const [mode, setMode] = useState('signin')
  const [v, setV] = useState(EMPTY)
  const [orgs, setOrgs] = useState([])
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lockLeft, setLockLeft] = useState(0)
  const [demoOn, setDemoOn] = useState(null)
  const [codeRequired, setCodeRequired] = useState(false)

  useEffect(() => {
    const tick = () => setLockLeft(Math.max(0, Math.ceil((readLock().until - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { supabase.rpc('rm_public_organizations').then(({ data }) => setOrgs(data || [])) }, [])
  useEffect(() => {
    let live = true
    api('/api/demo', { timeoutMs: 90000 }).then((r) => { if (live) { setDemoOn(Boolean(r.enabled)); setCodeRequired(Boolean(r.code_required)) } }).catch((e) => { if (live && e.code === 'NO_API') setDemoOn(false) })
    return () => { live = false }
  }, [])
  const ngos = useMemo(() => orgs.filter((o) => o.type === 'ngo'), [orgs])

  if (session && !busy) return <Navigate to={loc.state?.from || '/dashboard'} replace />

  const set = (k) => (e) => {
    setV((cur) => ({ ...cur, [k]: e.target.value }))
    if (errors[k]) setErrors((cur) => { const n = { ...cur }; delete n[k]; return n })
  }
  const setRole = (k) => {
    const next = new URLSearchParams(params); next.set('role', k)
    setParams(next, { replace: true, state: loc.state })
    setV((cur) => ({ ...EMPTY, email: cur.email, password: cur.password }))
    setErrors({}); setFormError(null)
  }

  const countFail = (text) => {
    const l = readLock(); const fails = l.fails + 1
    const lock = fails >= MAX_FAILS ? { fails: 0, until: Date.now() + LOCK_MS } : { fails, until: 0 }
    writeLock(lock)
    setLockLeft(lock.until ? Math.ceil(LOCK_MS / 1000) : 0)
    setFormError({ tone: 'error', text: lock.until ? 'Too many failed attempts. Please wait 30 seconds and try again.' : `${text} ${MAX_FAILS - fails} attempt${MAX_FAILS - fails === 1 ? '' : 's'} left before a short lock.` })
  }

  const resend = async () => {
    const { error } = await supabase.auth.resend({ type: 'signup', email: v.email.trim(), options: { emailRedirectTo: `${window.location.origin}/login?role=${role}` } })
    setFormError(error ? { tone: 'error', text: error.message } : { tone: 'success', text: 'Confirmation email sent again. Check your inbox (and spam folder).' })
  }

  const submit = async (e) => {
    e.preventDefault()
    if (lockLeft > 0) return
    const errs = validateSignIn(v, role)
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setFormError(null)
    try {
      await signInAs(v.email.trim().toLowerCase(), v.password, role, { employee_id: v.employee_id, organization_id: v.organization_id })
      writeLock({ fails: 0, until: 0 })
      nav(loc.state?.from || '/dashboard', { replace: true })
    } catch (err) {
      if (err.code === 'ROLE_MISMATCH') {
        const actual = ROLE_BY_KEY[err.actualRole]
        setFormError({
          tone: 'warning',
          text: `This is a ${actual?.label || err.actualRole} account, not a ${R.label} account.`,
          action: actual && { label: `Sign in as ${actual.label}`, run: () => setRole(actual.key) },
        })
      } else if (err.code === 'ID_MISMATCH') {
        if (err.attemptsLeft != null) setFormError({ tone: 'error', text: `Incorrect ${idLabel || 'NGO'} for this account. ${err.attemptsLeft} attempt${err.attemptsLeft === 1 ? '' : 's'} left before the account is locked for a while.` })
        else countFail(`Incorrect email, password or ${idLabel || 'NGO'}.`)
      } else if (err.code === 'LOCKED') {
        setFormError({ tone: 'error', text: `${err.message} If this wasn't you, tell a system administrator.` })
      } else if (err.code === 'ROLE_PENDING') {
        setFormError({ tone: 'info', text: `Your ${R.label} access request is pending administrator approval. You'll be able to sign in here once it is approved — until then you can use the Citizen tab.`, action: { label: 'Sign in as Citizen', run: () => setRole('citizen') } })
      } else if (err.code === 'ROLE_REJECTED') {
        setFormError({ tone: 'error', text: `Your ${R.label} access request was not approved${err.request?.review_note ? `: “${err.request.review_note}”` : '.'} Contact a system administrator.` })
      } else if (err.code) {
        setFormError({ tone: 'error', text: err.message })
      } else if (/email not confirmed/i.test(err.message)) {
        setFormError({ tone: 'warning', text: 'Please confirm your email address first — we sent you a link when you signed up.', action: { label: 'Resend confirmation email', run: resend } })
      } else if (/invalid/i.test(err.message)) {
        countFail('Incorrect email or password.')
      } else if (/rate limit|too many/i.test(err.message)) {
        setFormError({ tone: 'error', text: 'Too many sign-in attempts. Please wait a minute and try again.' })
      } else {
        setFormError({ tone: 'error', text: /fetch|network/i.test(err.message) ? 'Cannot reach the server. Check your connection and try again.' : err.message })
      }
    } finally { setBusy(false) }
  }

  const submitForgot = async (e) => {
    e.preventDefault()
    const em = validateEmail(v.email)
    setErrors(em ? { email: em } : {})
    if (em) return
    setBusy(true); setFormError(null)
    try {
      await sendPasswordReset(v.email.trim().toLowerCase())
    } catch (err) {
      if (/rate limit|too many/i.test(err.message)) { setFormError({ tone: 'error', text: 'Too many reset requests. Please wait a few minutes.' }); setBusy(false); return }
    }
    setFormError({ tone: 'success', text: 'If an account exists for this email, a password reset link is on its way.' })
    setBusy(false)
  }

  const layout = { role, eyebrow: 'Welcome back', heading: 'Who are you signing in as?', blurb: 'Pick your account type — each one signs in with the details it needs.',
    headerLink: R.selfRegister ? { to: `/register?role=${role}`, label: 'Sign up', primary: true } : null }

  if (mode === 'forgot') {
    return (
      <PortalLayout {...layout} title="Reset your password" subtitle="Enter your account email and we'll send you a secure reset link.">
        <form onSubmit={submitForgot} noValidate className="space-y-5">
          {formError && <Alert tone={formError.tone}>{formError.text}</Alert>}
          <Field label="Email" error={errors.email} required>
            {(a) => <Input {...a} type="email" autoComplete="email" value={v.email} onChange={set('email')} placeholder="you@example.com" />}
          </Field>
          <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => { setMode('signin'); setFormError(null); setErrors({}) }}>Back to sign in</button>
            <Button type="submit" size="lg" loading={busy} className="!rounded-full"><MailCheck className="h-4 w-4" aria-hidden />Send reset link</Button>
          </div>
        </form>
      </PortalLayout>
    )
  }

  const demo = DEMO[role]
  return (
    <PortalLayout {...layout} onRoleChange={setRole} title={`Sign in as ${R.label}`} subtitle={R.signInSubtitle}>
      {demoOn !== false && (
        <button type="button" onClick={() => document.getElementById('demo-accounts-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800 ring-1 ring-inset ring-brand-200 hover:bg-brand-100">
          One-click {R.label} demo login below, no password needed<ArrowDown className="h-4 w-4" aria-hidden />
        </button>
      )}
      <form onSubmit={submit} noValidate className="space-y-5" aria-label={`${R.label} sign in`}>
        {formError && (
          <Alert tone={formError.tone}>
            {formError.text}
            {formError.action && <button type="button" onClick={formError.action.run} className="mt-1 block font-semibold underline">{formError.action.label}</button>}
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" error={errors.email} required>
            {(a) => <Input {...a} type="email" autoComplete="username" inputMode="email" value={v.email} onChange={set('email')} placeholder={role === 'citizen' ? 'you@example.com' : 'you@organisation.org'} />}
          </Field>
          <Field label="Password" error={errors.password} required>
            {(a) => <PasswordInput {...a} autoComplete="current-password" value={v.password} onChange={set('password')} />}
          </Field>
          {idLabel && (
            <Field label={idLabel} error={errors.employee_id} required hint={role === 'admin' ? undefined : 'The ID approved with your account'}>
              {(a) => <Input {...a} value={v.employee_id} onChange={set('employee_id')} placeholder={ID_PLACEHOLDER[role]} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={30} />}
            </Field>
          )}
          {role === 'ngo_coordinator' && (
            <Field label="NGO" error={errors.organization_id} required>
              {(a) => (
                <Select {...a} value={v.organization_id} onChange={set('organization_id')}>
                  <option value="">Select your NGO</option>
                  {ngos.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              )}
            </Field>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" className="self-start text-sm font-medium text-brand-700 hover:underline sm:self-center" onClick={() => { setMode('forgot'); setFormError(null); setErrors({}) }}>Forgot password?</button>
          <Button type="submit" size="lg" loading={busy} disabled={lockLeft > 0} className="!rounded-full">
            <LogIn className="h-4 w-4" aria-hidden />{lockLeft > 0 ? `Try again in ${lockLeft}s` : 'Sign in'}
          </Button>
        </div>
      </form>

      {R.selfRegister ? (
        <p className="mt-5 text-center text-sm text-slate-600">
          {R.selfRegister === 'request' ? `Need ${R.label} access?` : 'New citizen reporter?'}{' '}
          <Link className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" to={`/register?role=${role}`}><UserPlus className="h-3.5 w-3.5" aria-hidden />{R.selfRegister === 'request' ? 'Request an account' : 'Create an account'}</Link>
        </p>
      ) : (
        <p className="mt-5 text-center text-xs text-slate-500">Admin accounts are created by an existing administrator only.</p>
      )}

      {demoOn !== false ? (
        <div className="mt-6">
          <DemoProfiles role={role} busy={busy} setBusy={setBusy} codeRequired={codeRequired}
            onSignedIn={() => nav(loc.state?.from || '/dashboard', { replace: true })} />
        </div>
      ) :       (<details className="mt-5 rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Demo account (judges)</summary>
        <p className="mt-2 text-xs text-slate-500">Password for all demo accounts is shared privately with the judging panel.</p>
        <button type="button" className="mt-2 text-left text-brand-700 hover:underline"
          onClick={() => setV((cur) => ({ ...cur, email: demo.email, employee_id: demo.employee_id || '', organization_id: demo.organization_id || '' }))}>
          Fill {demo.email}{demo.employee_id ? ` · ${demo.employee_id}` : ''}{demo.org ? ` · ${demo.org}` : ''}
        </button>
        {role === 'admin' && (
          <button type="button" className="mt-1 block text-left text-brand-700 hover:underline"
            onClick={() => setV((cur) => ({ ...cur, email: DEMO_ADMIN2.email, employee_id: DEMO_ADMIN2.employee_id }))}>
            Fill {DEMO_ADMIN2.email} · {DEMO_ADMIN2.employee_id} <span className="text-xs text-slate-500">(security &amp; audit officer, second approver)</span>
          </button>
        )}
      </details>)}
    </PortalLayout>
  )
}

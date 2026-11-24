import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Alert, Field } from './ui'
import { PasswordInput } from './PasswordInput'
import { useAuth } from '../context/AuthContext'
import { ROLE_BY_KEY } from '../lib/roles'

// Demo people (created by scripts/seed_demo.py). The server maps each key to its
// account; the password and the judge access code never appear in the website.
export const DEMO_PROFILES = [
  { key: 'citizen', name: 'Arif Chowdhury', role: 'citizen', place: 'Dhaka South', does: 'Report waterlogging with GPS and depth, then follow it to resolution.' },
  { key: 'officer_south', name: 'Tanvir Hasan', role: 'city_officer', place: 'Dhaka South', does: 'Verify reports, run AI risk scoring and approve pump & crew plans in Dhaka South.' },
  { key: 'officer_north', name: 'Nusrat Jahan', role: 'city_officer', place: 'Dhaka North', does: 'Same tools for Dhaka North. Sees only Dhaka North: no South report, ward or map area.' },
  { key: 'ngo', name: 'Sabrina Akter', role: 'ngo_coordinator', place: 'Shobar Jonno Relief Network', does: 'Log community needs, manage relief stock and allocate the last kits.' },
  { key: 'field', name: 'Rafiqul Islam', role: 'field_worker', place: 'Dhaka South', does: 'Receive Dhaka South field tasks on the phone and update them offline.' },
  { key: 'admin', name: 'Farhana Rahman', role: 'admin', place: 'Platform operations', does: 'Approve staff access, read the audit log, check system health.' },
  { key: 'admin2', name: 'Kamal Hossain', role: 'admin', place: 'Second approver', does: 'Second admin for two-person approval of officer and admin access.' },
]

const CODE_KEY = 'rm.judgeCode'
const readCode = () => { try { return localStorage.getItem(CODE_KEY) || '' } catch { return '' } }
const saveCode = (c) => { try { c ? localStorage.setItem(CODE_KEY, c) : localStorage.removeItem(CODE_KEY) } catch { /* storage blocked */ } }
const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

/**
 * "Demo accounts for judges" box under the sign-in form: one click per account, no password. When the server requires an access code
 * (DEMO_ACCESS_CODE set) it is asked once, or comes from a private link /login#code=....
 * `role` = the open role tab; only that role's demo accounts are shown.
 */
export default function DemoProfiles({ role, busy, setBusy, codeRequired: serverNeedsCode = false, onSignedIn }) {
  const { signInDemo } = useAuth()
  // Private judge link: /login#code=XXXX fills the code once and removes it from the address bar
  // (the #fragment is never sent to any server, so it does not end up in logs).
  const [code, setCode] = useState(() => {
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('code')
    if (fromLink) {
      saveCode(fromLink.trim())
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
      return fromLink.trim()
    }
    return readCode()
  })
  // once a code is known the box is hidden: judges just click a profile
  const [showCode, setShowCode] = useState(() => !code)
  const [codeError, setCodeError] = useState('')
  const [askedForCode, setAskedForCode] = useState(false)   // server answered DEMO_CODE
  const codeRequired = serverNeedsCode || askedForCode
  const [error, setError] = useState('')
  const [active, setActive] = useState(null)
  const [slow, setSlow] = useState(false)
  const codeRef = useRef(null)

  // free hosting sleeps: after a few seconds, explain the wait instead of looking frozen
  useEffect(() => {
    if (!active) { setSlow(false); return undefined }
    const t = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(t)
  }, [active])

  // only the demo accounts of the role tab that is open (switch tabs above for other roles)
  const profiles = role ? DEMO_PROFILES.filter((p) => p.role === role) : DEMO_PROFILES

  const pick = async (p) => {
    if (busy) return
    setError('')
    if (codeRequired && !code.trim()) {
      setShowCode(true)
      setCodeError('Enter the judge access code first. It was sent privately with the submission.')
      setTimeout(() => codeRef.current?.focus(), 0)
      return
    }
    setCodeError(''); setActive(p.key); setBusy(true)
    try {
      const r = await signInDemo(p.key, code.trim())
      saveCode(code.trim())
      onSignedIn(r)
    } catch (e) {
      if (e.code === 'DEMO_CODE') {      // the server asks for a code (DEMO_ACCESS_CODE is set)
        saveCode(''); setAskedForCode(true); setShowCode(true); setCodeError(e.message)
        setTimeout(() => codeRef.current?.focus(), 0)
      }
      else setError(e.message || 'Demo sign-in failed. Please try again.')
    } finally { setActive(null); setBusy(false) }
  }

  return (
    <section aria-labelledby="demo-accounts-title" className="rounded-2xl border-2 border-brand-200 bg-brand-50/50 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="demo-accounts-title" className="text-sm font-bold text-slate-900">Demo accounts for judges</h3>
        <p className="text-xs font-medium text-brand-800">One click. No password needed.</p>
      </div>

      {codeRequired && showCode && (
        <div className="mt-3">
          <Field label="Judge access code" error={codeError} required hint="Sent privately with the submission. Enter it once; this browser remembers it.">
            {(a) => (
              <PasswordInput {...a} ref={codeRef} autoComplete="off" spellCheck={false} maxLength={100} placeholder="Judge access code"
                value={code} onChange={(e) => { setCode(e.target.value); if (codeError) setCodeError('') }} />
            )}
          </Field>
        </div>
      )}
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
      {slow && <Alert tone="info" className="mt-3">Waking up the server… Free hosting sleeps when idle, so the first sign-in can take up to a minute.</Alert>}

      <ul className={`mt-3 grid gap-2 ${profiles.length > 1 ? 'sm:grid-cols-2' : ''}`} aria-label="Demo accounts">
        {profiles.map((p) => {
          const R = ROLE_BY_KEY[p.role]
          const Icon = R.icon
          const loading = active === p.key
          return (
            <li key={p.key}>
              <button type="button" onClick={() => pick(p)} disabled={busy && !loading} aria-busy={loading}
                aria-label={`Sign in as ${p.name}, ${R.label}, ${p.place}`} title={p.does}
                className={`group flex h-full w-full items-center gap-3 rounded-xl bg-white p-3 text-left ring-1 ring-inset transition hover:ring-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-60 ${
                  'ring-slate-200'}`}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700 ring-1 ring-inset ring-brand-100" aria-hidden>
                  {initials(p.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{p.name}</span>
                  <span className="mt-0.5 flex items-start gap-1 text-xs text-slate-600">
                    <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-brand-600" aria-hidden />
                    <span>{R.label} · {p.place}</span>
                  </span>
                </span>
                {loading
                  ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-600" aria-hidden />
                  : <ArrowRight className="h-4 w-4 shrink-0 text-brand-600 transition group-hover:translate-x-0.5" aria-hidden />}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Other roles: pick a different tab above. Demo sign-ins go through the same server checks as everyone else (staff ID, role, area, audit log). All data is synthetic.
      </p>
    </section>
  )
}

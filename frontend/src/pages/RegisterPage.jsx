import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Clock, LogIn, ShieldCheck, UserPlus } from 'lucide-react'
import { Alert, Button, Field, Input, Select } from '../components/ui'
import { PasswordInput, StrengthMeter } from '../components/PasswordInput'
import PortalLayout from '../components/PortalLayout'
import { useAuth } from '../context/AuthContext'
import { FIELD_TEAMS, ROLE_BY_KEY, ROLE_ORG_TYPES, roleOrDefault } from '../lib/roles'
import { supabase } from '../lib/supabase'
import { normalizePhone, validateRegister } from '../lib/validation'

const EMPTY = {
  full_name: '', email: '', password: '', confirm_password: '', phone: '', ward_id: '',
  organization_id: '', organization_name: '', registration_no: '', employee_id: '', designation: '', team: '',
  accept_terms: false,
}

const SignUpLayout = ({ role, ...p }) => (
  <PortalLayout role={role} eyebrow="Create your account" heading="Who are you signing up as?"
    blurb="Each user type has its own sign-up form and the details it needs."
    headerLink={{ to: `/login?role=${role}`, label: 'Sign in' }} {...p} />
)

export default function RegisterPage() {
  const { signUp, signOut, session } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const role = roleOrDefault(params.get('role'))
  const R = ROLE_BY_KEY[role]
  const staff = role !== 'citizen'

  const [v, setV] = useState(EMPTY)
  const [wards, setWards] = useState([])
  const [orgs, setOrgs] = useState([])
  const [errors, setErrors] = useState({})
  const [msg, setMsg] = useState(null)
  const [done, setDone] = useState(null)     // success screen
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('wards').select('id,name').order('name').then(({ data }) => setWards(data || []))
    supabase.rpc('rm_public_organizations').then(({ data }) => setOrgs(data || []))
  }, [])
  const roleOrgs = useMemo(() => orgs.filter((o) => (ROLE_ORG_TYPES[role] || []).includes(o.type)), [orgs, role])
  const chosenOrg = roleOrgs.find((o) => o.id === v.organization_id) || null
  const officialDomains = chosenOrg?.email_domains?.length ? chosenOrg.email_domains.map((d) => `@${d}`).join(' or ') : null

  if (session && !busy && !done) return <Navigate to="/dashboard" replace />

  const setRole = (k) => {
    const next = new URLSearchParams(params); next.set('role', k)
    setParams(next, { replace: true })
    // keep the common identity fields, drop role-specific ones
    setV((cur) => ({ ...EMPTY, full_name: cur.full_name, email: cur.email, phone: cur.phone, accept_terms: cur.accept_terms }))
    setErrors({}); setMsg(null)
  }
  const set = (k) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setV((cur) => ({ ...cur, [k]: val }))
    if (errors[k]) setErrors((cur) => { const n = { ...cur }; delete n[k]; return n })
  }

  const submit = async (e) => {
    e.preventDefault()
    const errs = validateRegister(v, role, { org: chosenOrg, orgs })
    setErrors(errs)
    if (Object.keys(errs).length) {
      setMsg({ tone: 'error', text: `Please fix ${Object.keys(errs).length} field${Object.keys(errs).length > 1 ? 's' : ''} highlighted below.` })
      return
    }
    setBusy(true); setMsg(null)
    const otherOrg = v.organization_id === 'other'
    const payload = {
      full_name: v.full_name.trim().replace(/\s+/g, ' '),
      email: v.email.trim().toLowerCase(),
      password: v.password,
      phone: normalizePhone(v.phone),
      ward_id: v.ward_id,
      ...(staff && {
        requested_role: role,
        organization_id: otherOrg ? '' : v.organization_id,
        organization_name: otherOrg ? v.organization_name.trim() : (roleOrgs.find((o) => o.id === v.organization_id)?.name || ''),
        registration_no: otherOrg ? v.registration_no.trim() : '',
        employee_id: v.employee_id.trim(),
        designation: v.designation.trim(),
        team: v.team,
      }),
    }
    try {
      const data = await signUp(payload)
      // Supabase returns a user with no identities when the email is already registered
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setMsg({ tone: 'error', text: 'An account with this email already exists. Sign in instead, or use “Forgot password”.' })
        return
      }
      if (!staff && data.session) { nav('/dashboard'); return }
      if (staff && data.session) await signOut()      // staff wait for approval before using the console
      setDone({ needsConfirm: !data.session })
    } catch (err) {
      setMsg({
        tone: 'error',
        text: /registered|already/i.test(err.message) ? 'An account with this email already exists.'
          : /rate limit|too many/i.test(err.message) ? 'Too many sign-up attempts. Please wait a few minutes.'
          : /database error/i.test(err.message) ? (staff
            ? 'The server rejected these details. Staff must register with their official organisation e-mail address — check the e-mail and organisation.'
            : 'Some details were rejected by the server. Check your details and try again.')
          : err.message,
      })
    } finally { setBusy(false) }
  }

  // ---------- admin: no public sign-up ----------
  if (role === 'admin') {
    return (
      <SignUpLayout role={role} onRoleChange={setRole} title="Admin accounts" subtitle={R.signInSubtitle}>
        <Alert tone="info" title="Admin accounts cannot be self-registered">
          For security, administrator access is granted only by an existing administrator from <b>Audit &amp; Admin → Users &amp; roles</b>.
          If you are part of the platform team, ask an admin to create or promote your account.
        </Alert>
        <Link to="/login?role=admin" className="mt-6 inline-flex items-center gap-2 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
          <LogIn className="h-4 w-4" aria-hidden />Sign in as Admin
        </Link>
      </SignUpLayout>
    )
  }

  // ---------- success ----------
  if (done) {
    return (
      <SignUpLayout role={role} title={staff ? 'Access request submitted' : 'Account created'} subtitle={staff ? 'We have your details — an administrator will review them.' : 'Welcome to ResilioMesh.'}>
        <div className="space-y-4">
          {done.needsConfirm && <Alert tone="success" title="Confirm your email">We sent a confirmation link to <b>{v.email.trim()}</b>. Open it to activate your account.</Alert>}
          {staff && (
            <Alert tone="info" title={`${R.label} access is pending approval`}>
              <span className="flex gap-2"><Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />An administrator checks your details against the official staff roster{role === 'ngo_coordinator' ? ' and the NGO Affairs Bureau registry' : ''}.</span>
              <ol className="mt-2 list-decimal space-y-0.5 pl-5">
                {done.needsConfirm && <li>Open the confirmation link in your e-mail.</li>}
                <li>Sign in on the <b>Citizen</b> tab and open <b>Account &amp; security</b>.</li>
                <li>Verify your mobile number by SMS and upload your office ID card or appointment letter.</li>
                <li>Once approved, sign in on the <b>{R.label}</b> tab with your {role === 'ngo_coordinator' ? 'NGO' : 'ID'}.</li>
              </ol>
            </Alert>
          )}
          {!staff && <Alert tone="info">After signing in, verify your mobile number under <b>Account &amp; security</b> — verified reports are trusted faster.</Alert>}
          <Link to={`/login?role=${staff ? role : 'citizen'}`} className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
            <LogIn className="h-4 w-4" aria-hidden />Go to sign in
          </Link>
        </div>
      </SignUpLayout>
    )
  }

  const wardSelect = (label, required, hint) => (
    <Field label={label} error={errors.ward_id} required={required} hint={hint}>
      {(a) => <Select {...a} value={v.ward_id} onChange={set('ward_id')}><option value="">Select area</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
    </Field>
  )
  const orgSelect = (label, allowOther) => (
    <Field label={label} error={errors.organization_id} required>
      {(a) => (
        <Select {...a} value={v.organization_id} onChange={set('organization_id')}>
          <option value="">Select organisation</option>
          {roleOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          {allowOther && <option value="other">Other (not listed)</option>}
        </Select>
      )}
    </Field>
  )
  const box = 'grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:grid-cols-2'
  const legend = 'px-1 text-xs font-semibold uppercase tracking-wide text-slate-500'

  return (
    <SignUpLayout role={role} onRoleChange={setRole}
      title={staff ? `Request ${R.label} access` : 'Create citizen account'}
      subtitle={R.tagline}>
      <form onSubmit={submit} noValidate className="space-y-5" aria-label={`${R.label} registration`}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" error={errors.full_name} required>{(a) => <Input {...a} value={v.full_name} onChange={set('full_name')} autoComplete="name" maxLength={100} />}</Field>
          <Field label={staff ? 'Official work email' : 'Email'} error={errors.email} required
            hint={!staff ? undefined : officialDomains ? `Must be your ${officialDomains} address` : role === 'city_officer' ? 'Your city corporation address (e.g. @dncc.gov.bd)' : role === 'ngo_coordinator' ? 'Your organisation address — public mail (Gmail, Yahoo…) is not accepted' : 'Official organisation email if you have one'}>
            {(a) => <Input {...a} type="email" inputMode="email" value={v.email} onChange={set('email')} autoComplete="email" maxLength={254} />}
          </Field>
          <Field label="Mobile (Bangladesh)" error={errors.phone} required hint="+880 numbers only — you'll confirm it with an SMS code">
            {(a) => <Input {...a} type="tel" inputMode="tel" value={v.phone} onChange={set('phone')} placeholder="01712345678" autoComplete="tel" maxLength={16} />}
          </Field>
          {role === 'citizen' && wardSelect('Home area (optional)', false, 'Shows you the flood risk where you live')}
        </div>

        {role === 'city_officer' && (
          <fieldset className={box}>
            <legend className={legend}>Official details</legend>
            <div className="sm:col-span-2">{orgSelect('City authority', false)}</div>
            <Field label="Employee ID" error={errors.employee_id} required hint="You'll sign in with this ID">{(a) => <Input {...a} value={v.employee_id} onChange={set('employee_id')} placeholder="DNCC-2024-118" maxLength={30} />}</Field>
            <Field label="Designation" error={errors.designation} required>{(a) => <Input {...a} value={v.designation} onChange={set('designation')} placeholder="Assistant Engineer" maxLength={80} />}</Field>
            <div className="sm:col-span-2">{wardSelect('Responsible ward (optional)', false)}</div>
          </fieldset>
        )}

        {role === 'ngo_coordinator' && (
          <fieldset className={box}>
            <legend className={legend}>Organisation details</legend>
            <div className="sm:col-span-2">{orgSelect('NGO', true)}
            <p className="-mt-2 text-xs text-slate-500 sm:col-span-2">You'll choose this NGO when you sign in.</p></div>
            {v.organization_id === 'other' && (
              <>
                <Field label="NGO name" error={errors.organization_name} required>{(a) => <Input {...a} value={v.organization_name} onChange={set('organization_name')} maxLength={120} />}</Field>
                <Field label="NGOAB registration no." error={errors.registration_no} required>{(a) => <Input {...a} value={v.registration_no} onChange={set('registration_no')} placeholder="e.g. 2891" maxLength={40} />}</Field>
              </>
            )}
            <Field label="Designation" error={errors.designation} required>{(a) => <Input {...a} value={v.designation} onChange={set('designation')} placeholder="Relief Coordinator" maxLength={80} />}</Field>
            {wardSelect('Main operating area', true, 'Sets your home area (Dhaka North or South): you are responsible for needs there')}
          </fieldset>
        )}

        {role === 'field_worker' && (
          <fieldset className={box}>
            <legend className={legend}>Field assignment</legend>
            <div className="sm:col-span-2">{orgSelect('Organisation', false)}</div>
            <Field label="Staff ID" error={errors.employee_id} required hint="You'll sign in with this ID">{(a) => <Input {...a} value={v.employee_id} onChange={set('employee_id')} placeholder="FW-0042" maxLength={30} />}</Field>
            <Field label="Team" error={errors.team} required>
              {(a) => <Select {...a} value={v.team} onChange={set('team')}><option value="">Select team</option>{FIELD_TEAMS.map((t) => <option key={t}>{t}</option>)}</Select>}
            </Field>
            <div className="sm:col-span-2">{wardSelect('Assigned area', true)}</div>
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" error={errors.password} required
            hint={staff ? '10+ chars, upper & lower case, number and symbol' : 'At least 8 characters with letters and numbers'}>
            {(a) => <><PasswordInput {...a} value={v.password} onChange={set('password')} autoComplete="new-password" maxLength={72} /><StrengthMeter password={v.password} /></>}
          </Field>
          <Field label="Confirm password" error={errors.confirm_password} required>
            {(a) => <PasswordInput {...a} value={v.confirm_password} onChange={set('confirm_password')} autoComplete="new-password" maxLength={72} />}
          </Field>
        </div>

        <div>
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={v.accept_terms} onChange={set('accept_terms')} aria-invalid={Boolean(errors.accept_terms)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600" />
            <span>{staff
              ? 'I confirm these details are accurate and I am authorised to act for this organisation.'
              : 'I agree to use ResilioMesh responsibly and only submit genuine reports.'}</span>
          </label>
          {errors.accept_terms && <p role="alert" className="mt-1 text-xs font-medium text-rose-600">{errors.accept_terms}</p>}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-xs text-slate-500 sm:max-w-sm">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {staff
              ? `Your account starts with Citizen access. ${R.label} permissions are switched on after an administrator verifies your details.`
              : 'New accounts get the Citizen role. Staff roles are granted by an administrator.'}
          </p>
          <Button type="submit" size="lg" loading={busy} className="!rounded-full sm:shrink-0">
            <UserPlus className="h-4 w-4" aria-hidden />{staff ? 'Submit access request' : 'Create account'}
          </Button>
        </div>
      </form>
      <p className="mt-5 text-center text-sm text-slate-600">Already registered? <Link className="font-medium text-brand-700 hover:underline" to={`/login?role=${role}`}>Sign in as {R.label}</Link></p>
    </SignUpLayout>
  )
}

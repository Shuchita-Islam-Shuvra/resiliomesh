import { useEffect, useMemo, useState } from 'react'
import { BadgeCheck, LogOut, ShieldAlert, Sparkles } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { demoSignInFor } from '../lib/demoAccounts'
import { ROLE_BY_KEY } from '../lib/roles'
import { supabase } from '../lib/supabase'
import { SIGNIN_ID_LABEL } from '../lib/validation'
import { Alert, Button, Card, Field, Input, Select } from './ui'
import { TotpChallenge, TotpEnroll } from './VerifyPanels'

export default function SessionGate() {
  const { profile, security, verifyStaffSession, signOut } = useAuth()
  const role = profile?.account_role
  const R = ROLE_BY_KEY[role]
  const idLabel = SIGNIN_ID_LABEL[role]
  const demo = demoSignInFor(profile?.email)
  const [staffId, setStaffId] = useState('')
  const [orgId, setOrgId] = useState(demo?.orgId || '')
  const [orgs, setOrgs] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (role === 'ngo_coordinator') supabase.rpc('rm_public_organizations').then(({ data }) => setOrgs(data || []))
  }, [role])
  const ngos = useMemo(() => orgs.filter((o) => o.type === 'ngo'), [orgs])

  const submit = async (e) => {
    e.preventDefault()
    if (idLabel && !staffId.trim()) { setErr(`Enter your ${idLabel}`); return }
    if (role === 'ngo_coordinator' && !orgId) { setErr('Choose your NGO'); return }
    setBusy(true); setErr('')
    try { await verifyStaffSession({ employee_id: staffId, organization_id: orgId }) } catch (x) {
      setErr(x.message || 'Could not verify. Please try again.')
    } finally { setBusy(false) }
  }

  const step = security?.gate
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <Card title={step === 'mfa' ? 'Two-step verification' : `Confirm your ${R?.label || 'staff'} sign-in`}
        subtitle={`${profile?.full_name} · ${profile?.email}`} icon={step === 'mfa' ? BadgeCheck : ShieldAlert}>
        {step === 'staff_id' && (
          <form onSubmit={submit} noValidate className="space-y-4">
            <Alert tone="info">
              {security?.staff_expires_at ? 'Your verified staff session has ended. ' : ''}
              Staff permissions are only switched on after the server checks your {idLabel || 'NGO'} for this session.
            </Alert>
            {demo && (demo.staffId || demo.orgId) && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4" aria-hidden />Demo account. {idLabel && demo.staffId
                    ? <>{idLabel}: <code className="rounded bg-surface px-1.5 py-0.5 font-mono font-semibold">{demo.staffId}</code></>
                    : <>NGO is pre-selected.</>}
                </span>
                {idLabel && demo.staffId && staffId !== demo.staffId && (
                  <button type="button" onClick={() => { setStaffId(demo.staffId); setErr('') }}
                    className="rounded-full bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700">Use demo ID</button>
                )}
              </div>
            )}
            {idLabel ? (
              <Field label={idLabel} error={err} required>
                {(a) => <Input {...a} value={staffId} onChange={(e) => setStaffId(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={30} autoFocus placeholder={demo?.staffId ? `e.g. ${demo.staffId}` : undefined} />}
              </Field>
            ) : (
              <Field label="NGO" error={err} required>
                {(a) => (
                  <Select {...a} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                    <option value="">Select your NGO</option>
                    {ngos.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <Button type="submit" loading={busy} className="!rounded-full">Continue</Button>
          </form>
        )}
        {step === 'mfa' && (security?.mfa_enrolled
          ? <TotpChallenge />
          : <TotpEnroll required />)}
        <div className="mt-6 border-t border-slate-100 pt-4">
          <button type="button" onClick={signOut} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
            <LogOut className="h-4 w-4" aria-hidden />Sign out
          </button>
        </div>
      </Card>
    </div>
  )
}

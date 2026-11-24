import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, Clock, FileUp, KeyRound, Phone, ShieldCheck, Trash2, UserCheck } from 'lucide-react'
import { Alert, Button, Card, Field, PageHeader, Select, Spinner } from '../components/ui'
import { PhoneVerify, TotpEnroll } from '../components/VerifyPanels'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { errorMessage } from '../lib/errors'
import { ROLE_LABEL, fmtDateTime } from '../lib/format'
import { DOC_KINDS } from '../lib/identity'
import { supabase } from '../lib/supabase'

const BUCKET = 'staff-documents'
const MAX_BYTES = 5 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const ok = (t) => <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200"><BadgeCheck className="h-3.5 w-3.5" aria-hidden />{t}</span>

export default function AccountPage() {
  const { profile, security } = useAuth()
  const [phoneEdit, setPhoneEdit] = useState(false)
  const phoneVerified = security ? security.phone_verified : Boolean(profile.phone_verified_at)
  return (
    <>
      <PageHeader title="Account & security" description="Verify your mobile number, protect your sign-in and follow your staff access request." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Mobile number" icon={Phone}
          subtitle={security?.require_phone_verification ? 'A verified Bangladeshi number is required to submit reports.' : 'Verified by an SMS code. Only Bangladeshi (+880) numbers are accepted.'}>
          {phoneVerified && !phoneEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm">{profile.phone}</span>{ok('Verified')}
              <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setPhoneEdit(true)}>Change number</button>
            </div>
          ) : (
            <PhoneVerify initialPhone={profile.phone || ''} onDone={() => setPhoneEdit(false)} />
          )}
        </Card>
        <MfaCard />
        <AccessRequestCard />
      </div>
    </>
  )
}

function MfaCard() {
  const { mfa, security } = useAuth()
  const toast = useToast()
  const [factors, setFactors] = useState(null)
  const load = useCallback(() => mfa.list().then(setFactors).catch(() => setFactors([])), [mfa])
  useEffect(() => { load() }, [load, security?.mfa_enrolled])
  const remove = async (f) => {
    if (!window.confirm('Remove this authenticator app? Your account will be protected by password only.')) return
    try { await mfa.unenroll(f.id); toast.success('Authenticator app removed'); load() } catch (e) {
      toast.error(/aal2|assurance/i.test(e.message) ? 'Verify with your current authenticator code first (sign out and back in).' : errorMessage(e))
    }
  }
  const requiredForRole = security?.mfa_required && security?.account_role !== 'citizen'
  return (
    <Card title="Authenticator app (2-step sign-in)" icon={KeyRound}
      subtitle="A 6-digit code from your phone is needed at every sign-in, so a stolen password alone is not enough.">
      {factors === null ? <Spinner /> : factors.length ? (
        <ul className="space-y-2">
          {factors.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <span className="text-sm">{f.friendly_name || 'Authenticator app'} <span className="text-xs text-slate-500">· added {fmtDateTime(f.created_at)}</span></span>
              <span className="flex items-center gap-2">{ok('On')}
                {!requiredForRole && <Button size="sm" variant="secondary" onClick={() => remove(f)}><Trash2 className="h-3.5 w-3.5" />Remove</Button>}
              </span>
            </li>
          ))}
        </ul>
      ) : <TotpEnroll onDone={() => { toast.success('Two-step sign-in is on'); load() }} />}
    </Card>
  )
}

function AccessRequestCard() {
  const { profile, security } = useAuth()
  const toast = useToast()
  const [req, setReq] = useState(undefined)
  const [docs, setDocs] = useState([])
  const [kind, setKind] = useState('id_card')
  const [file, setFile] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('role_requests').select('*').eq('user_id', profile.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    setReq(data || null)
    if (data) {
      const { data: d } = await supabase.from('role_request_documents').select('*').eq('request_id', data.id).order('created_at')
      setDocs(d || [])
    }
  }, [profile.id])
  useEffect(() => { load() }, [load])
  useEffect(() => { supabase.rpc('rm_public_security_settings').then(({ data }) => setSettings(data || null)) }, [])

  if (req === undefined) return <Card title="Staff access request" icon={UserCheck}><Spinner /></Card>
  if (!req) {
    if (security?.account_role && security.account_role !== 'citizen') {
      return (
        <Card title="Staff sign-in" icon={ShieldCheck}>
          <p className="text-sm text-slate-600">Signed in as <b>{ROLE_LABEL[security.account_role]}</b>.
            {security.staff_expires_at && <> Your verified staff session is valid until <b>{fmtDateTime(security.staff_expires_at)}</b>; after that you confirm your ID again.</>}</p>
        </Card>
      )
    }
    return null
  }

  const pending = req.status === 'pending'
  const upload = async (e) => {
    e.preventDefault()
    setErr('')
    if (!file) { setErr('Choose a photo or PDF of the document'); return }
    if (!TYPES.includes(file.type)) { setErr('Use a JPG, PNG, WebP or PDF file'); return }
    if (file.size > MAX_BYTES) { setErr('The file must be 5 MB or smaller'); return }
    setBusy(true)
    const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)
    const path = `${profile.id}/${req.id}/${Date.now()}-${safe}`
    try {
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      if (upErr) throw upErr
      const { error: dbErr } = await supabase.from('role_request_documents').insert({
        request_id: req.id, user_id: profile.id, kind, storage_path: path, file_name: file.name.slice(0, 200), mime_type: file.type, size_bytes: file.size,
      })
      if (dbErr) { await supabase.storage.from(BUCKET).remove([path]); throw dbErr }
      toast.success('Document uploaded — the administrators can now see it')
      setFile(null); e.target.reset?.()
      load()
    } catch (x) {
      setErr(/bucket not found/i.test(x.message || '') ? 'Document storage is not set up on this server yet. Ask a system administrator.' : errorMessage(x))
    } finally { setBusy(false) }
  }
  const remove = async (d) => {
    const { error } = await supabase.from('role_request_documents').delete().eq('id', d.id)
    if (error) { toast.error(errorMessage(error)); return }
    await supabase.storage.from(BUCKET).remove([d.storage_path])
    load()
  }
  const view = async (d) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(d.storage_path, 120)
    if (error) toast.error(errorMessage(error)); else window.open(data.signedUrl, '_blank', 'noopener')
  }

  return (
    <Card title="Staff access request" icon={UserCheck} className="xl:col-span-2"
      subtitle={`${ROLE_LABEL[req.requested_role]} · submitted ${fmtDateTime(req.created_at)}`}>
      {pending && (
        <Alert tone="info" title="Waiting for administrator review">
          <span className="flex gap-2"><Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Administrators check your details against the official staff roster{req.requested_role === 'ngo_coordinator' ? ' and the NGO Affairs Bureau registry' : ''}.
            {(settings?.two_person_roles || []).includes(req.requested_role) && ' This role needs approval from two different administrators.'}
          </span>
        </Alert>
      )}
      {req.status === 'approved' && <Alert tone="success" title="Approved">Sign in on the <b>{ROLE_LABEL[req.requested_role]}</b> tab with your ID to use your new permissions.</Alert>}
      {req.status === 'rejected' && <Alert tone="error" title="Not approved">{req.review_note || 'Contact a system administrator for details.'}</Alert>}

      {pending && (
        <ul className="mt-4 space-y-1.5 text-sm">
          <Step done={security?.email_verified ?? true}>E-mail address confirmed</Step>
          <Step done={security?.phone_verified} optional={!settings?.require_phone_verification}>Mobile number verified by SMS (card above)</Step>
          <Step done={docs.length > 0} optional={!settings?.require_documents}>Office ID card or appointment letter uploaded</Step>
        </ul>
      )}

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-slate-800">Documents</h3>
        {docs.length === 0 ? <p className="mt-1 text-sm text-slate-500">Nothing uploaded yet.</p> : (
          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span><b>{DOC_KINDS.find(([k]) => k === d.kind)?.[1]}</b> <span className="text-slate-500">· {d.file_name}</span></span>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => view(d)}>View</Button>
                  {pending && <Button size="sm" variant="secondary" onClick={() => remove(d)}><Trash2 className="h-3.5 w-3.5" />Remove</Button>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pending && (
          <form onSubmit={upload} noValidate className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
            <Field label="Document type">
              {(a) => <Select {...a} value={kind} onChange={(e) => setKind(e.target.value)}>{DOC_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
            </Field>
            <Field label="File (JPG, PNG, WebP or PDF, max 5 MB)" error={err}>
              {(a) => <input {...a} type="file" accept={TYPES.join(',')} onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-brand-700 hover:file:bg-brand-100" />}
            </Field>
            <Button type="submit" loading={busy} className="!rounded-full"><FileUp className="h-4 w-4" aria-hidden />Upload</Button>
          </form>
        )}
        <p className="mt-2 text-xs text-slate-500">Files are stored privately. Only you and the platform administrators can open them.</p>
      </div>
    </Card>
  )
}

function Step({ done, optional, children }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{done ? '✓' : '·'}</span>
      <span className={done ? 'text-slate-700' : 'text-slate-600'}>{children}{!done && optional && <span className="text-slate-400"> (recommended)</span>}</span>
    </li>
  )
}

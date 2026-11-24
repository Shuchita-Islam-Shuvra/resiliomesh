import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, BadgeCheck, Building2, Check, FileText, FlaskConical, Globe, Lock, ScrollText, Upload, UserCheck, Users, X } from 'lucide-react'
import { Alert, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, StatCard, Tabs, Textarea, Th } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { parseCsv } from '../lib/csv'
import { errorMessage } from '../lib/errors'
import { BLOCKER_LABEL, CHECK_LABEL, DOC_KINDS, FLAG_LABEL } from '../lib/identity'
import { ROLE_LABEL, fmtDateTime, fmtNum } from '../lib/format'
import { supabase } from '../lib/supabase'

export default function AdminPage() {
  const [tab, setTab] = useState('audit')
  const [pending, setPending] = useState(undefined)
  useEffect(() => {
    const count = () => supabase.from('role_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      .then(({ count: c, error }) => setPending(error ? undefined : c ?? 0))
    count()
    const ch = supabase.channel('admin:role_requests')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_requests' }, count).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])
  return (
    <>
      <PageHeader title="Audit logs & administration" description="Append-only audit trail written by database triggers, account & role management, system health and fault-injection controls." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'audit', label: 'Audit log' }, { value: 'requests', label: 'Access requests', count: pending || undefined }, { value: 'users', label: 'Users & roles' }, { value: 'verification', label: 'Verification data' }, { value: 'system', label: 'System health & chaos' }]} />
      {tab === 'audit' && <Audit />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'verification' && <VerificationTab />}
      {tab === 'system' && <SystemTab />}
    </>
  )
}

const PAGE = 25
function Audit() {
  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [table, setTable] = useState('')
  const [action, setAction] = useState('')
  const [open, setOpen] = useState(null)
  const load = useCallback(async () => {
    let q = supabase.from('audit_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1)
    if (table) q = q.eq('table_name', table)
    if (action) q = q.eq('action', action)
    const { data, count } = await q
    setRows(data || []); setTotal(count || 0)
  }, [page, table, action])
  useEffect(() => { load() }, [load])
  const diff = (r) => {
    if (r.action !== 'UPDATE' || !r.old_data) return null
    return Object.keys(r.new_data || {}).filter((k) => !['updated_at', 'version'].includes(k) && JSON.stringify(r.old_data[k]) !== JSON.stringify(r.new_data[k]))
  }
  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap gap-2 p-4">
        <Select aria-label="Filter by table" className="max-w-[220px]" value={table} onChange={(e) => { setPage(1); setTable(e.target.value) }}><option value="">All tables</option>{['incidents', 'resources', 'allocations', 'allocation_plans', 'tasks', 'profiles', 'role_requests', 'role_request_approvals', 'role_request_documents', 'staff_roster', 'ngo_registry', 'organizations', 'security_settings', 'community_needs', 'workflow_runs', 'drainage_assets'].map((t) => <option key={t}>{t}</option>)}</Select>
        <Select aria-label="Filter by action" className="max-w-[160px]" value={action} onChange={(e) => { setPage(1); setAction(e.target.value) }}><option value="">All actions</option><option>INSERT</option><option>UPDATE</option><option>DELETE</option></Select>
      </div>
      {!rows ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Record</Th><Th>Changed fields</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const changed = diff(r)
                return (
                  <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{fmtDateTime(r.created_at)}</td>
                    <td className="px-3 py-2 text-xs"><span className="font-mono">{r.actor_id ? r.actor_id.slice(0, 8) : 'system'}</span> <span className="text-slate-500">{r.actor_role}</span></td>
                    <td className="px-3 py-2"><span className={`rounded px-1.5 text-xs font-semibold ${r.action === 'DELETE' ? 'bg-rose-100 text-rose-700' : r.action === 'INSERT' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}`}>{r.action}</span></td>
                    <td className="px-3 py-2 text-xs">{r.table_name} <span className="font-mono text-slate-400">{r.record_id?.slice(0, 8)}</span></td>
                    <td className="max-w-md px-3 py-2 text-xs text-slate-600">
                      {changed ? changed.map((k) => <span key={k} className="mr-1 inline-block rounded bg-slate-100 px-1">{k}: {String(r.old_data[k])} → {String(r.new_data[k])}</span>) : '—'}
                      {open === r.id && <pre className="mt-2 max-h-60 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">{JSON.stringify({ old: r.old_data, new: r.new_data }, null, 2)}</pre>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
    </Card>
  )
}

const STAFF_ROLES = ['city_officer', 'ngo_coordinator', 'field_worker', 'admin']
const Badge = ({ tone, children }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
    tone === 'ok' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : tone === 'warn' ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-rose-50 text-rose-700 ring-rose-200'}`}>
    {tone === 'ok' ? <BadgeCheck className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}{children}
  </span>
)

function UsersTab() {
  const { profile: me } = useAuth()
  const toast = useToast()
  const [users, setUsers] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [q, setQ] = useState('')
  const [propose, setPropose] = useState(null)       // user being changed
  const load = useCallback(async () => {
    const { data } = await supabase.from('profiles').select('*, organizations(name)').order('created_at', { ascending: false })
    setUsers(data || [])
  }, [])
  useEffect(() => { load(); supabase.from('organizations').select('id,name,type').order('name').then(({ data }) => setOrgs(data || [])) }, [load])
  const update = async (u, patch, label) => {
    const { error } = await supabase.from('profiles').update(patch).eq('id', u.id)
    if (error) toast.error(errorMessage(error)); else { toast.success(`${u.full_name} ${label}`); load() }
  }
  const revoke = (u) => {
    if (window.confirm(`Revoke ${ROLE_LABEL[u.role]} access from ${u.full_name}? They keep a Citizen account.`)) update(u, { role: 'citizen' }, 'is now a Citizen')
  }
  if (!users) return <Spinner />
  const shown = users.filter((u) => `${u.full_name} ${u.email} ${u.employee_id || ''}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <Card bodyClass="p-0">
      <div className="p-4"><Input aria-label="Search users" className="max-w-xs" placeholder="Search name, email or ID…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50"><tr><Th>User</Th><Th>Role</Th><Th>Organisation</Th><Th>Sign-in ID</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((u) => {
              const self = u.id === me.id
              return (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{u.full_name}</p>
                    <p className="text-xs text-slate-500">{u.email} {'email_verified_at' in u && (u.email_verified_at ? <span title="E-mail confirmed" className="text-emerald-600">✓</span> : <span title="E-mail not confirmed" className="text-rose-600">✗</span>)}</p>
                    {u.phone && <p className="text-xs text-slate-500">{u.phone} {u.phone_verified_at ? <span title="Verified by SMS" className="text-emerald-600">✓</span> : <span title="Not verified" className="text-slate-400">(unverified)</span>}</p>}
                  </td>
                  <td className="px-3 py-2 text-xs font-medium">{ROLE_LABEL[u.role]}</td>
                  <td className="px-3 py-2 text-xs">{u.organizations?.name || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{u.employee_id || <span className="font-sans text-slate-400">{u.role === 'citizen' || u.role === 'ngo_coordinator' ? '—' : 'missing'}</span>}</td>
                  <td className="px-3 py-2 text-xs">{u.is_active ? 'Active' : <span className="font-semibold text-rose-600">Deactivated</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="secondary" disabled={self} onClick={() => setPropose(u)}>Change access…</Button>
                      {u.role !== 'citizen' && <Button size="sm" variant="secondary" disabled={self} onClick={() => revoke(u)}>Revoke</Button>}
                      {u.is_active
                        ? <Button size="sm" variant="secondary" disabled={self} onClick={() => update(u, { is_active: false }, 'deactivated')}>Deactivate</Button>
                        : <Button size="sm" disabled={self} onClick={() => (u.role === 'citizen' ? update(u, { is_active: true }, 'activated') : setPropose(u))}>Activate</Button>}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 pb-4 text-xs text-slate-500">Enforced in the database: one admin can revoke or deactivate, but granting a staff or admin role, moving a staff member to another organisation, changing a staff ID or re-activating staff needs a <b>second admin</b> to approve (Access requests tab). Admins cannot change their own access.</p>
      <ProposeModal user={propose} orgs={orgs} onClose={() => setPropose(null)} onDone={() => { setPropose(null); load() }} />
    </Card>
  )
}

function ProposeModal({ user, orgs, onClose, onDone }) {
  const toast = useToast()
  const [v, setV] = useState({ role: '', org: '', emp: '', note: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (user) setV({ role: user.role === 'citizen' ? 'field_worker' : user.role, org: user.organization_id || '', emp: user.employee_id || '', note: '' })
  }, [user])
  if (!user) return null
  const needsId = ['city_officer', 'field_worker', 'admin'].includes(v.role)
  const submit = async () => {
    if (v.note.trim().length < 10) { toast.error('Explain the change in the note (10+ characters)'); return }
    if (v.role !== 'admin' && !v.org) { toast.error('Choose the organisation'); return }
    if (needsId && !/^[A-Za-z0-9/-]{3,30}$/.test(v.emp.trim())) { toast.error('Enter a staff ID (3–30 letters, numbers, / or -)'); return }
    setBusy(true)
    const { error } = await supabase.rpc('rm_admin_propose_role_change', {
      p_user: user.id, p_role: v.role, p_org_id: v.org || null, p_employee_id: needsId ? v.emp.trim() : null, p_note: v.note.trim(),
    })
    setBusy(false)
    if (error) toast.error(errorMessage(error))
    else { toast.success('Proposal filed — a different admin must approve it under Access requests'); onDone() }
  }
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  return (
    <Modal open onClose={onClose} title={`Propose access change · ${user.full_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>File for second approval</Button></>}>
      <div className="space-y-4">
        <Alert tone="info">Two-person rule: your proposal counts as the first approval. A <b>different</b> admin has to approve it before it takes effect.</Alert>
        <Field label="New role" required>{(a) => <Select {...a} value={v.role} onChange={set('role')}>{STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>}</Field>
        <Field label="Organisation" required={v.role !== 'admin'}>
          {(a) => <Select {...a} value={v.org} onChange={set('org')}><option value="">{v.role === 'admin' ? 'None' : 'Choose…'}</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}
        </Field>
        {needsId && <Field label="Staff / sign-in ID" required>{(a) => <Input {...a} className="font-mono" maxLength={30} value={v.emp} onChange={set('emp')} />}</Field>}
        <Field label="Reason (recorded in the audit log)" required>{(a) => <Textarea {...a} rows={3} maxLength={500} value={v.note} onChange={set('note')} placeholder="e.g. Transferred from DNCC zone 3, HR letter ref 2026/114" />}</Field>
      </div>
    </Modal>
  )
}

function RequestsTab() {
  const { profile: me } = useAuth()
  const toast = useToast()
  const [status, setStatus] = useState('pending')
  const [rows, setRows] = useState(null)
  const [docs, setDocs] = useState({})       // request id -> documents
  const [err, setErr] = useState('')
  const [orgs, setOrgs] = useState([])
  const [pick, setPick] = useState({})      // request id -> chosen org id
  const [notes, setNotes] = useState({})    // request id -> review note
  const [busy, setBusy] = useState(null)
  const load = useCallback(async () => {
    const base = '*, applicant:profiles!role_requests_user_id_fkey(full_name, email, phone, role), organizations(name), wards(name)'
    let { data, error } = await supabase.from('role_requests')
      .select(`${base}, verification, proposer:profiles!role_requests_requested_by_fkey(full_name)`)
      .eq('status', status).order('created_at', { ascending: false }).limit(200)
    if (error && /verification|requested_by/i.test(error.message)) {      // migration 008 not applied yet
      ({ data, error } = await supabase.from('role_requests').select(base).eq('status', status).order('created_at', { ascending: false }).limit(200))
    }
    if (error) {
      setErr(/does not exist|schema cache/i.test(error.message)
        ? 'The access-request table is missing. Run supabase/migrations/006–008 in the Supabase SQL editor.'
        : errorMessage(error))
      setRows([]); return
    }
    setErr(''); setRows(data || [])
    const ids = (data || []).map((r) => r.id)
    if (ids.length) {
      const { data: d } = await supabase.from('role_request_documents').select('*').in('request_id', ids).order('created_at')
      setDocs((d || []).reduce((m, x) => ({ ...m, [x.request_id]: [...(m[x.request_id] || []), x] }), {}))
    } else setDocs({})
  }, [status])
  useEffect(() => { load() }, [load])
  useEffect(() => { supabase.from('organizations').select('id,name,type').order('name').then(({ data }) => setOrgs(data || [])) }, [])
  useEffect(() => {
    const ch = supabase.channel('admin:approvals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_requests' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_request_approvals' }, load).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const openDoc = async (d) => {
    const { data, error } = await supabase.storage.from('staff-documents').createSignedUrl(d.storage_path, 120)
    if (error) toast.error(errorMessage(error)); else window.open(data.signedUrl, '_blank', 'noopener')
  }
  const review = async (r, approve) => {
    const org = pick[r.id] ?? r.organization_id ?? ''
    const note = (notes[r.id] || '').trim()
    if (approve && !org && r.requested_role !== 'admin') { toast.error('Choose the organisation this person belongs to before approving'); return }
    if (!approve && note.length < 3) { toast.error('Add a short reason so the applicant knows why'); return }
    if (approve && r.verification?.flags?.length && note.length < 10) { toast.error('This request failed some checks — explain in the note (10+ characters) why it is genuine'); return }
    setBusy(r.id)
    const { data, error } = await supabase.rpc('rm_review_role_request', { p_id: r.id, p_approve: approve, p_org_id: org || null, p_note: note || null })
    setBusy(null)
    if (error) { toast.error(errorMessage(error)); return }
    const name = r.applicant?.full_name || 'Request'
    if (!approve) toast.success(`${name} rejected`)
    else if (data?.status === 'pending') toast.info(`Approval ${data.approvals} of ${data.required} recorded. A different admin must give the next approval.`, 'Two-person rule')
    else toast.success(`${name} approved as ${ROLE_LABEL[r.requested_role]}`)
    setNotes((n) => ({ ...n, [r.id]: '' }))
    load()
  }

  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-2 p-4">
        <Select aria-label="Filter by status" className="max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
        </Select>
        <p className="text-xs text-slate-500">Every request is checked live against the staff roster, official e-mail domains and the NGOAB registry. Water Resilience Officer / Admin grants and anything with a red flag need two different admins.</p>
      </div>
      {err && <div className="px-4 pb-4"><Alert tone="error">{err}</Alert></div>}
      {!rows ? <Spinner /> : rows.length === 0 ? (!err && <EmptyState icon={UserCheck} title={`No ${status} requests`}>New staff sign-ups and admin proposals will appear here.</EmptyState>) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Applicant</Th><Th>Requested role</Th><Th>Verification</Th><Th>Documents</Th><Th>Organisation</Th><Th>{status === 'pending' ? 'Decision' : 'Reviewed'}</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const v = r.verification
                const approvals = v?.approvals || []
                const mine = approvals.some((a) => a.admin_id === me.id)
                const blockers = v?.blockers || []
                const label = (group, key) => CHECK_LABEL[group][key]
                return (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">{r.applicant?.full_name}</p>
                      <p className="text-xs text-slate-500">{r.applicant?.email}</p>
                      <p className="text-xs text-slate-500">{r.applicant?.phone}</p>
                      <p className="mt-1 text-[11px] text-slate-400">{fmtDateTime(r.created_at)}</p>
                      {r.source === 'admin' && <p className="mt-1 text-[11px] font-medium text-violet-700">Proposed by {r.proposer?.full_name || 'an admin'}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="whitespace-nowrap rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">{ROLE_LABEL[r.requested_role]}</span>
                      <div className="mt-2 space-y-0.5 text-xs text-slate-600">
                        {r.employee_id && <p>ID: <span className="font-mono">{r.employee_id}</span></p>}
                        {r.designation && <p>{r.designation}</p>}
                        {r.team && <p>Team: {r.team}</p>}
                        {r.wards?.name && <p>Area: {r.wards.name}</p>}
                        {r.registration_no && <p>NGOAB reg: {r.registration_no}</p>}
                      </div>
                    </td>
                    <td className="min-w-[220px] px-3 py-2">
                      {!v ? <span className="text-xs text-slate-400">run migration 008</span> : (
                        <div className="flex flex-col items-start gap-1">
                          {[['roster', v.roster], ['email_domain', v.email_domain], ['ngoab', v.ngoab]].map(([g, k]) => label(g, k) && <Badge key={g} tone={label(g, k)[0]}>{label(g, k)[1]}</Badge>)}
                          <Badge tone={v.email_confirmed ? 'ok' : 'bad'}>{v.email_confirmed ? 'E-mail confirmed' : 'E-mail not confirmed'}</Badge>
                          <Badge tone={v.phone_verified ? 'ok' : 'warn'}>{v.phone_verified ? 'Phone verified (SMS)' : 'Phone not verified'}</Badge>
                          {v.ngo_seat && <Badge tone="bad">Already holds a post</Badge>}
                          {v.ngo_seat && <p className="text-xs text-rose-700">{v.ngo_seat.charAt(0).toUpperCase() + v.ngo_seat.slice(1)}.</p>}
                          {v.ngo_transfer_from && <Badge tone="warn">Transfer from {v.ngo_transfer_from}</Badge>}
                          {status === 'pending' && blockers.length > 0 && (
                            <p className="mt-1 text-xs font-medium text-rose-700">Cannot approve yet: {blockers.map((b) => BLOCKER_LABEL[b] || b).join('; ')}</p>
                          )}
                          {status === 'pending' && v.flags?.length > 0 && (
                            <p className="text-xs text-amber-800">Needs 2 admins + a written reason ({v.flags.map((f) => FLAG_LABEL[f] || f).join(', ')})</p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {(docs[r.id] || []).length === 0 ? <span className="text-slate-400">{r.source === 'admin' ? 'n/a (admin proposal)' : 'None uploaded'}</span> : (
                        <ul className="space-y-1">
                          {docs[r.id].map((d) => (
                            <li key={d.id}><button type="button" onClick={() => openDoc(d)} className="inline-flex items-center gap-1 text-brand-700 hover:underline"><FileText className="h-3.5 w-3.5" aria-hidden />{DOC_KINDS.find(([k]) => k === d.kind)?.[1] || d.kind}</button></li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {status === 'pending' ? (
                        <>
                          <Select aria-label={`Organisation for ${r.applicant?.full_name}`} className="!w-auto !py-1 text-xs" disabled={approvals.length > 0}
                            value={pick[r.id] ?? r.organization_id ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                            <option value="">Choose…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                          </Select>
                          {approvals.length > 0 && <p className="mt-1 text-slate-500">Fixed by the first approver</p>}
                          {!r.organization_id && r.organization_name && <p className="mt-1 text-amber-700">Applicant typed: “{r.organization_name}” (not listed)</p>}
                        </>
                      ) : (r.organizations?.name || r.organization_name || '—')}
                    </td>
                    <td className="px-3 py-2">
                      {approvals.length > 0 && (
                        <ul className="mb-2 space-y-0.5 text-[11px] text-slate-600">
                          {approvals.map((a) => <li key={a.admin_id}>✓ {a.name || 'admin'} · {fmtDateTime(a.at)}{a.note ? ` — “${a.note}”` : ''}</li>)}
                        </ul>
                      )}
                      {status === 'pending' ? (
                        <div className="flex min-w-[240px] flex-col gap-2">
                          <Input aria-label="Review note" className="!py-1 text-xs" maxLength={500}
                            placeholder={v?.flags?.length ? 'Required: why is this genuine? (10+ chars)' : 'Note (required to reject)'}
                            value={notes[r.id] || ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                          <div className="flex gap-2">
                            <Button size="sm" loading={busy === r.id} disabled={mine || (r.source === 'admin' && r.requested_by === me.id) || blockers.length > 0}
                              title={mine ? 'You already approved — a different admin must approve' : undefined} onClick={() => review(r, true)}>
                              <Check className="h-3.5 w-3.5" />Approve{v ? ` (${Math.min(approvals.length + 1, v.required_approvals)}/${v.required_approvals})` : ''}
                            </Button>
                            <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => review(r, false)}><X className="h-3.5 w-3.5" />Reject</Button>
                          </div>
                          {mine && <p className="text-[11px] text-slate-500">Waiting for a second admin.</p>}
                        </div>
                      ) : (
                        <div className="text-xs text-slate-600"><p>{fmtDateTime(r.reviewed_at)}</p>{r.review_note && <p className="mt-1 italic">“{r.review_note}”</p>}</div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ---------- official registries & domains ----------
function VerificationTab() {
  const [settings, setSettings] = useState(null)
  useEffect(() => { supabase.rpc('rm_public_security_settings').then(({ data }) => setSettings(data || null)) }, [])
  return (
    <div className="space-y-5">
      <OrgDomains />
      <RosterImport />
      <NgoRegistryImport />
      {settings && (
        <Card title="Security settings" icon={Lock} subtitle="Read-only here. They can only be changed from the Supabase SQL editor (table security_settings), never from the browser.">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {[
              ['SMS-verified phone required for citizen reports', settings.require_phone_verification ? 'On' : 'Off — needs an SMS provider in Supabase'],
              ['Official e-mail domain for Water Resilience Officers / NGOs', settings.require_official_email ? 'On' : 'Off'],
              ['Confirmed e-mail required before approval', settings.require_email_confirmed ? 'On' : 'Off'],
              ['ID card / appointment letter required', settings.require_documents ? 'On' : 'Off'],
              ['Two admins always required for', (settings.two_person_roles || []).map((r) => ROLE_LABEL[r]).join(', ') || '—'],
              ['Authenticator app mandatory for', (settings.mfa_required_roles || []).map((r) => ROLE_LABEL[r]).join(', ') || 'nobody (optional for everyone)'],
              ['Citizen report limit', `${settings.citizen_reports_per_hour} / hour, ${settings.citizen_reports_per_day} / day`],
            ].map(([k, val]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium">{val}</dd></div>)}
          </dl>
        </Card>
      )}
    </div>
  )
}

function OrgDomains() {
  const toast = useToast()
  const [orgs, setOrgs] = useState(null)
  const [edit, setEdit] = useState({})
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('organizations').select('id,name,type,email_domains,ngoab_registration_no').in('type', ['city_authority', 'ngo']).order('name')
    if (error) { setOrgs([]); return }
    setOrgs(data || [])
    setEdit(Object.fromEntries((data || []).map((o) => [o.id, { domains: (o.email_domains || []).join(', '), reg: o.ngoab_registration_no || '' }])))
  }, [])
  useEffect(() => { load() }, [load])
  const save = async (o) => {
    const e = edit[o.id]
    const domains = e.domains.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
    const { error } = await supabase.from('organizations').update({ email_domains: domains, ...(o.type === 'ngo' && { ngoab_registration_no: e.reg.trim() || null }) }).eq('id', o.id)
    if (error) toast.error(errorMessage(error)); else { toast.success(`${o.name} saved`); load() }
  }
  return (
    <Card title="Official e-mail domains" icon={Globe} subtitle="Water Resilience Officers must sign up with one of their authority's domains (e.g. dncc.gov.bd); NGO staff with their NGO's domain. Public mail providers are refused." bodyClass="p-0">
      {!orgs ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Organisation</Th><Th>E-mail domains</Th><Th>NGOAB reg. no.</Th><Th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td className="px-3 py-2"><p className="font-medium">{o.name}</p><p className="text-xs text-slate-500">{o.type === 'ngo' ? 'NGO' : 'City authority'}</p></td>
                  <td className="px-3 py-2"><Input aria-label={`Domains for ${o.name}`} className="!py-1 font-mono text-xs" placeholder="dncc.gov.bd" value={edit[o.id]?.domains || ''} onChange={(e) => setEdit({ ...edit, [o.id]: { ...edit[o.id], domains: e.target.value } })} /></td>
                  <td className="px-3 py-2">{o.type === 'ngo'
                    ? <Input aria-label={`NGOAB number for ${o.name}`} className="!w-36 !py-1 font-mono text-xs" value={edit[o.id]?.reg || ''} onChange={(e) => setEdit({ ...edit, [o.id]: { ...edit[o.id], reg: e.target.value } })} />
                    : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="px-3 py-2"><Button size="sm" variant="secondary" onClick={() => save(o)}>Save</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function CsvInput({ value, onChange, placeholder }) {
  const onFile = async (e) => { const f = e.target.files?.[0]; if (f) onChange(await f.text()) }
  return (
    <div className="space-y-2">
      <input type="file" accept=".csv,text/csv" onChange={onFile} aria-label="CSV file"
        className="block text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-brand-700" />
      <Textarea aria-label="CSV content" rows={5} className="font-mono text-xs" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function ImportResult({ result }) {
  if (!result) return null
  return (
    <Alert tone={result.errors?.length ? 'warning' : 'success'} className="mt-3">
      {['inserted', 'updated', 'deactivated', 'upserted'].filter((k) => k in result).map((k) => `${result[k]} ${k}`).join(' · ')}
      {result.errors?.length > 0 && <ul className="mt-1 list-disc pl-5">{result.errors.slice(0, 8).map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}{result.errors.length > 8 && <li>…and {result.errors.length - 8} more</li>}</ul>}
    </Alert>
  )
}

function RosterImport() {
  const toast = useToast()
  const [orgs, setOrgs] = useState([])
  const [org, setOrg] = useState('')
  const [csv, setCsv] = useState('')
  const [replace, setReplace] = useState(false)
  const [rows, setRows] = useState([])
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { supabase.from('organizations').select('id,name,type').in('type', ['city_authority', 'ngo']).order('name').then(({ data }) => setOrgs(data || [])) }, [])
  const load = useCallback(async () => {
    if (!org) { setRows([]); return }
    const { data } = await supabase.from('staff_roster').select('*').eq('organization_id', org).order('employee_id').limit(500)
    setRows(data || [])
  }, [org])
  useEffect(() => { load() }, [load])
  const run = async () => {
    const parsed = parseCsv(csv)
    if (!org) { toast.error('Choose the organisation this roster belongs to'); return }
    if (!parsed.length) { toast.error('Paste or choose a CSV with a header row'); return }
    if (replace && !window.confirm(`Deactivate every ${orgs.find((o) => o.id === org)?.name} roster entry that is not in this file?`)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('rm_import_staff_roster', { p_org: org, p_rows: parsed, p_replace: replace })
    setBusy(false)
    if (error) toast.error(errorMessage(error)); else { setResult(data); load() }
  }
  return (
    <Card title="Official staff roster" icon={Users} subtitle="Upload the list each city corporation / NGO HR office provides. Sign-up requests are matched against it (Employee ID + official e-mail).">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Select aria-label="Roster organisation" value={org} onChange={(e) => { setOrg(e.target.value); setResult(null) }}>
            <option value="">Choose organisation…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          <CsvInput value={csv} onChange={setCsv} placeholder={'employee_id,official_email,full_name,role\nDSCC-2024-118,rahim@dscc.gov.bd,Rahim Uddin,city_officer'} />
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />Replace: deactivate people not in this file (left the organisation)</label>
          <Button loading={busy} onClick={run}><Upload className="h-4 w-4" />Import roster</Button>
          <ImportResult result={result} />
        </div>
        <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
          {!org ? <p className="p-4 text-sm text-slate-500">Choose an organisation to see its roster.</p> : rows.length === 0 ? <p className="p-4 text-sm text-slate-500">No roster entries yet.</p> : (
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-slate-50"><tr><Th>ID</Th><Th>Official e-mail</Th><Th>Name</Th><Th>Role</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((x) => (
                  <tr key={x.id} className={x.is_active ? '' : 'text-slate-400 line-through'}>
                    <td className="px-3 py-1.5 font-mono">{x.employee_id || '—'}</td><td className="px-3 py-1.5">{x.official_email || '—'}</td>
                    <td className="px-3 py-1.5">{x.full_name || '—'}</td><td className="px-3 py-1.5">{x.role ? ROLE_LABEL[x.role] : 'any'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Card>
  )
}

function NgoRegistryImport() {
  const toast = useToast()
  const [csv, setCsv] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    let query = supabase.from('ngo_registry').select('*', { count: 'exact' }).order('registration_no').limit(50)
    if (q.trim()) query = query.or(`registration_no.ilike.%${q.trim().replace(/[,%()]/g, '')}%,name.ilike.%${q.trim().replace(/[,%()]/g, '')}%`)
    const { data, count } = await query
    setRows(data || []); setTotal(count || 0)
  }, [q])
  useEffect(() => { load() }, [load])
  const run = async () => {
    const parsed = parseCsv(csv)
    if (!parsed.length) { toast.error('Paste or choose a CSV with a header row'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('rm_import_ngo_registry', { p_rows: parsed })
    setBusy(false)
    if (error) toast.error(errorMessage(error)); else { setResult(data); load() }
  }
  return (
    <Card title="NGO Affairs Bureau registry" icon={Building2} subtitle="The NGOAB list of registered NGOs. NGO Coordinator requests are checked against the registration number.">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <CsvInput value={csv} onChange={setCsv} placeholder={'registration_no,name,district,status,valid_until\n2891,Example Relief Foundation,Dhaka,active,2030-06-30'} />
          <Button loading={busy} onClick={run}><Upload className="h-4 w-4" />Import registry</Button>
          <ImportResult result={result} />
        </div>
        <div>
          <Input aria-label="Search registry" placeholder={`Search ${fmtNum(total)} registered NGOs…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-slate-50"><tr><Th>Reg. no.</Th><Th>Name</Th><Th>Status</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((x) => <tr key={x.id}><td className="px-3 py-1.5 font-mono">{x.registration_no}</td><td className="px-3 py-1.5">{x.name}</td><td className="px-3 py-1.5">{x.status}{x.valid_until ? ` · until ${x.valid_until}` : ''}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  )
}

function SystemTab() {
  const toast = useToast()
  const [h, setH] = useState(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => api('/api/admin/health').then((x) => { setH(x); setErr('') }).catch((e) => setErr(e.message)), [])
  useEffect(() => { load() }, [load])
  const chaos = async (mode) => {
    try { await api('/api/admin/chaos', { method: 'POST', body: { weather_mode: mode } }); toast.info(`Weather API mode: ${mode}`); load() } catch (e) { toast.error(errorMessage(e)) }
  }
  if (err) return <Alert tone="error">Backend unavailable: {err}</Alert>
  if (!h) return <Spinner />
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="DB latency" value={`${h.db_latency_ms} ms`} icon={Activity} />
        <StatCard label="Queued runs" value={h.counts.queued_runs} icon={Activity} tone="sky" />
        <StatCard label="Failed/compensated" value={h.counts.failed_runs} tone="red" />
        <StatCard label="Audit rows" value={fmtNum(h.counts.audit_rows)} icon={ScrollText} tone="violet" />
        <StatCard label="Incidents" value={fmtNum(h.counts.incidents)} icon={Users} />
        <StatCard label="Historical rows" value={fmtNum(h.counts.historical_rows)} tone="amber" />
        <StatCard label="Weather breaker" value={h.weather.breaker} tone={h.weather.breaker === 'closed' ? 'green' : 'red'} />
        <StatCard label="Model" value={h.model.version} hint={`R² ${h.model.metrics.r2}`} />
      </div>
      <Card title="Chaos testing — external API fault injection" subtitle="Demonstrates A06: the app must keep working when the weather API times out or returns garbage">
        <div className="flex flex-wrap gap-2">
          {[['normal', 'Normal'], ['timeout', 'Simulate timeout'], ['error500', 'Simulate 503 outage'], ['malformed', 'Simulate malformed JSON']].map(([m, l]) => (
            <Button key={m} variant={h.weather.chaos_mode === m ? 'primary' : 'secondary'} onClick={() => chaos(m)}><FlaskConical className="h-4 w-4" />{l}</Button>
          ))}
        </div>
        <p className="mt-3 text-sm text-slate-600">Then open AI Risk Analysis → "Re-score all wards": scores still compute from stale cache / climatology, flagged as degraded. After 3 failures the circuit breaker opens and the upstream is skipped for 60 s.</p>
        <p className="mt-1 text-xs text-slate-500">Served so far: {Object.entries(h.weather.stats).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      </Card>
    </div>
  )
}

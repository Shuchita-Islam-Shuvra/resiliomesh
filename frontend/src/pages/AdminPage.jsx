import { useCallback, useEffect, useState } from 'react'
import { Activity, FlaskConical, ScrollText, Users } from 'lucide-react'
import { Alert, Button, Card, Input, PageHeader, Pagination, Select, Spinner, StatCard, Tabs, Th } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { ROLE_LABEL, fmtDateTime, fmtNum } from '../lib/format'
import { supabase } from '../lib/supabase'

export default function AdminPage() {
  const [tab, setTab] = useState('audit')
  return (
    <>
      <PageHeader title="Audit logs & administration" description="Append-only audit trail written by database triggers, account & role management, system health and fault-injection controls." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'audit', label: 'Audit log' }, { value: 'users', label: 'Users & roles' }, { value: 'system', label: 'System health & chaos' }]} />
      {tab === 'audit' && <Audit />}
      {tab === 'users' && <UsersTab />}
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
        <Select aria-label="Filter by table" className="max-w-[220px]" value={table} onChange={(e) => { setPage(1); setTable(e.target.value) }}><option value="">All tables</option>{['incidents', 'resources', 'allocations', 'allocation_plans', 'tasks', 'profiles', 'community_needs', 'workflow_runs', 'drainage_assets'].map((t) => <option key={t}>{t}</option>)}</Select>
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

function UsersTab() {
  const { profile: me } = useAuth()
  const toast = useToast()
  const [users, setUsers] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    const { data } = await supabase.from('profiles').select('*, organizations(name)').order('created_at', { ascending: false })
    setUsers(data || [])
  }, [])
  useEffect(() => { load(); supabase.from('organizations').select('id,name').then(({ data }) => setOrgs(data || [])) }, [load])
  const update = async (u, patch) => {
    const { error } = await supabase.from('profiles').update(patch).eq('id', u.id)
    if (error) toast.error(errorMessage(error)); else { toast.success(`${u.full_name} updated`); load() }
  }
  if (!users) return <Spinner />
  const shown = users.filter((u) => `${u.full_name} ${u.email}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <Card bodyClass="p-0">
      <div className="p-4"><Input aria-label="Search users" className="max-w-xs" placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50"><tr><Th>User</Th><Th>Role</Th><Th>Organisation</Th><Th>Status</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2"><p className="font-medium">{u.full_name}</p><p className="text-xs text-slate-500">{u.email}</p></td>
                <td className="px-3 py-2">
                  <Select aria-label={`Role for ${u.full_name}`} className="!w-auto !py-1 text-xs" value={u.role} disabled={u.id === me.id} onChange={(e) => update(u, { role: e.target.value })}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <Select aria-label={`Organisation for ${u.full_name}`} className="!w-auto !py-1 text-xs" value={u.organization_id || ''} onChange={(e) => update(u, { organization_id: e.target.value || null })}>
                    <option value="">None</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <Button size="sm" variant={u.is_active ? 'secondary' : 'primary'} disabled={u.id === me.id} onClick={() => update(u, { is_active: !u.is_active })}>{u.is_active ? 'Deactivate' : 'Activate'}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 pb-4 text-xs text-slate-500">Role changes are enforced in the database (trigger + RLS): non-admins cannot escalate privileges even via the raw API, and admins cannot change their own role.</p>
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

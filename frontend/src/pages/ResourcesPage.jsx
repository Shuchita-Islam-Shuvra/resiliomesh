import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Boxes, Check, Cpu, Pencil, Plus, X } from 'lucide-react'
import ConflictDialog from '../components/ConflictDialog'
import { Alert, Button, Card, EmptyState, Field, Input, Modal, PageHeader, RiskBadge, Select, Spinner, StatusBadge, Tabs, Th } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { RESOURCE_LABEL, fmtDateTime, humanize, timeAgo, uuid } from '../lib/format'
import { supabase } from '../lib/supabase'
import { validateResource } from '../lib/validation'

export default function ResourcesPage() {
  const [params, setParams] = useSearchParams()
  const { hasRole } = useAuth()
  const planner = hasRole('city_officer', 'admin')   // pump & crew plans are the officers' job (015)
  const asked = params.get('tab') || 'inventory'
  const tab = asked === 'plans' && !planner ? 'inventory' : asked
  return (
    <>
      <PageHeader title="Resource inventory & allocation" description={planner
        ? "Inventory is organisation-scoped. The optimiser proposes allocations; a Water Resilience Officer approves; the workflow reserves stock atomically and dispatches teams."
        : "Your organisation's relief stock. Allocate it to community needs on the NGO page."} />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
        { value: 'inventory', label: 'Inventory' }, ...(planner ? [{ value: 'plans', label: 'Optimise & approve' }] : []), { value: 'allocations', label: 'Allocations' }]} />
      {tab === 'inventory' && <Inventory />}
      {tab === 'plans' && planner && <Plans preselect={params.get('incident')} />}
      {tab === 'allocations' && <Allocations />}
    </>
  )
}

// ---------------------------------------------------------------- inventory
function Inventory() {
  const { profile, hasRole } = useAuth()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [filter, setFilter] = useState({ type: '', org: '', q: '' })
  const [edit, setEdit] = useState(null)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('resources').select('*, organizations(name,type)').order('resource_type').order('name')
    setRows(data || [])
  }, [])
  useEffect(() => { load(); supabase.from('organizations').select('id,name,type').then(({ data }) => setOrgs(data || [])) }, [load])
  useRealtime('resources', useDebouncedCallback(load, 500))

  // Each role sees its own kind of stock (migration 016 enforces the same in the database):
  // NGO coordinator = own NGO's relief stock, officer = city-authority equipment, admin = all.
  const isNgo = hasRole('ngo_coordinator')
  const isOfficer = hasRole('city_officer')
  const mine = useCallback((r) => isNgo ? r.organization_id === profile.organization_id
    : isOfficer ? r.organization_id === profile.organization_id || r.organizations?.type === 'city_authority'
    : true, [isNgo, isOfficer, profile.organization_id])
  const types = Object.entries(RESOURCE_LABEL).filter(([k]) => !isNgo || !['pump', 'crew'].includes(k))
  const shown = useMemo(() => (rows || []).filter((r) => mine(r) &&
    (!filter.type || r.resource_type === filter.type) && (!filter.org || r.organization_id === filter.org) &&
    (!filter.q || r.name.toLowerCase().includes(filter.q.toLowerCase()))), [rows, filter, mine])
  const totals = useMemo(() => {
    const t = {}
    for (const r of shown) { t[r.resource_type] ??= { total: 0, avail: 0 }; t[r.resource_type].total += r.quantity_total; t[r.resource_type].avail += r.quantity_available }
    return t
  }, [shown])
  const canWrite = (r) => hasRole('admin') || (hasRole('ngo_coordinator', 'city_officer') && r.organization_id === profile.organization_id)

  const save = async () => {
    const e = validateResource(edit)
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const payload = { name: edit.name.trim(), resource_type: edit.resource_type, unit: edit.unit || 'unit',
      quantity_total: Number(edit.quantity_total), quantity_available: Number(edit.quantity_available), lat: Number(edit.lat), lng: Number(edit.lng) }
    try {
      if (edit.id) {
        const { data, error } = await supabase.from('resources').update(payload).eq('id', edit.id).eq('version', edit.version).select()
        if (error) throw error
        if (!data.length) {
          const { data: latest } = await supabase.from('resources').select('*').eq('id', edit.id).single()
          setConflict({ mine: { ...edit, ...payload }, theirs: latest }); return
        }
      } else {
        const { error } = await supabase.from('resources').insert({ ...payload, organization_id: edit.organization_id || profile.organization_id })
        if (error) throw error
      }
      toast.success('Inventory saved'); setEdit(null); load()
    } catch (err) { toast.error(errorMessage(err)) } finally { setBusy(false) }
  }

  const s = (k) => (e) => setEdit({ ...edit, [k]: e.target.value })
  if (!rows) return <Spinner />
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {Object.entries(totals).map(([t, v]) => (
          <div key={t} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-500">{RESOURCE_LABEL[t]}</p>
            <p className="text-lg font-bold">{v.avail}<span className="text-sm font-normal text-slate-400">/{v.total}</span></p>
          </div>
        ))}
      </div>
      <Card bodyClass="p-0"
        title={isNgo ? 'Our relief stock' : isOfficer ? 'City authority equipment' : 'Stock by organisation'}
        subtitle={isNgo ? 'Only your NGO sees and manages this. Pumps and crews belong to the city authorities.' : isOfficer ? 'Pumps, crews and other equipment of the drainage authorities. NGO relief stock is managed by NGO coordinators.' : undefined}
        actions={hasRole('ngo_coordinator', 'city_officer', 'admin') &&
        <Button size="sm" onClick={() => { setErrors({}); setEdit({ name: '', resource_type: 'relief_kit', unit: 'kit', quantity_total: 0, quantity_available: 0, lat: 23.75, lng: 90.39, organization_id: profile.organization_id || '' }) }}><Plus className="h-4 w-4" />Add stock</Button>}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
          <Input aria-label="Search inventory" className="max-w-xs" placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <Select aria-label="Filter by type" className="max-w-[200px]" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">All types</option>{types.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          {!isNgo && <Select aria-label="Filter by organisation" className="max-w-[260px]" value={filter.org} onChange={(e) => setFilter({ ...filter, org: e.target.value })}><option value="">All organisations</option>{orgs.filter((o) => !isOfficer || o.type === 'city_authority').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Resource</Th><Th>Organisation</Th><Th>Available</Th><Th className="hidden md:table-cell">Updated</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((r) => {
                const pct = r.quantity_total ? (r.quantity_available / r.quantity_total) * 100 : 0
                return (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5"><p className="font-medium text-slate-900">{r.name}</p><p className="text-xs text-slate-500">{RESOURCE_LABEL[r.resource_type]}</p></td>
                    <td className="px-3 py-2.5 text-slate-600">{r.organizations?.name}</td>
                    <td className="px-3 py-2.5">
                      <span className={`font-semibold ${r.quantity_available === 0 ? 'text-rose-600' : pct < 25 ? 'text-amber-600' : 'text-slate-900'}`}>{r.quantity_available}</span>
                      <span className="text-slate-400"> / {r.quantity_total} {r.unit}</span>
                      {r.quantity_available === 0 && <span className="ml-2 rounded bg-rose-100 px-1.5 text-xs text-rose-700">depleted</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs text-slate-500 md:table-cell">{timeAgo(r.updated_at)} · v{r.version}</td>
                    <td className="px-3 py-2.5 text-right">{canWrite(r) && <Button size="sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => { setErrors({}); setEdit(r) }}><Pencil className="h-4 w-4" /></Button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={edit?.id ? 'Edit stock' : 'Add stock'}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" error={errors.name} required className="sm:col-span-2">{(a) => <Input {...a} value={edit.name} onChange={s('name')} />}</Field>
            <Field label="Type" error={errors.resource_type}>{(a) => <Select {...a} value={edit.resource_type} onChange={s('resource_type')} disabled={Boolean(edit.id)}>{(edit.id ? Object.entries(RESOURCE_LABEL) : types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label="Unit">{(a) => <Input {...a} value={edit.unit} onChange={s('unit')} />}</Field>
            <Field label="Total" error={errors.quantity_total} required>{(a) => <Input {...a} type="number" min={0} value={edit.quantity_total} onChange={s('quantity_total')} />}</Field>
            <Field label="Available" error={errors.quantity_available} required hint="Cannot exceed total">{(a) => <Input {...a} type="number" min={0} value={edit.quantity_available} onChange={s('quantity_available')} />}</Field>
            {!edit.id && hasRole('admin') && <Field label="Organisation" className="sm:col-span-2">{(a) => <Select {...a} value={edit.organization_id} onChange={s('organization_id')}><option value="">Select</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>}
          </div>
        )}
      </Modal>
      <ConflictDialog conflict={conflict} fields={['quantity_total', 'quantity_available', 'name', 'version']} onClose={() => setConflict(null)}
        onReload={() => { setEdit(conflict.theirs); setConflict(null) }} />
    </>
  )
}

// ---------------------------------------------------------------- optimiser & plans
function Plans({ preselect }) {
  const { hasRole } = useAuth()
  const toast = useToast()
  const [incidents, setIncidents] = useState([])
  const [selected, setSelected] = useState(preselect ? [preselect] : [])
  const [c, setC] = useState({ max_distance_km: 10, reserve_ratio: 0, require_full_coverage_critical: true, pump_requires_crew: true, allow_relaxation: true })
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [plans, setPlans] = useState([])
  const [busy, setBusy] = useState('')
  const [reject, setReject] = useState(null)
  const [inject, setInject] = useState('')

  const load = useCallback(async () => {
    const [i, p] = await Promise.all([
      supabase.from('incidents').select('id,reference_code,title,category,risk_level,risk_score,priority,water_depth_cm,people_affected,wards(name)').eq('status', 'assessed').order('priority', { ascending: false }),
      supabase.from('allocation_plans').select('*').order('created_at', { ascending: false }).limit(15),
    ])
    setIncidents(i.data || []); setPlans(p.data || [])
  }, [])
  useEffect(() => { load() }, [load])
  useRealtime(['allocation_plans', 'incidents'], useDebouncedCallback(load, 600))

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const run = async () => {
    setRunning(true); setResult(null)
    try {
      const out = await api('/api/plans/optimize', {
        method: 'POST', idempotencyKey: uuid(),
        body: { incident_ids: selected, constraints: { ...c, max_distance_km: Number(c.max_distance_km), reserve_ratio: Number(c.reserve_ratio) } },
      })
      setResult(out)
      if (out.result.status === 'INVALID_CONSTRAINTS') toast.error('Constraints conflict with each other — see diagnosis.')
      else if (out.result.relaxed) toast.warning('Not every critical incident can be fully covered. A relaxed plan was produced.')
      else toast.success(`Plan generated in ${out.result.solve_ms} ms`)
      load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setRunning(false) }
  }

  const approve = async (p) => {
    setBusy(p.id)
    try {
      const { data, error } = await supabase.rpc('approve_plan', { p_plan_id: p.id, p_expected_version: p.version, p_inject_failure: inject || null })
      if (error) throw error
      if (data.conflict) { toast.warning('Plan was modified by someone else — reloaded.'); load(); return }
      toast.success(data.replayed ? 'Plan was already approved (duplicate click ignored).' : 'Approved. Dispatch workflow queued.')
      api('/api/workflows/process-now', { method: 'POST' }).catch(() => {})   // nudge worker on sleepy hosts
      load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy('') }
  }
  const doReject = async () => {
    try {
      const { error } = await supabase.rpc('reject_plan', { p_plan_id: reject.id, p_reason: reject.reason })
      if (error) throw error
      toast.success('Plan rejected'); setReject(null); load()
    } catch (e) { toast.error(errorMessage(e)) }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card title="1 · Select AI-assessed incidents" subtitle="Only incidents in 'assessed' state can be planned" bodyClass="p-0">
          {incidents.length === 0 ? <EmptyState icon={Boxes} title="No assessed incidents">Verify a report and run the AI assessment first.</EmptyState> : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {incidents.map((i) => (
                <li key={i.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={selected.includes(i.id)} onChange={() => toggle(i.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{i.title}</span>
                      <span className="text-xs text-slate-500">{i.reference_code} · {i.wards?.name} · depth {i.water_depth_cm ?? '—'} cm · {i.people_affected} people · priority {i.priority}</span>
                    </span>
                    <RiskBadge level={i.risk_level} score={i.risk_score} />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="2 · Constraints">
          <div className="space-y-3">
            <Field label="Max response distance (km)">{(a) => <Input {...a} type="number" step="0.5" value={c.max_distance_km} onChange={(e) => setC({ ...c, max_distance_km: e.target.value })} />}</Field>
            <Field label="Strategic reserve (0–0.9)" hint="Fraction of every stock held back for new emergencies">{(a) => <Input {...a} type="number" step="0.05" value={c.reserve_ratio} onChange={(e) => setC({ ...c, reserve_ratio: e.target.value })} />}</Field>
            {[['require_full_coverage_critical', 'Critical incidents must be fully covered'], ['pump_requires_crew', 'Pumps require an operating crew'], ['allow_relaxation', 'If infeasible, return best-effort plan']].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.checked })} />{l}</label>
            ))}
            <Button className="w-full" loading={running} disabled={!selected.length} onClick={run}><Cpu className="h-4 w-4" />Run optimiser ({selected.length})</Button>
          </div>
        </Card>
      </div>

      {result && <PlanResult out={result} />}

      <Card title="3 · Plans" subtitle="Approve to trigger the automated dispatch workflow"
        actions={hasRole('admin') && (
          <label className="flex items-center gap-2 text-xs text-slate-600">Fault injection
            <Select className="!w-auto !py-1 text-xs" value={inject} onChange={(e) => setInject(e.target.value)}>
              <option value="">none</option>{['reserve_resources', 'create_tasks', 'notify_teams', 'activate_incidents'].map((s) => <option key={s} value={s}>fail at {s}</option>)}
            </Select>
          </label>)} bodyClass="p-0">
        {plans.length === 0 ? <EmptyState title="No plans yet" /> : (
          <ul className="divide-y divide-slate-100">
            {plans.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><StatusBadge status={p.status} />
                    {p.relaxed && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">relaxed</span>}
                    {!p.feasible && !p.relaxed && <span className="rounded bg-rose-100 px-1.5 text-xs text-rose-700">infeasible</span>}
                    <span className="text-sm text-slate-700">{p.incident_ids.length} incident(s) · {p.assignments.length} assignment(s)</span></div>
                  <p className="text-xs text-slate-500">{fmtDateTime(p.created_at)} · {p.explanation?.solve_ms} ms · {p.explanation?.status}{p.rejection_reason ? ` · ${p.rejection_reason}` : ''}</p>
                </div>
                {p.status === 'pending_approval' && (
                  <div className="flex gap-2">
                    <Button size="sm" loading={busy === p.id} onClick={() => approve(p)}><Check className="h-4 w-4" />Approve</Button>
                    <Button size="sm" variant="secondary" onClick={() => setReject({ id: p.id, reason: '' })}><X className="h-4 w-4" />Reject</Button>
                  </div>
                )}
                {['approved', 'executing', 'executed', 'failed'].includes(p.status) && <Link className="text-xs font-medium text-brand-700 hover:underline" to="/workflows">View workflow</Link>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={Boolean(reject)} onClose={() => setReject(null)} title="Reject plan"
        footer={<><Button variant="secondary" onClick={() => setReject(null)}>Cancel</Button><Button variant="danger" disabled={!reject?.reason?.trim()} onClick={doReject}>Reject</Button></>}>
        <Field label="Reason" required>{(a) => <Input {...a} value={reject?.reason || ''} onChange={(e) => setReject({ ...reject, reason: e.target.value })} />}</Field>
      </Modal>
    </div>
  )
}

function PlanResult({ out }) {
  const r = out.result
  return (
    <Card title="Optimiser result" subtitle={`${r.status} · ${r.solve_ms} ms · objective ${r.objective ?? '—'}`}
      actions={<span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.feasible ? 'bg-emerald-100 text-emerald-700' : r.relaxed ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-700'}`}>{r.feasible ? 'Feasible' : r.relaxed ? 'Relaxed (partial)' : 'Infeasible'}</span>}>
      {r.conflicts?.length > 0 && <Alert tone="error" title="Conflicting constraints" className="mb-3"><ul className="list-disc pl-5">{r.conflicts.map((x) => <li key={x}>{x}</li>)}</ul></Alert>}
      {r.notes?.map((n) => <Alert key={n} tone="warning" className="mb-2">{n}</Alert>)}
      {r.shortages?.length > 0 && (
        <div className="mb-4">
          <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Shortages</p>
          <ul className="space-y-1 text-sm">{r.shortages.map((s, i) => <li key={i} className="text-rose-700">{s.incident}: {RESOURCE_LABEL[s.resource_type]} — need {s.required}, reachable {s.reachable} (short by {s.short_by})</li>)}</ul>
        </div>
      )}
      {r.assignments.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Incident</Th><Th>Resource</Th><Th>Qty</Th><Th>Distance</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {r.assignments.map((a, i) => (
                <tr key={i}><td className="px-3 py-2">{a.incident}</td><td className="px-3 py-2">{a.resource_name} <span className="text-xs text-slate-500">({humanize(a.resource_type)})</span></td><td className="px-3 py-2 font-medium">{a.quantity}</td><td className="px-3 py-2">{a.distance_km} km</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.coverage?.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {r.coverage.map((cv, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-2 text-xs">
              <p className="font-medium">{cv.incident} · {RESOURCE_LABEL[cv.resource_type]}</p>
              <div className="mt-1 h-1.5 rounded bg-slate-100"><div className={`h-1.5 rounded ${cv.pct >= 100 ? 'bg-emerald-500' : cv.pct > 0 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.min(100, cv.pct)}%` }} /></div>
              <p className="mt-1 text-slate-500">{cv.allocated}/{cv.required} ({cv.pct}%)</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------- allocations
function Allocations() {
  const { profile, hasRole } = useAuth()
  const isNgo = hasRole('ngo_coordinator')
  const [rows, setRows] = useState(null)
  const load = useCallback(async () => {
    let q = supabase.from('allocations').select('*, resources!inner(name,resource_type,organization_id), incidents(reference_code), community_needs(id,need_type)').order('created_at', { ascending: false }).limit(100)
    if (isNgo) q = q.eq('resources.organization_id', profile.organization_id)
    const { data } = await q
    setRows(data || [])
  }, [isNgo, profile.organization_id])
  useEffect(() => { load() }, [load])
  useRealtime('allocations', useDebouncedCallback(load, 500))
  if (!rows) return <Spinner />
  return (
    <Card bodyClass="p-0" title="Reservations ledger" subtitle="Every unit is reserved through an idempotent, row-locked transaction">
      {rows.length === 0 ? <EmptyState title="No allocations yet" /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Resource</Th><Th>For</Th><Th>Qty</Th><Th>Status</Th><Th className="hidden md:table-cell">Idempotency key</Th><Th>When</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2">{a.resources?.name}</td>
                  <td className="px-3 py-2 text-slate-600">{a.incidents?.reference_code || (a.community_needs ? `Need · ${humanize(a.community_needs.need_type)}` : '—')}</td>
                  <td className="px-3 py-2 font-medium">{a.quantity}</td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${a.status === 'released' ? 'bg-zinc-100 text-zinc-600' : a.status === 'consumed' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}`}>{a.status}</span>{a.released_reason && <p className="mt-0.5 max-w-xs truncate text-xs text-slate-500" title={a.released_reason}>{a.released_reason}</p>}</td>
                  <td className="hidden max-w-[220px] truncate px-3 py-2 font-mono text-xs text-slate-500 md:table-cell" title={a.idempotency_key}>{a.idempotency_key}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{timeAgo(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

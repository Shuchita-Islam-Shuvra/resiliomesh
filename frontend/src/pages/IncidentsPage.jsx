import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Droplets, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import ConflictDialog from '../components/ConflictDialog'
import {
  Alert, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Pagination, RiskBadge, Select, SortTh, Spinner, StatusBadge, Tabs, Th,
} from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { AREA_LABEL } from '../lib/areas'
import { errorMessage } from '../lib/errors'
import { CATEGORY_LABEL, fmtNum, humanize, timeAgo } from '../lib/format'
import { supabase } from '../lib/supabase'

const PAGE = 15
const STATUSES = ['reported', 'verified', 'assessed', 'approved', 'in_progress', 'resolved', 'rejected', 'duplicate']

export default function IncidentsPage() {
  const { isStaff } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'incidents'
  return (
    <>
      <PageHeader title={isStaff ? 'Drainage assets & incident reports' : 'My reports'}
        description={isStaff ? 'Search, filter and triage every citizen and field report. Changes appear live for all coordinators.' : 'Track the status of everything you reported.'}
        actions={<Link to="/incidents/new"><Button><Plus className="h-4 w-4" />New report</Button></Link>} />
      {isStaff && <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'incidents', label: 'Incident reports' }, { value: 'assets', label: 'Drainage assets' }]} />}
      {tab === 'assets' && isStaff ? <AssetsTab /> : <IncidentsTab />}
    </>
  )
}

function IncidentsTab() {
  const { area } = useAuth()
  const [view, setView] = useState(null)
  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(0)
  const [wards, setWards] = useState([])
  const [f, setF] = useState({ q: '', status: '', category: '', risk: '', ward: '', area: area || '' })
  const [sort, setSort] = useState({ field: 'risk_score', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [err, setErr] = useState('')

  useEffect(() => { supabase.from('wards').select('id,name,city_corporation').order('name').then(({ data }) => setWards(data || [])) }, [])

  const load = useCallback(async () => {
    let q = supabase.from('incidents')
      .select('id,reference_code,title,category,status,ward_id,risk_level,risk_score,priority,people_affected,water_depth_cm,created_at,wards!inner(name,city_corporation)', { count: 'exact' })
    const term = f.q.trim().replace(/[%,()]/g, '')
    if (term) q = q.or(`title.ilike.%${term}%,reference_code.ilike.%${term}%,description.ilike.%${term}%`)
    if (f.status) q = q.eq('status', f.status)
    if (f.category) q = q.eq('category', f.category)
    if (f.risk) q = q.eq('risk_level', f.risk)
    if (f.ward) q = q.eq('ward_id', f.ward)
    if (f.area) q = q.eq('wards.city_corporation', f.area)
    q = q.order('is_closed', { ascending: true }).order(sort.field, { ascending: sort.dir === 'asc', nullsFirst: false }).order('created_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1)
    const { data, count, error } = await q
    if (error) { setErr(errorMessage(error)); setRows([]); return }
    setErr(''); setRows(data); setTotal(count || 0)
  }, [f, sort, page])

  const debounced = useDebouncedCallback(load, 300)
  useEffect(() => { debounced() }, [f, sort, page])
  useRealtime('incidents', useDebouncedCallback(load, 800))

  const onSort = (field) => setSort((s) => ({ field, dir: s.field === field && s.dir === 'desc' ? 'asc' : 'desc' }))
  const set = (k) => (e) => { setPage(1); setF({ ...f, [k]: e.target.value, ...(k === 'area' && { ward: '' }) }) }

  return (
    <Card bodyClass="p-0">
      <div className={`grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-2 ${area ? 'lg:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))]' : 'lg:grid-cols-[minmax(0,1.3fr)_repeat(5,minmax(0,1fr))]'}`}>
        <div className="relative sm:col-span-2 lg:col-span-1">
          <label htmlFor="inc-search" className="sr-only">Search reports</label>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          <Input id="inc-search" className="pl-8" placeholder="Search title, reference, description…" value={f.q} onChange={set('q')} />
        </div>
        <Select aria-label="Filter by status" value={f.status} onChange={set('status')}><option value="">Status</option>{STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
        <Select aria-label="Filter by category" value={f.category} onChange={set('category')}><option value="">Category</option>{Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Filter by risk" value={f.risk} onChange={set('risk')}><option value="">Any risk</option>{['critical', 'high', 'moderate', 'low'].map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select>
        {!area && <Select aria-label="Filter by area" value={f.area} onChange={set('area')}><option value="">All of Dhaka</option>{Object.entries(AREA_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
        <Select aria-label="Filter by ward" value={f.ward} onChange={set('ward')}><option value="">All wards</option>{wards.filter((w) => !f.area || w.city_corporation === f.area).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
      </div>
      {err && <Alert tone="error" className="m-4">{err}</Alert>}
      {!rows ? <Spinner /> : rows.length === 0 ? <EmptyState icon={Droplets} title="No reports match these filters" /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr>
              <Th>Report</Th><Th className="hidden lg:table-cell">Ward</Th><Th>Status</Th>
              <SortTh label="Risk" field="risk_score" sort={sort} onSort={onSort} />
              <SortTh label="Priority" field="priority" sort={sort} onSort={onSort} className="hidden md:table-cell" />
              <SortTh label="People" field="people_affected" sort={sort} onSort={onSort} className="hidden md:table-cell" />
              <Th><span className="sr-only">Actions</span></Th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="max-w-xs px-3 py-2.5">
                    <p className="font-medium text-slate-900 line-clamp-2">{r.title}</p>
                    <p className="text-xs text-slate-500">{r.reference_code}<span className="lg:hidden"> · {r.wards?.name}</span></p>
                  </td>
                  <td className="hidden px-3 py-2.5 text-slate-700 lg:table-cell">{r.wards?.name}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-2.5"><RiskBadge level={r.risk_level} score={r.risk_score} /></td>
                  <td className="hidden px-3 py-2.5 md:table-cell">{r.priority ?? '—'}</td>
                  <td className="hidden px-3 py-2.5 md:table-cell">{fmtNum(r.people_affected)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button type="button" onClick={() => setView(r)} aria-label={`View report ${r.reference_code}`}
                      className="rounded-full border border-brand-600 px-3.5 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-brand-500">
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
      <Modal open={Boolean(view)} onClose={() => setView(null)} title={view?.title || 'Report'}
        footer={<><Button variant="secondary" onClick={() => setView(null)}>Close</Button>{view && <Link to={`/incidents/${view.id}`}><Button>Open full report</Button></Link>}</>}>
        {view && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-slate-500">{view.reference_code} · {CATEGORY_LABEL[view.category]} · {timeAgo(view.created_at)}</p>
            <div className="flex flex-wrap gap-2"><StatusBadge status={view.status} /><RiskBadge level={view.risk_level} score={view.risk_score} /></div>
            <dl className="grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4">
              <div><dt className="text-xs text-slate-500">Ward</dt><dd className="font-medium">{view.wards?.name} · {AREA_LABEL[view.wards?.city_corporation] || ''}</dd></div>
              <div><dt className="text-xs text-slate-500">People affected</dt><dd className="font-medium">{fmtNum(view.people_affected)}</dd></div>
              <div><dt className="text-xs text-slate-500">Priority</dt><dd className="font-medium">{view.priority ?? '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">Water depth</dt><dd className="font-medium">{view.water_depth_cm != null ? `${view.water_depth_cm} cm` : '—'}</dd></div>
            </dl>
          </div>
        )}
      </Modal>
    </Card>
  )
}

const EMPTY_ASSET = { code: '', name: '', asset_type: 'drain', ward_id: '', lat: '', lng: '', capacity_m3s: '', condition_score: 70, status: 'operational' }

function AssetsTab() {
  const { hasRole, profile, canManageArea } = useAuth()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [wards, setWards] = useState([])
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState({ field: 'condition_score', dir: 'asc' })
  const [edit, setEdit] = useState(null)
  const [errors, setErrors] = useState({})
  const [conflict, setConflict] = useState(null)
  const [busy, setBusy] = useState(false)
  const canEdit = hasRole('city_officer', 'admin')
  const canEditAsset = (a) => hasRole('admin') || (canManageArea(a.wards?.city_corporation) && a.owner_org_id === profile?.organization_id)

  const load = useCallback(async () => {
    let query = supabase.from('drainage_assets').select('*, wards(name, city_corporation)')
    if (q.trim()) query = query.or(`name.ilike.%${q.trim().replace(/[%,()]/g, '')}%,code.ilike.%${q.trim().replace(/[%,()]/g, '')}%`)
    if (status) query = query.eq('status', status)
    const { data } = await query.order(sort.field, { ascending: sort.dir === 'asc' })
    setRows(data || [])
  }, [q, status, sort])
  useEffect(() => { load() }, [load])
  useEffect(() => { supabase.from('wards').select('id,name,city_corporation').order('name').then(({ data }) => setWards(data || [])) }, [])
  useRealtime('drainage_assets', useDebouncedCallback(load, 600))

  const save = async () => {
    const e = {}
    if (!/^[A-Z]{2}-[A-Z]{3}-\d{3}$/.test(edit.code)) e.code = 'Format: XX-XXX-000 (e.g. DR-MRP-003)'
    if (edit.name.trim().length < 3) e.name = 'Name is required'
    if (!edit.ward_id) e.ward_id = 'Choose a ward'
    const cs = Number(edit.condition_score)
    if (!Number.isInteger(cs) || cs < 0 || cs > 100) e.condition_score = '0–100'
    if (!(Number(edit.lat) >= 23.6 && Number(edit.lat) <= 23.95)) e.lat = 'Latitude within Dhaka'
    if (!(Number(edit.lng) >= 90.25 && Number(edit.lng) <= 90.55)) e.lng = 'Longitude within Dhaka'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const payload = {
      code: edit.code, name: edit.name.trim(), asset_type: edit.asset_type, ward_id: edit.ward_id,
      lat: Number(edit.lat), lng: Number(edit.lng), capacity_m3s: edit.capacity_m3s === '' ? null : Number(edit.capacity_m3s),
      condition_score: cs, status: edit.status,
      ...(edit.status === 'operational' && edit._original?.status !== 'operational' ? { last_maintained_at: new Date().toISOString() } : {}),
    }
    try {
      if (edit.id) {
        const { data, error } = await supabase.from('drainage_assets').update(payload).eq('id', edit.id).eq('version', edit.version).select()
        if (error) throw error
        if (!data.length) {
          const { data: latest } = await supabase.from('drainage_assets').select('*').eq('id', edit.id).single()
          setConflict({ mine: { ...edit }, theirs: latest })
          return
        }
        toast.success(`${payload.code} updated`)
      } else {
        const { error } = await supabase.from('drainage_assets').insert({ ...payload, owner_org_id: profile.organization_id })
        if (error) throw error
        toast.success(`${payload.code} created`)
      }
      setEdit(null); load()
    } catch (err) { toast.error(errorMessage(err)) } finally { setBusy(false) }
  }

  const remove = async (a) => {
    if (!window.confirm(`Delete asset ${a.code}? This cannot be undone.`)) return
    const { error } = await supabase.from('drainage_assets').delete().eq('id', a.id)
    if (error) toast.error(errorMessage(error)); else { toast.success('Asset deleted'); load() }
  }

  const s = (k) => (e) => setEdit({ ...edit, [k]: e.target.value })
  return (
    <Card bodyClass="p-0" actions={canEdit && <Button size="sm" onClick={() => { setErrors({}); setEdit({ ...EMPTY_ASSET }) }}><Plus className="h-4 w-4" />Add asset</Button>} title="Drainage infrastructure" subtitle="Condition scores feed the AI risk model">
      <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
        <Input aria-label="Search assets" className="max-w-xs" placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Filter by asset status" className="max-w-[200px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>{['operational', 'degraded', 'blocked', 'under_maintenance'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </Select>
      </div>
      {!rows ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr>
              <SortTh label="Asset" field="code" sort={sort} onSort={(fl) => setSort((x) => ({ field: fl, dir: x.field === fl && x.dir === 'asc' ? 'desc' : 'asc' }))} />
              <Th>Ward</Th><Th>Status</Th>
              <SortTh label="Condition" field="condition_score" sort={sort} onSort={(fl) => setSort((x) => ({ field: fl, dir: x.field === fl && x.dir === 'asc' ? 'desc' : 'asc' }))} />
              <SortTh label="Last maintained" field="last_maintained_at" sort={sort} onSort={(fl) => setSort((x) => ({ field: fl, dir: x.field === fl && x.dir === 'asc' ? 'desc' : 'asc' }))} className="hidden md:table-cell" />
              {canEdit && <Th><span className="sr-only">Actions</span></Th>}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2.5"><p className="font-medium text-slate-900">{a.name}</p><p className="text-xs text-slate-500">{a.code} · {humanize(a.asset_type)}</p></td>
                  <td className="px-3 py-2.5 text-slate-600">{a.wards?.name}</td>
                  <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${a.status === 'blocked' ? 'bg-rose-100 text-rose-700' : a.status === 'degraded' ? 'bg-amber-100 text-amber-800' : a.status === 'operational' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}`}>{humanize(a.status)}</span></td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2"><div className="h-1.5 w-16 rounded bg-slate-100"><div className={`h-1.5 rounded ${a.condition_score < 40 ? 'bg-rose-500' : a.condition_score < 65 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${a.condition_score}%` }} /></div>{a.condition_score}</div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-slate-500 md:table-cell">{timeAgo(a.last_maintained_at)}</td>
                  {canEdit && <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    {canEditAsset(a) && <Button size="sm" variant="ghost" aria-label={`Edit ${a.code}`} onClick={() => { setErrors({}); setEdit({ ...a, _original: a }) }}><Pencil className="h-4 w-4" /></Button>}
                    {hasRole('admin') && <Button size="sm" variant="ghost" aria-label={`Delete ${a.code}`} onClick={() => remove(a)}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.code}` : 'New drainage asset'}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code" error={errors.code} required>{(a) => <Input {...a} value={edit.code} onChange={s('code')} disabled={Boolean(edit.id)} />}</Field>
            <Field label="Type">{(a) => <Select {...a} value={edit.asset_type} onChange={s('asset_type')}>{['canal', 'drain', 'culvert', 'pump_station', 'retention_pond', 'sluice_gate'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>}</Field>
            <Field label="Name" error={errors.name} required className="sm:col-span-2">{(a) => <Input {...a} value={edit.name} onChange={s('name')} />}</Field>
            <Field label="Ward" error={errors.ward_id} required>{(a) => <Select {...a} value={edit.ward_id} onChange={s('ward_id')}><option value="">Select</option>{wards.filter((w) => canManageArea(w.city_corporation)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
            <Field label="Status">{(a) => <Select {...a} value={edit.status} onChange={s('status')}>{['operational', 'degraded', 'blocked', 'under_maintenance'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>}</Field>
            <Field label="Latitude" error={errors.lat} required>{(a) => <Input {...a} inputMode="decimal" value={edit.lat} onChange={s('lat')} />}</Field>
            <Field label="Longitude" error={errors.lng} required>{(a) => <Input {...a} inputMode="decimal" value={edit.lng} onChange={s('lng')} />}</Field>
            <Field label="Condition (0–100)" error={errors.condition_score}>{(a) => <Input {...a} type="number" min={0} max={100} value={edit.condition_score} onChange={s('condition_score')} />}</Field>
            <Field label="Capacity (m³/s)">{(a) => <Input {...a} type="number" step="0.1" value={edit.capacity_m3s ?? ''} onChange={s('capacity_m3s')} />}</Field>
          </div>
        )}
      </Modal>
      <ConflictDialog conflict={conflict} fields={['status', 'condition_score', 'name', 'version']}
        onClose={() => setConflict(null)} onReload={() => { setEdit({ ...conflict.theirs, _original: conflict.theirs }); setConflict(null) }} />
    </Card>
  )
}

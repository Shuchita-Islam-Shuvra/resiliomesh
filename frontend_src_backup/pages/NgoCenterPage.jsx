import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { HandHeart, Plus, Search } from 'lucide-react'
import { Alert, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, StatusBadge, Tabs, Textarea, Th } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { errorMessage } from '../lib/errors'
import { RESOURCE_LABEL, fmtNum, humanize, timeAgo, uuid } from '../lib/format'
import { supabase } from '../lib/supabase'
import { validateNeed } from '../lib/validation'

const NEED_TYPES = ['relief_kit', 'medical_kit', 'water_tank', 'sandbag', 'boat']
const AREA_LABEL = { DNCC: 'Dhaka North', DSCC: 'Dhaka South' }

export default function NgoCenterPage() {
  const { profile, hasRole } = useAuth()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const [needs, setNeeds] = useState(null)
  const [wards, setWards] = useState([])
  const [stock, setStock] = useState([])
  const [tab, setTab] = useState('open')
  const [q, setQ] = useState('')
  const [ward, setWard] = useState('')
  const [form, setForm] = useState(null)
  const [errors, setErrors] = useState({})
  const [alloc, setAlloc] = useState(null)
  const [busy, setBusy] = useState(false)

  const isAdmin = hasRole('admin')
  const [allocs, setAllocs] = useState([])
  const [confirm, setConfirm] = useState(null)
  const [areas, setAreas] = useState({})
  const [scope, setScope] = useState('mine')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    let aq = supabase.from('allocations')
      .select('id,quantity,status,created_at,need_id,resources!inner(name,organization_id),community_needs(need_type,wards(name))')
      .not('need_id', 'is', null).order('created_at', { ascending: false }).limit(200)
    if (!isAdmin) aq = aq.eq('resources.organization_id', profile.organization_id)
    const [n, r, a, s] = await Promise.all([
      supabase.from('community_needs').select('*, wards(name,city_corporation), incidents(reference_code,status), organizations(name)').order('created_at', { ascending: false }).limit(300),
      supabase.from('resources').select('id,name,resource_type,quantity_available,organization_id,version,organizations(name)').order('name'),
      aq,
      supabase.rpc('ngo_area_status'),
    ])
    setNeeds(n.data || []); setStock(r.data || []); setAllocs(a.data || [])
    setAreas(Object.fromEntries((s.data || []).map((x) => [x.area, x])))
  }, [isAdmin, profile.organization_id])
  useEffect(() => { load(); supabase.from('wards').select('id,name,city_corporation').order('name').then(({ data }) => setWards(data || [])) }, [load])
  useRealtime(['community_needs', 'resources', 'allocations', 'ngo_area_backup'], useDebouncedCallback(load, 500))

  useEffect(() => {
    const incident = params.get('incident')
    if (!incident) return
    setErrors({})
    setForm({ ward_id: params.get('ward') || '', incident_id: incident, need_type: 'relief_kit', quantity: '', households: '', contact_name: '', contact_phone: '', notes: '' })
    setParams({}, { replace: true })
  }, [params, setParams])

  const myArea = useMemo(() => wards.find((w) => w.id === profile.ward_id)?.city_corporation || null, [wards, profile.ward_id])
  const otherArea = myArea === 'DNCC' ? 'DSCC' : myArea === 'DSCC' ? 'DNCC' : null
  const access = useCallback((n) => {
    if (isAdmin) return 'admin'
    if (!hasRole('ngo_coordinator')) return null
    const area = n.wards?.city_corporation
    if (myArea && area === myArea) return 'home'
    if (n.backup_requested_at || areas[area]?.area_backup) return 'backup'
    if (areas[area] && areas[area].coordinators === 0) return 'uncovered'
    return null
  }, [isAdmin, hasRole, myArea, areas])
  const owns = (n) => ['home', 'uncovered', 'admin'].includes(access(n))

  const groups = useMemo(() => {
    const g = { open: [], fulfilled: [], duplicate: [] }
    for (const n of needs || []) {
      if (ward && n.ward_id !== ward) continue
      if (scope === 'mine' && myArea && n.wards?.city_corporation !== myArea) continue
      if (scope === 'help' && !(access(n) === 'backup' || (access(n) === 'uncovered' && n.wards?.city_corporation !== myArea))) continue
      if (q && !`${n.notes || ''} ${n.contact_name || ''} ${n.wards?.name} ${n.need_type}`.toLowerCase().includes(q.toLowerCase())) continue
      if (['open', 'partially_fulfilled'].includes(n.status)) g.open.push(n)
      else if (n.status === 'duplicate') g.duplicate.push(n)
      else g.fulfilled.push(n)
    }
    g.open.sort((a, b) => b.households - a.households)
    return g
  }, [needs, q, ward, scope, myArea, access])
  const helpCount = useMemo(() => (needs || []).filter((n) => ['open', 'partially_fulfilled'].includes(n.status)
    && n.wards?.city_corporation !== myArea && access(n) === 'backup').length, [needs, myArea, access])
  const stats = useMemo(() => {
    const open = (needs || []).filter((n) => ['open', 'partially_fulfilled'].includes(n.status))
    return {
      open: open.length,
      households: open.reduce((s, n) => s + n.households, 0),
      gap: open.reduce((s, n) => s + (n.quantity - n.fulfilled_qty), 0),
      dups: (needs || []).filter((n) => n.status === 'duplicate').length,
    }
  }, [needs])

  const submitNeed = async () => {
    const e = validateNeed(form)
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      const { data, error } = await supabase.from('community_needs').insert({
        ward_id: form.ward_id, need_type: form.need_type, quantity: Number(form.quantity), households: Number(form.households),
        contact_name: form.contact_name || null, contact_phone: form.contact_phone ? form.contact_phone.replace(/[\s-]/g, '') : null,
        notes: form.notes || null, dedup_key: 'computed-by-trigger', incident_id: form.incident_id || null,
      }).select('status').single()
      if (error) throw error
      if (data.status === 'duplicate') toast.warning('An identical open request already exists for this contact/ward. Saved and linked as duplicate — no double aid will be sent.', 'Duplicate detected')
      else toast.success('Need registered')
      setForm(null); load()
    } catch (err) { toast.error(errorMessage(err)) } finally { setBusy(false) }
  }

  const allocate = async () => {
    const qty = Number(alloc.qty)
    const remaining = alloc.need.quantity - alloc.need.fulfilled_qty
    if (!Number.isInteger(qty) || qty < 1 || qty > remaining) { toast.error(`Quantity must be 1–${remaining}`); return }
    if (!alloc.resource_id) { toast.error('Choose a stock source'); return }
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('allocate_to_need', {
        p_need_id: alloc.need.id, p_resource_id: alloc.resource_id, p_qty: qty, p_idempotency_key: alloc.key,
      })
      if (error) throw error
      toast.success(data.replayed ? 'Already allocated (duplicate request ignored).' : `${qty} unit(s) reserved for ${alloc.need.wards?.name}`)
      setAlloc(null); load()
    } catch (err) { toast.error(errorMessage(err), 'Allocation failed') } finally { setBusy(false) }
  }

  const updateAlloc = async () => {
    const { action, item } = confirm
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('ngo_update_allocation', { p_allocation_id: item.id, p_action: action, p_reason: null })
      if (error) throw error
      toast.success(data.replayed ? 'Already up to date.' : action === 'cancel' ? 'Allocation cancelled, stock returned.' : action === 'deliver' ? 'Marked as delivered.' : 'Marked as dispatched.')
      setConfirm(null); load()
    } catch (err) { toast.error(errorMessage(err), 'Update failed') } finally { setBusy(false) }
  }
  const cancelNeed = async () => {
    setBusy(true)
    try {
      const { error } = await supabase.rpc('cancel_need', { p_need_id: confirm.item.id, p_reason: null })
      if (error) throw error
      toast.success('Need cancelled.')
      setConfirm(null); load()
    } catch (err) { toast.error(errorMessage(err), 'Could not cancel') } finally { setBusy(false) }
  }

  const setBackup = async () => {
    const { kind, item, on } = confirm
    setBusy(true)
    try {
      const { error } = kind === 'areaBackup'
        ? await supabase.rpc('set_ngo_area_backup', { p_on: on, p_note: note || null, p_area: null })
        : await supabase.rpc('request_ngo_backup', { p_need_id: item.id, p_on: on, p_note: note || null })
      if (error) throw error
      toast.success(on ? `Backup requested. ${AREA_LABEL[otherArea] || 'The other area'} coordinators can now help.` : 'Backup request withdrawn.')
      setConfirm(null); setNote(''); load()
    } catch (err) { toast.error(errorMessage(err), 'Could not update backup') } finally { setBusy(false) }
  }

  const sources = alloc ? stock.filter((s) => s.resource_type === alloc.need.need_type && (hasRole('admin') || s.organization_id === profile.organization_id)) : []
  const list = groups[tab]
  return (
    <>
      <PageHeader title="NGO coordination center" description="Register community needs, detect duplicate aid requests, and allocate relief from your organisation's stock with race-safe reservations."
        actions={<Button onClick={() => { setErrors({}); setForm({ ward_id: '', need_type: 'relief_kit', quantity: '', households: '', contact_name: '', contact_phone: '', notes: '' }) }}><Plus className="h-4 w-4" />Register need</Button>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open needs" value={stats.open} icon={HandHeart} />
        <StatCard label="Households waiting" value={fmtNum(stats.households)} tone="amber" />
        <StatCard label="Unmet units" value={fmtNum(stats.gap)} tone="red" />
        <StatCard label="Duplicates blocked" value={stats.dups} tone="violet" hint="Prevented double distribution" />
      </div>

      {hasRole('ngo_coordinator') && (
        <Card className="mt-5" title="Area responsibility"
          subtitle={myArea ? `You are responsible for ${AREA_LABEL[myArea]}. ${AREA_LABEL[otherArea]} coordinators can step in when you ask for backup, and you can help them when they ask.` : undefined}
          actions={myArea && (areas[myArea]?.area_backup
            ? <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'areaBackup', on: false })}>Withdraw area backup</Button>
            : <Button size="sm" variant="secondary" onClick={() => { setNote(''); setConfirm({ kind: 'areaBackup', on: true }) }}>Ask {AREA_LABEL[otherArea]} for backup</Button>)}>
          {!myArea ? (
            <Alert tone="warning">You have no home area yet (your main operating ward is not set). You can only help where backup is requested. Ask an admin to set your area.</Alert>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {['DNCC', 'DSCC'].map((k) => {
                const s = areas[k]
                return (
                  <div key={k} className={`rounded-lg border p-3 text-sm ${k === myArea ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200'}`}>
                    <p className="font-medium">{AREA_LABEL[k]}{k === myArea && <span className="ml-1.5 text-xs text-brand-700">(your area)</span>}</p>
                    <p className="text-slate-600">{s ? `${s.coordinators} coordinator${s.coordinators === 1 ? '' : 's'} · ${s.open_needs} open need${s.open_needs === 1 ? '' : 's'}` : '…'}</p>
                    {s?.area_backup && <p className="mt-1 text-amber-700">Whole area asked for backup{s.area_backup_note ? `: “${s.area_backup_note}”` : ''}</p>}
                    {!s?.area_backup && s?.backup_needs > 0 && <p className="mt-1 text-amber-700">{s.backup_needs} need{s.backup_needs === 1 ? '' : 's'} asking for backup</p>}
                    {s && s.coordinators === 0 && <p className="mt-1 text-rose-700">No coordinator here: anyone may help</p>}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      )}

      <Card className="mt-5" bodyClass="p-0">
        <div className="px-4 pt-3"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'open', label: 'Open', count: groups.open.length }, { value: 'fulfilled', label: 'Fulfilled / closed', count: groups.fulfilled.length }, { value: 'duplicate', label: 'Duplicates', count: groups.duplicate.length }, { value: 'allocations', label: 'My allocations', count: allocs.filter((a) => ['reserved', 'dispatched'].includes(a.status)).length }]} /></div>
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden /><Input aria-label="Search needs" className="pl-8" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {myArea && tab !== 'allocations' && (
            <Select aria-label="Which area" className="max-w-[240px]" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="mine">My area ({AREA_LABEL[myArea]})</option>
              <option value="help">{`Backup requests from ${AREA_LABEL[otherArea]}${helpCount ? ` (${helpCount})` : ''}`}</option>
              <option value="all">All Dhaka</option>
            </Select>
          )}
          <Select aria-label="Filter by ward" className="max-w-[220px]" value={ward} onChange={(e) => setWard(e.target.value)}><option value="">All wards</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
        </div>
        {!needs ? <Spinner /> : tab === 'allocations' ? (
          allocs.length === 0 ? <EmptyState icon={HandHeart} title="No allocations yet">Allocate stock to an open need and it will be tracked here.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50"><tr><Th>Allocation</Th><Th>Ward</Th><Th>Status</Th><Th>When</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {allocs.map((a) => {
                    const active = ['reserved', 'dispatched'].includes(a.status)
                    return (
                      <tr key={a.id}>
                        <td className="px-3 py-2.5"><p className="font-medium">{a.quantity} × {a.resources?.name}</p></td>
                        <td className="px-3 py-2.5">{a.community_needs?.wards?.name || '—'}</td>
                        <td className="px-3 py-2.5"><StatusBadge status={a.status} /></td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{timeAgo(a.created_at)}</td>
                        <td className="px-3 py-2.5 text-right">{active && (
                          <span className="inline-flex gap-1.5">
                            {a.status === 'reserved' && <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'alloc', action: 'dispatch', item: a })}>Dispatch</Button>}
                            <Button size="sm" onClick={() => setConfirm({ kind: 'alloc', action: 'deliver', item: a })}>Delivered</Button>
                            <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'alloc', action: 'cancel', item: a })}>Cancel</Button>
                          </span>)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : list.length === 0 ? <EmptyState icon={HandHeart} title="Nothing here" /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50"><tr><Th>Need</Th><Th>Ward</Th><Th>Households</Th><Th>Progress</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((n) => (
                  <tr key={n.id}>
                    <td className="px-3 py-2.5"><p className="font-medium">{n.quantity} × {RESOURCE_LABEL[n.need_type]}</p><p className="max-w-xs truncate text-xs text-slate-500">{n.contact_name || 'Anonymous'}{n.incidents ? ` · ${n.incidents.reference_code}` : ''} · {timeAgo(n.created_at)}</p></td>
                    <td className="px-3 py-2.5">
                      <p>{n.wards?.name}</p>
                      <p className="text-xs text-slate-500">{AREA_LABEL[n.wards?.city_corporation] || ''}</p>
                      {n.backup_requested_at && ['open', 'partially_fulfilled'].includes(n.status) &&
                        <span className="mt-0.5 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-300" title={n.backup_note || undefined}>Backup requested</span>}
                    </td>
                    <td className="px-3 py-2.5">{fmtNum(n.households)}</td>
                    <td className="px-3 py-2.5"><div className="h-1.5 w-24 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-600" style={{ width: `${(n.fulfilled_qty / n.quantity) * 100}%` }} /></div><span className="text-xs text-slate-500">{n.fulfilled_qty}/{n.quantity}</span></td>
                    <td className="px-3 py-2.5"><StatusBadge status={n.status} /></td>
                    <td className="px-3 py-2.5 text-right">{['open', 'partially_fulfilled'].includes(n.status) && (access(n) ? (
                      <span className="inline-flex flex-wrap justify-end gap-1.5">
                        <Button size="sm" disabled={n.incidents?.status === 'reported'} title={n.incidents?.status === 'reported' ? 'Waiting for an officer to verify the linked report' : undefined}
                          onClick={() => setAlloc({ need: n, qty: n.quantity - n.fulfilled_qty, resource_id: '', key: uuid() })}>{n.incidents?.status === 'reported' ? 'Awaiting verification' : access(n) === 'backup' ? 'Help (allocate)' : 'Allocate'}</Button>
                        {owns(n) && (n.backup_requested_at
                          ? <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'backup', on: false, item: n })}>Withdraw backup</Button>
                          : <Button size="sm" variant="secondary" onClick={() => { setNote(''); setConfirm({ kind: 'backup', on: true, item: n }) }}>Ask backup</Button>)}
                        {owns(n) && <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'need', item: n })}>Cancel</Button>}
                      </span>
                    ) : hasRole('ngo_coordinator') && <span className="text-xs text-slate-400">{AREA_LABEL[n.wards?.city_corporation]} team</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={Boolean(form)} onClose={() => setForm(null)} title="Register community need"
        footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy} onClick={submitNeed}>Save</Button></>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            {form.incident_id && <Alert tone="info" className="sm:col-span-2">Linked to <Link className="font-medium underline" to={`/incidents/${form.incident_id}`}>this report</Link>. The officer handles the water; this need is for the people affected.</Alert>}
            <Field label="Ward" error={errors.ward_id} required>{(a) => <Select {...a} value={form.ward_id} onChange={(e) => setForm({ ...form, ward_id: e.target.value })}><option value="">Select</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
            <Field label="Need" error={errors.need_type} required>{(a) => <Select {...a} value={form.need_type} onChange={(e) => setForm({ ...form, need_type: e.target.value })}>{NEED_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_LABEL[t]}</option>)}</Select>}</Field>
            <Field label="Quantity" error={errors.quantity} required>{(a) => <Input {...a} type="number" min={1} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />}</Field>
            <Field label="Households" error={errors.households} required>{(a) => <Input {...a} type="number" min={1} value={form.households} onChange={(e) => setForm({ ...form, households: e.target.value })} />}</Field>
            <Field label="Contact name">{(a) => <Input {...a} value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />}</Field>
            <Field label="Contact phone" error={errors.contact_phone} hint="Used for duplicate detection">{(a) => <Input {...a} type="tel" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />}</Field>
            <Field label="Notes" className="sm:col-span-2">{(a) => <Textarea {...a} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(confirm) && ['backup', 'areaBackup'].includes(confirm?.kind)} onClose={() => setConfirm(null)}
        title={confirm?.on ? (confirm?.kind === 'areaBackup' ? `Ask ${AREA_LABEL[otherArea]} to back up your whole area?` : 'Ask the other area for backup?') : 'Withdraw backup request?'}
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Back</Button><Button loading={busy} onClick={setBackup}>Confirm</Button></>}>
        {confirm && confirm.on ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              {confirm.kind === 'areaBackup'
                ? `Every open need in ${AREA_LABEL[myArea]} becomes available to ${AREA_LABEL[otherArea]} coordinators until you withdraw this.`
                : `${AREA_LABEL[otherArea] || 'Other area'} coordinators will be able to allocate from their own stock to this need. You stay responsible for it.`}
            </p>
            <Field label="Note for the other team (optional)">{(a) => <Textarea {...a} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
        ) : confirm && <p className="text-sm text-slate-600">Only coordinators of this area will be able to act again.</p>}
      </Modal>

      <Modal open={Boolean(confirm) && ['need', 'alloc'].includes(confirm?.kind)} onClose={() => setConfirm(null)}
        title={confirm?.kind === 'need' ? 'Cancel this need?' : confirm?.action === 'deliver' ? 'Confirm delivery' : confirm?.action === 'dispatch' ? 'Mark as dispatched' : 'Cancel allocation?'}
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Back</Button><Button loading={busy} onClick={confirm?.kind === 'need' ? cancelNeed : updateAlloc}>Confirm</Button></>}>
        {confirm && ['need', 'alloc'].includes(confirm.kind) && (
          <p className="text-sm text-slate-600">
            {confirm.kind === 'need'
              ? `Close the request for ${confirm.item.quantity} × ${RESOURCE_LABEL[confirm.item.need_type]} in ${confirm.item.wards?.name}. Active allocations must be delivered or cancelled first.`
              : confirm.action === 'deliver' ? `${confirm.item.quantity} × ${confirm.item.resources?.name} reached ${confirm.item.community_needs?.wards?.name || 'the community'}. The stock stays deducted.`
              : confirm.action === 'dispatch' ? `${confirm.item.quantity} × ${confirm.item.resources?.name} is on its way.`
              : `The ${confirm.item.quantity} reserved unit(s) go back to your stock and the need becomes open again.`}
          </p>
        )}
      </Modal>

      <Modal open={Boolean(alloc)} onClose={() => setAlloc(null)} title="Allocate relief"
        footer={<><Button variant="secondary" onClick={() => setAlloc(null)}>Cancel</Button><Button loading={busy} onClick={allocate}>Reserve stock</Button></>}>
        {alloc && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">{alloc.need.wards?.name} · {alloc.need.households} households · still needed <strong>{alloc.need.quantity - alloc.need.fulfilled_qty}</strong> {RESOURCE_LABEL[alloc.need.need_type]}</p>
            {sources.length === 0 ? <Alert tone="warning">Your organisation has no {RESOURCE_LABEL[alloc.need.need_type]} stock.</Alert> : (
              <Field label="Stock source" required>{(a) => <Select {...a} value={alloc.resource_id} onChange={(e) => setAlloc({ ...alloc, resource_id: e.target.value })}><option value="">Select</option>{sources.map((s) => <option key={s.id} value={s.id} disabled={s.quantity_available === 0}>{s.name} — {s.quantity_available} available</option>)}</Select>}</Field>
            )}
            <Field label="Quantity" required>{(a) => <Input {...a} type="number" min={1} value={alloc.qty} onChange={(e) => setAlloc({ ...alloc, qty: e.target.value })} />}</Field>
            <p className="text-xs text-slate-500">Reservation is atomic: if another coordinator takes the last units first, you will get a clear "insufficient stock" message and nothing is double-allocated. Request key {alloc.key.slice(0, 8)}… makes retries safe.</p>
          </div>
        )}
      </Modal>
    </>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
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

export default function NgoCenterPage() {
  const { profile, hasRole } = useAuth()
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

  const load = useCallback(async () => {
    const [n, r] = await Promise.all([
      supabase.from('community_needs').select('*, wards(name), incidents(reference_code), organizations(name)').order('created_at', { ascending: false }).limit(300),
      supabase.from('resources').select('id,name,resource_type,quantity_available,organization_id,version,organizations(name)').order('name'),
    ])
    setNeeds(n.data || []); setStock(r.data || [])
  }, [])
  useEffect(() => { load(); supabase.from('wards').select('id,name').order('name').then(({ data }) => setWards(data || [])) }, [load])
  useRealtime(['community_needs', 'resources'], useDebouncedCallback(load, 500))

  const groups = useMemo(() => {
    const g = { open: [], fulfilled: [], duplicate: [] }
    for (const n of needs || []) {
      if (ward && n.ward_id !== ward) continue
      if (q && !`${n.notes || ''} ${n.contact_name || ''} ${n.wards?.name} ${n.need_type}`.toLowerCase().includes(q.toLowerCase())) continue
      if (['open', 'partially_fulfilled'].includes(n.status)) g.open.push(n)
      else if (n.status === 'duplicate') g.duplicate.push(n)
      else g.fulfilled.push(n)
    }
    g.open.sort((a, b) => b.households - a.households)
    return g
  }, [needs, q, ward])
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
        notes: form.notes || null, dedup_key: 'computed-by-trigger',
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
      <Card className="mt-5" bodyClass="p-0">
        <div className="px-4 pt-3"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'open', label: 'Open', count: groups.open.length }, { value: 'fulfilled', label: 'Fulfilled / closed', count: groups.fulfilled.length }, { value: 'duplicate', label: 'Duplicates', count: groups.duplicate.length }]} /></div>
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden /><Input aria-label="Search needs" className="pl-8" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select aria-label="Filter by ward" className="max-w-[220px]" value={ward} onChange={(e) => setWard(e.target.value)}><option value="">All wards</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
        </div>
        {!needs ? <Spinner /> : list.length === 0 ? <EmptyState icon={HandHeart} title="Nothing here" /> : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50"><tr><Th>Need</Th><Th>Ward</Th><Th>Households</Th><Th>Progress</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {list.map((n) => (
                  <tr key={n.id}>
                    <td className="px-3 py-2.5"><p className="font-medium">{n.quantity} × {RESOURCE_LABEL[n.need_type]}</p><p className="max-w-xs truncate text-xs text-slate-500">{n.contact_name || 'Anonymous'}{n.incidents ? ` · ${n.incidents.reference_code}` : ''} · {timeAgo(n.created_at)}</p></td>
                    <td className="px-3 py-2.5">{n.wards?.name}</td>
                    <td className="px-3 py-2.5">{fmtNum(n.households)}</td>
                    <td className="px-3 py-2.5"><div className="h-1.5 w-24 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-600" style={{ width: `${(n.fulfilled_qty / n.quantity) * 100}%` }} /></div><span className="text-xs text-slate-500">{n.fulfilled_qty}/{n.quantity}</span></td>
                    <td className="px-3 py-2.5"><StatusBadge status={n.status} /></td>
                    <td className="px-3 py-2.5 text-right">{['open', 'partially_fulfilled'].includes(n.status) && hasRole('ngo_coordinator', 'admin') &&
                      <Button size="sm" onClick={() => setAlloc({ need: n, qty: n.quantity - n.fulfilled_qty, resource_id: '', key: uuid() })}>Allocate</Button>}</td>
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

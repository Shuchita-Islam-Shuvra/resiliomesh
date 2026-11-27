import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Field, Input, Modal, Select, Textarea } from './ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { errorMessage } from '../lib/errors'
import { RESOURCE_LABEL } from '../lib/format'
import { supabase } from '../lib/supabase'
import { validateNeed } from '../lib/validation'

const NEED_TYPES = ['relief_kit', 'medical_kit', 'water_tank', 'sandbag', 'boat']
const EMPTY = { incident_id: '', ward_id: '', need_type: 'relief_kit', quantity: '', households: '', contact_name: '', contact_phone: '', notes: '' }

// "People here need help": a field worker logs a relief need from the ground. NGO coordinators of
// the area are notified and must confirm it before any stock is sent (migration 024).
export default function FieldNeedModal({ open, onClose, tasks = [], online = true }) {
  const { area } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [wards, setWards] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(EMPTY); setErrors({})
    supabase.from('wards').select('id,name,city_corporation').order('name').then(({ data }) => setWards(data || []))
  }, [open])

  const myWards = useMemo(() => (area ? wards.filter((w) => w.city_corporation === area) : wards), [wards, area])
  const reports = useMemo(() => {
    const seen = new Map()
    for (const t of tasks) {
      if (t.incident_id && t.incidents && !seen.has(t.incident_id)) seen.set(t.incident_id, { id: t.incident_id, ...t.incidents })
    }
    return [...seen.values()]
  }, [tasks])

  const pickReport = (id) => {
    const r = reports.find((x) => x.id === id)
    setForm((f) => ({ ...f, incident_id: id, ward_id: r?.ward_id || f.ward_id }))
  }

  const submit = async () => {
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
      if (data.status === 'duplicate') toast.warning('Someone already asked for this here. Your entry is linked to it, so no double aid goes out.', 'Already reported')
      else toast.success('Sent to the NGO coordinators of this area. They will confirm it and send relief.', 'Need reported')
      onClose()
    } catch (err) { toast.error(errorMessage(err)) } finally { setBusy(false) }
  }

  const set = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })
  return (
    <Modal open={open} onClose={onClose} title="People here need help"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!online} onClick={submit}>Send to NGO coordinators</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!online && <Alert tone="warning" className="sm:col-span-2">You are offline. Reporting a need needs a connection.</Alert>}
        <p className="text-sm text-slate-600 sm:col-span-2">What do the people around you need? The NGO coordinators of this area get it straight away, check it and send relief.</p>
        {reports.length > 0 && (
          <Field label="At which of your reports? (optional)" className="sm:col-span-2">
            {(a) => <Select {...a} value={form.incident_id} onChange={(e) => pickReport(e.target.value)}>
              <option value="">Not linked to a report</option>
              {reports.map((r) => <option key={r.id} value={r.id}>{r.reference_code} · {r.wards?.name || ''}</option>)}
            </Select>}
          </Field>
        )}
        <Field label="Ward" error={errors.ward_id} required>{(a) => <Select {...a} value={form.ward_id} onChange={set('ward_id')}><option value="">Select</option>{myWards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
        <Field label="What is needed" error={errors.need_type} required>{(a) => <Select {...a} value={form.need_type} onChange={set('need_type')}>{NEED_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_LABEL[t]}</option>)}</Select>}</Field>
        <Field label="How many" error={errors.quantity} required>{(a) => <Input {...a} type="number" min={1} inputMode="numeric" value={form.quantity} onChange={set('quantity')} />}</Field>
        <Field label="Households" error={errors.households} required>{(a) => <Input {...a} type="number" min={1} inputMode="numeric" value={form.households} onChange={set('households')} />}</Field>
        <Field label="Local contact name">{(a) => <Input {...a} value={form.contact_name} onChange={set('contact_name')} />}</Field>
        <Field label="Local contact phone" error={errors.contact_phone} hint="Stops the same family being served twice">{(a) => <Input {...a} type="tel" value={form.contact_phone} onChange={set('contact_phone')} />}</Field>
        <Field label="What did you see?" className="sm:col-span-2">{(a) => <Textarea {...a} rows={2} value={form.notes} onChange={set('notes')} placeholder="e.g. 12 families on the school roof, no drinking water" />}</Field>
      </div>
    </Modal>
  )
}

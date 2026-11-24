import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Crosshair, Phone, Send, WifiOff } from 'lucide-react'
import MapView from '../components/MapView'
import { PhoneVerify } from '../components/VerifyPanels'
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useOnline } from '../hooks/useOnline'
import { enqueue } from '../offline/db'
import { errorMessage } from '../lib/errors'
import { CATEGORY_LABEL, uuid } from '../lib/format'
import { supabase } from '../lib/supabase'
import { validateReport } from '../lib/validation'

const INIT = { title: '', description: '', category: 'waterlogging', ward_id: '', asset_id: '', severity_reported: 3, water_depth_cm: '', people_affected: 0, lat: '', lng: '' }

export default function ReportIncidentPage() {
  const { profile, security } = useAuth()
  const toast = useToast()
  const online = useOnline()
  const nav = useNavigate()
  const [v, setV] = useState({ ...INIT, ward_id: profile.ward_id || '' })
  const [wards, setWards] = useState([])
  const [assets, setAssets] = useState([])
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [nearby, setNearby] = useState([])
  const [clientId] = useState(uuid)          // stable per form -> double-submit safe

  useEffect(() => { supabase.from('wards').select('id,name,lat,lng').order('name').then(({ data }) => setWards(data || [])) }, [])
  useEffect(() => {
    if (!v.ward_id) return
    supabase.from('drainage_assets').select('id,code,name').eq('ward_id', v.ward_id).then(({ data }) => setAssets(data || []))
  }, [v.ward_id])
  // warn about likely duplicates before submitting (server also auto-flags them)
  useEffect(() => {
    if (!v.lat || !v.lng || !online || profile.role === 'citizen') { setNearby([]); return }
    supabase.rpc('nearby_incidents', { p_lat: Number(v.lat), p_lng: Number(v.lng), p_radius_m: 200 })
      .then(({ data }) => setNearby((data || []).filter((n) => !['resolved', 'rejected'].includes(n.status))))
  }, [v.lat, v.lng, online, profile.role])

  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const pick = ({ lat, lng }) => {
    let ward = v.ward_id
    if (wards.length) {   // auto-select the nearest ward centroid
      ward = wards.reduce((best, w) => ((w.lat - lat) ** 2 + (w.lng - lng) ** 2 < (best.lat - lat) ** 2 + (best.lng - lng) ** 2 ? w : best)).id
    }
    setV((x) => ({ ...x, lat, lng, ward_id: ward }))
  }
  const gps = () => {
    if (!navigator.geolocation) return toast.error('GPS is not available on this device')
    navigator.geolocation.getCurrentPosition(
      (p) => pick({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }),
      () => toast.error('Could not read GPS location. Tap the map instead.'),
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  const submit = async (e) => {
    e.preventDefault()
    const errs = validateReport(v)
    setErrors(errs)
    if (Object.keys(errs).length) { toast.error('Please fix the highlighted fields'); return }
    const payload = {
      client_id: clientId, reporter_id: profile.id, ward_id: v.ward_id, asset_id: v.asset_id || null,
      category: v.category, title: v.title.trim(), description: v.description.trim(),
      severity_reported: Number(v.severity_reported), water_depth_cm: v.water_depth_cm === '' ? null : Number(v.water_depth_cm),
      people_affected: Number(v.people_affected || 0), lat: Number(v.lat), lng: Number(v.lng),
    }
    setBusy(true)
    try {
      if (!online) {
        await enqueue({ op_id: clientId, type: 'incident_report', payload })
        toast.info('Saved on this device. It will be sent automatically when you are back online.', 'Offline')
        nav('/dashboard')
        return
      }
      const { data, error } = await supabase.from('incidents')
        .upsert(payload, { onConflict: 'client_id', ignoreDuplicates: true }).select('id,reference_code,status,duplicate_of')
      if (error) throw error
      const row = data?.[0]
      if (!row) { toast.info('This report was already submitted.'); nav('/incidents'); return }
      if (row.status === 'duplicate') toast.warning(`A report at this spot already exists. Yours (${row.reference_code}) was linked to it and people-affected was merged.`, 'Duplicate detected')
      else toast.success(`Report ${row.reference_code} submitted. Officers have been notified.`)
      nav(`/incidents/${row.id}`)
    } catch (err) {
      if (/Failed to fetch/i.test(err.message)) {
        await enqueue({ op_id: clientId, type: 'incident_report', payload })
        toast.warning('Connection lost — report queued and will sync automatically.')
        nav('/dashboard')
      } else toast.error(errorMessage(err))
    } finally { setBusy(false) }
  }

  // the database refuses citizen reports without an SMS-verified Bangladeshi number when this is switched on
  const needsPhone = profile.role === 'citizen' && security?.require_phone_verification && !security?.phone_verified
  if (needsPhone) {
    return (
      <>
        <PageHeader title="Report waterlogging / drainage problem" description="Accurate location and water depth help the AI prioritise the response." />
        <Card title="Verify your mobile number first" icon={Phone} className="max-w-xl"
          subtitle="Reports are accepted from SMS-verified Bangladeshi numbers only. This keeps fake and foreign reports out.">
          <PhoneVerify initialPhone={profile.phone || ''} onDone={() => toast.success('Number verified — you can report now')} />
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Report waterlogging / drainage problem" description="Accurate location and water depth help the AI prioritise the response." />
      {!online && <Alert tone="warning" className="mb-4" title="You are offline"><WifiOff className="mr-1 inline h-4 w-4" aria-hidden />Your report will be stored on this device and synced automatically.</Alert>}
      <form onSubmit={submit} noValidate className="grid gap-5 xl:grid-cols-2">
        <Card title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" error={errors.category} required>{(a) => <Select {...a} value={v.category} onChange={set('category')}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Severity (1 = minor, 5 = severe)" error={errors.severity_reported} required>{(a) => <Select {...a} value={v.severity_reported} onChange={set('severity_reported')}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
            <Field label="Title" error={errors.title} required className="sm:col-span-2">{(a) => <Input {...a} value={v.title} onChange={set('title')} placeholder="e.g. Knee-deep water at Shantinagar crossing" maxLength={120} />}</Field>
            <Field label="Description" error={errors.description} required className="sm:col-span-2">{(a) => <Textarea {...a} rows={4} value={v.description} onChange={set('description')} placeholder="What do you see? Is traffic blocked? Is water entering homes or shops?" />}</Field>
            <Field label="Water depth (cm)" error={errors.water_depth_cm} hint="Ankle ≈ 10, knee ≈ 45, waist ≈ 90">{(a) => <Input {...a} type="number" min={0} max={300} value={v.water_depth_cm} onChange={set('water_depth_cm')} />}</Field>
            <Field label="People affected (approx.)" error={errors.people_affected}>{(a) => <Input {...a} type="number" min={0} value={v.people_affected} onChange={set('people_affected')} />}</Field>
            <Field label="Ward / area" error={errors.ward_id} required>{(a) => <Select {...a} value={v.ward_id} onChange={set('ward_id')}><option value="">Select</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
            <Field label="Nearby drain / canal (optional)">{(a) => <Select {...a} value={v.asset_id} onChange={set('asset_id')}><option value="">Not sure</option>{assets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          </div>
        </Card>
        <Card title="Location" actions={<Button type="button" size="sm" variant="secondary" onClick={gps}><Crosshair className="h-4 w-4" />Use GPS</Button>}>
          <p className="mb-2 text-sm text-slate-500">Tap the map to place the report.</p>
          <MapView height="h-80" pick={v.lat ? { lat: v.lat, lng: v.lng } : null} onPick={pick} showWardRadius={false} />
          <p className="mt-2 text-xs text-slate-500">{v.lat ? `Selected: ${v.lat}, ${v.lng}` : 'No location selected yet'}</p>
          {errors.location && <p role="alert" className="mt-1 text-xs font-medium text-rose-600">{errors.location}</p>}
          {nearby.length > 0 && (
            <Alert tone="warning" className="mt-3" title="Possible duplicate">
              {nearby.length} active report(s) within 200 m: {nearby.slice(0, 3).map((n) => `${n.reference_code} (${Math.round(n.distance_m)} m)`).join(', ')}. Submitting will link your report to the existing one.
            </Alert>
          )}
          <Button type="submit" size="lg" className="mt-4 w-full" loading={busy}><Send className="h-4 w-4" />{online ? 'Submit report' : 'Save offline'}</Button>
        </Card>
      </form>
    </>
  )
}

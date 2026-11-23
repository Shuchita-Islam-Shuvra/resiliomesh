import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BrainCircuit, CheckCircle2, Copy, Eye, RefreshCw, ShieldX, Users } from 'lucide-react'
import ConflictDialog from '../components/ConflictDialog'
import MapView from '../components/MapView'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, RiskBadge, Select, Spinner, StatusBadge, Textarea } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { usePresence, useRealtime } from '../hooks/useRealtime'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { CATEGORY_LABEL, RESOURCE_LABEL, ROLE_LABEL, fmtDateTime, fmtNum, humanize, timeAgo } from '../lib/format'
import { supabase } from '../lib/supabase'

export default function IncidentDetailPage() {
  const { id } = useParams()
  const { profile, hasRole, isStaff } = useAuth()
  const toast = useToast()
  const [inc, setInc] = useState(null)
  const [history, setHistory] = useState([])
  const [assessment, setAssessment] = useState(null)
  const [tasks, setTasks] = useState([])
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState('')
  const [conflict, setConflict] = useState(null)
  const [changedBanner, setChangedBanner] = useState(false)
  const [modal, setModal] = useState(null)      // 'reject' | 'duplicate'
  const [note, setNote] = useState('')
  const [dupOf, setDupOf] = useState('')
  const [nearby, setNearby] = useState([])
  const peers = usePresence(`incident:${id}`, profile)
  const officer = hasRole('city_officer', 'admin')

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('incidents')
      .select('*, wards(name), drainage_assets(name,code,status,condition_score), reporter:profiles!incidents_reporter_id_fkey(full_name)')
      .eq('id', id).maybeSingle()
    if (error || !data) { setNotFound(true); return }
    setInc(data)
    const [h, ra, t] = await Promise.all([
      supabase.from('incident_status_history').select('*, profiles(full_name,role)').eq('incident_id', id).order('created_at'),
      isStaff ? supabase.from('risk_assessments').select('*').eq('incident_id', id).order('created_at', { ascending: false }).limit(1) : { data: [] },
      isStaff ? supabase.from('tasks').select('id,title,status,task_type,updated_at,assignee:profiles!tasks_assigned_to_fkey(full_name)').eq('incident_id', id).order('created_at') : { data: [] },
    ])
    setHistory(h.data || []); setAssessment(ra.data?.[0] || null); setTasks(t.data || [])
  }, [id, isStaff])
  useEffect(() => { load() }, [load])

  // someone else changed this incident while I'm looking at it -> live refresh + banner
  useRealtime('incidents', (p) => {
    if (p.new?.id !== id) return
    setChangedBanner(p.new.version !== inc?.version)
    load()
  }, { filter: `id=eq.${id}` })
  useRealtime('tasks', load, { filter: `incident_id=eq.${id}` })

  const transition = async (to, extra = {}) => {
    setBusy(to)
    try {
      const { data, error } = await supabase.rpc('transition_incident', {
        p_incident_id: id, p_to: to, p_expected_version: inc.version, p_note: extra.note || null, p_duplicate_of: extra.duplicate_of || null,
      })
      if (error) throw error
      if (data.conflict) { setConflict({ mine: { ...inc, status: to }, theirs: data.current }); return }
      toast.success(`Incident ${humanize(to).toLowerCase()}`)
      setModal(null); setNote(''); setChangedBanner(false)
      await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy('') }
  }

  const assess = async () => {
    setBusy('assess')
    try {
      const r = await api(`/api/risk/incidents/${id}/assess`, { method: 'POST' })
      toast.success(`AI risk: ${r.level.toUpperCase()} (${r.score}). Priority ${r.priority}.`, 'Assessment complete')
      if (r.weather?.degraded) toast.warning(`Weather API degraded — used ${r.weather.source} data.`)
      await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy('') }
  }

  const openDuplicate = async () => {
    setModal('duplicate')
    const { data } = await supabase.rpc('nearby_incidents', { p_lat: inc.lat, p_lng: inc.lng, p_radius_m: 1000 })
    setNearby((data || []).filter((n) => n.id !== id && n.status !== 'duplicate'))
  }

  if (notFound) return <EmptyState icon={ShieldX} title="Report not found">It may have been removed, or you do not have access to it.</EmptyState>
  if (!inc) return <Spinner />

  return (
    <>
      <Link to="/incidents" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" aria-hidden />Back to reports</Link>
      <PageHeader title={inc.title} description={`${inc.reference_code} · ${CATEGORY_LABEL[inc.category]} · ${inc.wards?.name} · reported ${timeAgo(inc.created_at)}${inc.reporter ? ` by ${inc.reporter.full_name}` : ''}`}
        actions={<div className="flex items-center gap-2"><StatusBadge status={inc.status} /><RiskBadge level={inc.risk_level} score={inc.risk_score} /></div>} />

      {peers.length > 0 && (
        <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-3 py-1 text-xs text-sky-800"><Eye className="h-3.5 w-3.5" aria-hidden />Also viewing: {peers.map((p) => `${p.name} (${ROLE_LABEL[p.role]})`).join(', ')}</p>
      )}
      {changedBanner && <Alert tone="info" className="mb-4">This report was just updated by another user. You are seeing the latest version (v{inc.version}).</Alert>}
      {inc.status === 'duplicate' && <Alert tone="warning" className="mb-4">This report was flagged as a duplicate of <Link className="font-medium underline" to={`/incidents/${inc.duplicate_of}`}>another report</Link>.</Alert>}

      {officer && (
        <Card className="mb-5" title="Actions" subtitle={`Version ${inc.version} — actions use optimistic locking`}>
          <div className="flex flex-wrap gap-2">
            {inc.status === 'reported' && <Button loading={busy === 'verified'} onClick={() => transition('verified')}><CheckCircle2 className="h-4 w-4" />Verify</Button>}
            {['verified', 'assessed'].includes(inc.status) && <Button loading={busy === 'assess'} onClick={assess}><BrainCircuit className="h-4 w-4" />{inc.status === 'assessed' ? 'Re-run AI assessment' : 'Run AI risk assessment'}</Button>}
            {inc.status === 'assessed' && <Link to={`/resources?tab=plans&incident=${inc.id}`}><Button variant="secondary">Plan resources</Button></Link>}
            {inc.status === 'in_progress' && <Button variant="secondary" loading={busy === 'resolved'} onClick={() => transition('resolved')}>Mark resolved</Button>}
            {inc.status === 'duplicate' && <Button variant="secondary" loading={busy === 'verified'} onClick={() => transition('verified')}>Not a duplicate — verify</Button>}
            {['reported', 'verified'].includes(inc.status) && <Button variant="secondary" onClick={openDuplicate}><Copy className="h-4 w-4" />Mark duplicate</Button>}
            {['reported', 'verified', 'assessed'].includes(inc.status) && <Button variant="danger" onClick={() => setModal('reject')}>Reject</Button>}
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Report">
            <p className="whitespace-pre-line text-sm text-slate-700">{inc.description}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-slate-500">Water depth</dt><dd className="font-medium">{inc.water_depth_cm != null ? `${inc.water_depth_cm} cm` : '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">Reported severity</dt><dd className="font-medium">{inc.severity_reported}/5</dd></div>
              <div><dt className="text-xs text-slate-500">People affected</dt><dd className="font-medium">{fmtNum(inc.people_affected)}</dd></div>
              <div><dt className="text-xs text-slate-500">Priority</dt><dd className="font-medium">{inc.priority ?? '—'}</dd></div>
              {inc.drainage_assets && <div className="col-span-2"><dt className="text-xs text-slate-500">Linked asset</dt><dd className="font-medium">{inc.drainage_assets.name} ({inc.drainage_assets.status}, condition {inc.drainage_assets.condition_score})</dd></div>}
            </dl>
            <div className="mt-4"><MapView height="h-64" incidents={[inc]} showWardRadius={false} flyTo={[inc.lat, inc.lng]} /></div>
          </Card>

          {isStaff && assessment && <ExplainCard a={assessment} />}

          {isStaff && (
            <Card title="Field tasks" subtitle="Created automatically by the dispatch workflow">
              {tasks.length === 0 ? <p className="text-sm text-slate-500">No tasks yet.</p> : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {tasks.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{t.title} <span className="text-xs text-slate-500">· {t.assignee?.full_name || 'unassigned'}</span></span>
                      <StatusBadge status={t.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <Card title="Timeline">
          <ol className="relative space-y-4 border-l border-slate-200 pl-4">
            {history.map((h) => (
              <li key={h.id}>
                <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border-2 border-white bg-brand-600" aria-hidden />
                <p className="text-sm font-medium text-slate-800">{h.from_status ? `${humanize(h.from_status)} → ` : ''}{humanize(h.to_status)}</p>
                <p className="text-xs text-slate-500">{fmtDateTime(h.created_at)}{h.profiles ? ` · ${h.profiles.full_name}` : ' · system'}</p>
                {h.note && <p className="mt-0.5 text-xs text-slate-600">{h.note}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Modal open={modal === 'reject'} onClose={() => setModal(null)} title="Reject report"
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button variant="danger" loading={busy === 'rejected'} disabled={note.trim().length < 5} onClick={() => transition('rejected', { note })}>Reject</Button></>}>
        <Field label="Reason (shown to the reporter)" required error={note && note.trim().length < 5 ? 'At least 5 characters' : ''}>
          {(a) => <Textarea {...a} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Location is outside the drainage network; forwarded to WASA." />}
        </Field>
      </Modal>
      <Modal open={modal === 'duplicate'} onClose={() => setModal(null)} title="Mark as duplicate"
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button disabled={!dupOf} loading={busy === 'duplicate'} onClick={() => transition('duplicate', { duplicate_of: dupOf, note: 'Merged by officer' })}>Mark duplicate</Button></>}>
        {nearby.length === 0 ? <p className="text-sm text-slate-500">No other reports within 1 km.</p> : (
          <Field label="Original report">
            {(a) => <Select {...a} value={dupOf} onChange={(e) => setDupOf(e.target.value)}><option value="">Select…</option>{nearby.map((n) => <option key={n.id} value={n.id}>{n.reference_code} · {Math.round(n.distance_m)} m · {humanize(n.status)}</option>)}</Select>}
          </Field>
        )}
      </Modal>
      <ConflictDialog conflict={conflict} fields={['status', 'risk_level', 'version']} onClose={() => setConflict(null)}
        onReload={() => { setConflict(null); load() }} />
    </>
  )
}

function ExplainCard({ a }) {
  const max = Math.max(...a.contributions.map((c) => Math.abs(c.contribution)), 1)
  return (
    <Card title="Why this risk score? (explainable AI)" subtitle={`${a.model_version} · weather: ${a.weather_source} · ${fmtDateTime(a.created_at)}`}
      actions={<RiskBadge level={a.level} score={a.score} />}>
      <p className="mb-3 text-sm text-slate-600">ML estimate <strong>{Number(a.features.ml_score).toFixed(1)}</strong>, then {a.rules_fired.length} operational rule(s) applied → final <strong>{Number(a.score).toFixed(1)}</strong>.</p>
      <ul className="space-y-1.5" aria-label="Feature contributions">
        {a.contributions.slice(0, 8).map((c) => (
          <li key={c.feature} className="grid grid-cols-[minmax(0,1fr)_120px_48px] items-center gap-2 text-xs sm:grid-cols-[200px_1fr_56px]">
            <span className="truncate text-slate-700">{c.label} <span className="text-slate-400">({Number(c.value).toFixed(c.value % 1 ? 1 : 0)})</span></span>
            <div className="relative h-2.5 rounded bg-slate-100">
              <div className={`absolute top-0 h-2.5 rounded ${c.contribution >= 0 ? 'left-1/2 bg-rose-500' : 'right-1/2 bg-emerald-500'}`} style={{ width: `${(Math.abs(c.contribution) / max) * 50}%` }} />
            </div>
            <span className={`text-right font-medium ${c.contribution >= 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{c.contribution > 0 ? '+' : ''}{c.contribution}</span>
          </li>
        ))}
      </ul>
      {a.rules_fired.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Rules fired</p>
          <ul className="space-y-1 text-sm">
            {a.rules_fired.map((r) => <li key={r.code}><code className="rounded bg-slate-100 px-1 text-xs">{r.code}</code> {r.description} <span className="text-xs text-slate-500">({r.delta >= 0 ? '+' : ''}{r.delta})</span></li>)}
          </ul>
        </div>
      )}
      <p className="mt-3 flex items-center gap-1 text-xs text-slate-500"><Users className="h-3.5 w-3.5" aria-hidden />Recommended response is derived from category, depth and people affected — see Resources & Allocation.</p>
    </Card>
  )
}

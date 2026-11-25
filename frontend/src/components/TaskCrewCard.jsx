import { useEffect, useState } from 'react'
import { AlarmClock, Crown, MapPin, Phone, UserCog, Users } from 'lucide-react'
import { Alert, Button, Card, Modal, Spinner, StatusBadge } from './ui'
import { useToast } from '../context/ToastContext'
import { errorMessage } from '../lib/errors'
import { distanceM, fmtDistance, isOverdue, sortCrew, staffing } from '../lib/fieldCrew'
import { fmtDateTime } from '../lib/format'
import { supabase } from '../lib/supabase'

export const TASK_CREW_SELECT =
  'id,title,status,task_type,updated_at,due_at,crew_size,assigned_to,started_lat,started_lng,finished_lat,finished_lng,completed_at,' +
  'crew:task_assignees(is_lead, worker:profiles!task_assignees_worker_id_fkey(id,full_name,phone,field_team))'

export default function TaskCrewCard({ incident, tasks, canManage, onChanged }) {
  const [editing, setEditing] = useState(null)
  return (
    <Card title="Field tasks" subtitle="Created by the dispatch workflow and staffed with a crew that fits the job">
      {tasks.length === 0 ? <p className="text-sm text-slate-500">No tasks yet.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {tasks.map((raw) => {
            const t = { ...raw, crew: sortCrew(raw.crew) }
            const { have, need, short } = staffing(t)
            const open = !['completed', 'cancelled'].includes(t.status)
            const away = distanceM(t.finished_lat ?? t.started_lat, t.finished_lng ?? t.started_lng, incident.lat, incident.lng)
            return (
              <li key={t.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{t.title}</span>
                  <span className="flex items-center gap-2">
                    {isOverdue(t) && <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 text-xs font-medium text-red-700"><AlarmClock className="h-3 w-3" aria-hidden />overdue</span>}
                    <StatusBadge status={t.status} />
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span className={`inline-flex items-center gap-1 ${open && short ? 'font-medium text-amber-700' : ''}`}>
                    <Users className="h-3.5 w-3.5" aria-hidden />Crew {have} of {need}{open && have === 0 ? ': nobody assigned' : open && short ? ': short-staffed' : ''}
                  </span>
                  {t.crew.map((c) => (
                    <span key={c.worker?.id} className="inline-flex items-center gap-1">
                      {c.is_lead && <Crown className="h-3 w-3 text-amber-500" aria-label="Lead" />}{c.worker?.full_name}
                      {c.worker?.phone && <a href={`tel:${c.worker.phone}`} className="text-brand-700" aria-label={`Call ${c.worker.full_name}`}><Phone className="h-3 w-3" /></a>}
                    </span>
                  ))}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                  {open && t.due_at && <span>due {fmtDateTime(t.due_at)}</span>}
                  {t.completed_at && <span>done {fmtDateTime(t.completed_at)}</span>}
                  {away != null && (
                    <span className={`inline-flex items-center gap-1 ${away > 500 ? 'text-amber-700' : ''}`} title="Device GPS of the crew when it started or finished, compared with the report location">
                      <MapPin className="h-3 w-3" aria-hidden />crew GPS {fmtDistance(away)} from the report
                    </span>
                  )}
                  {canManage && open && (
                    <Button size="sm" variant={have === 0 || short ? 'primary' : 'ghost'} className="ml-auto" onClick={() => setEditing(t)}>
                      <UserCog className="h-4 w-4" />{have === 0 ? 'Assign crew' : 'Manage crew'}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {editing && <CrewModal task={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged?.() }} />}
    </Card>
  )
}

function CrewModal({ task, onClose, onSaved }) {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [picked, setPicked] = useState(() => new Set(task.crew.map((c) => c.worker?.id)))
  const [lead, setLead] = useState(task.crew.find((c) => c.is_lead)?.worker?.id || null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    supabase.rpc('eligible_field_workers', { p_task_id: task.id }).then(({ data, error: e }) => {
      if (!live) return
      if (e) setError(errorMessage(e))
      setRows(data || [])
    })
    return () => { live = false }
  }, [task.id])

  const toggle = (id) => {
    const next = new Set(picked)
    if (next.has(id)) { next.delete(id); if (lead === id) setLead([...next][0] || null) } else { next.add(id); if (!lead) setLead(id) }
    setPicked(next)
  }

  const save = async () => {
    if (picked.size === 0) { toast.error('Pick at least one field worker'); return }
    setSaving(true)
    try {
      const workers = [...picked]
      const { error: e } = await supabase.rpc('assign_task_crew', { p_task_id: task.id, p_workers: workers, p_lead: lead && picked.has(lead) ? lead : workers[0] })
      if (e) throw e
      toast.success('Crew updated. The workers see it on their phones now.')
      onSaved()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} wide title={`Crew: ${task.title}`}
      footer={<><span className="mr-auto text-xs text-slate-500">{picked.size} selected · job needs {task.crew_size || 1}</span><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={save}>Save crew</Button></>}>
      {error && <Alert tone="error" className="mb-3">{error}</Alert>}
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">No active field workers serve this area.</p> : (
        <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto text-sm">
          {rows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 py-2">
              <input type="checkbox" className="h-4 w-4" checked={picked.has(w.id)} onChange={() => toggle(w.id)} aria-label={`Crew: ${w.full_name}`} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">{w.full_name}</p>
                <p className="text-xs text-slate-500">{w.field_team || 'No team on record'} · {w.organization || 'No organisation'} · {w.open_tasks} open task{w.open_tasks === 1 ? '' : 's'}</p>
                <p className="mt-0.5 flex flex-wrap gap-1 text-[11px]">
                  <Tag tone={w.on_duty ? 'green' : 'slate'}>{w.on_duty ? 'on duty' : 'off duty'}</Tag>
                  {w.skill_match ? <Tag tone="green">right team</Tag> : <Tag tone="amber">other team</Tag>}
                  {w.owner_org && <Tag tone="sky">owns this stock</Tag>}
                  {w.declined && <Tag tone="red">declined this task</Tag>}
                </p>
              </div>
              <label className={`flex items-center gap-1 text-xs ${picked.has(w.id) ? 'text-slate-700' : 'invisible'}`}>
                <input type="radio" name="lead" checked={lead === w.id} onChange={() => setLead(w.id)} disabled={!picked.has(w.id)} />Lead
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

const TAG = {
  green: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-800', sky: 'bg-sky-50 text-sky-700',
  red: 'bg-red-50 text-red-700', slate: 'bg-slate-100 text-slate-600',
}
const Tag = ({ tone, children }) => <span className={`rounded px-1.5 py-0.5 ${TAG[tone]}`}>{children}</span>

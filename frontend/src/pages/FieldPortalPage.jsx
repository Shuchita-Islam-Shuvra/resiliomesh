import { useCallback, useEffect, useRef, useState } from 'react'
import { AlarmClock, CheckCircle2, CloudOff, Crown, GitMerge, Hand, HandHeart, MapPin, Phone, PlayCircle, Power, RefreshCw, Search, ThumbsUp, Users, XCircle } from 'lucide-react'
import FieldNeedModal from '../components/FieldNeedModal'
import { Alert, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Textarea } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useOnline } from '../hooks/useOnline'
import { useRealtime } from '../hooks/useRealtime'
import { canTransition } from '../offline/conflict'
import * as store from '../offline/db'
import { flushOutbox } from '../offline/sync'
import { errorMessage } from '../lib/errors'
import { TASK_VIEWS, filterTasks, getPosition, isOverdue, sortCrew, sortTasks, staffing, viewCounts } from '../lib/fieldCrew'
import { fmtDateTime, humanize, timeAgo, uuid } from '../lib/format'
import { supabase } from '../lib/supabase'

const NEXT = {
  assigned: [['accepted', 'Accept', ThumbsUp], ['in_progress', 'Start work', PlayCircle]],
  accepted: [['in_progress', 'Start work', PlayCircle], ['failed', 'Report problem', XCircle]],
  in_progress: [['completed', 'Mark completed', CheckCircle2], ['failed', 'Report failure', XCircle]],
  failed: [['in_progress', 'Retry', PlayCircle]],
}
const DONE_MSG = { accepted: 'Task accepted', in_progress: 'Work started', completed: 'Task completed', failed: 'Problem reported to the officer' }
const GPS_STATUSES = ['in_progress', 'completed', 'failed']

export default function FieldPortalPage() {
  const { profile, refreshProfile } = useAuth()
  const toast = useToast()
  const online = useOnline()
  const [tasks, setTasks] = useState(null)
  const [outbox, setOutbox] = useState([])
  const [conflicts, setConflicts] = useState([])
  const [cachedAt, setCachedAt] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [noteFor, setNoteFor] = useState(null)
  const [declineFor, setDeclineFor] = useState(null)
  const [busy, setBusy] = useState('')
  const [working, setWorking] = useState(null)
  const [view, setView] = useState('all')
  const [q, setQ] = useState('')
  const [sortBy, setSortBy] = useState('due')
  const [needOpen, setNeedOpen] = useState(false)
  const inFlight = useRef(new Set())
  const known = useRef(null)
  const onDuty = profile.on_duty !== false

  const refreshLocal = useCallback(async () => {
    setOutbox(await store.getOutbox())
    setConflicts(await store.getConflicts())
    setCachedAt(await store.getMeta('tasks_cached_at'))
  }, [])

  const fetchServer = useCallback(async () => {
    const { data, error } = await supabase.from('tasks')
      .select('*, incidents(reference_code,title,lat,lng,water_depth_cm,ward_id,wards(name)), me:task_assignees!inner(worker_id), crew:task_assignees(is_lead, worker:profiles!task_assignees_worker_id_fkey(id,full_name,phone,field_team))')
      .eq('me.worker_id', profile.id).order('updated_at', { ascending: false })
    if (error) throw error
    const rows = data.map((t) => { const { me: _me, ...rest } = t; return { ...rest, crew: sortCrew(t.crew) } })
    await store.cacheTasks(rows)
    return rows
  }, [profile.id])

  const announceNew = useCallback((rows) => {
    const ids = new Set(rows.map((t) => t.id))
    if (known.current) {
      const fresh = rows.filter((t) => !known.current.has(t.id) && !['completed', 'cancelled'].includes(t.status))
      if (fresh.length === 1) toast.info(`${fresh[0].title} · ${fresh[0].incidents?.wards?.name || fresh[0].incidents?.reference_code || ''}`, 'New task for you')
      else if (fresh.length > 1) toast.info(`${fresh.length} new tasks are waiting for you.`, 'New tasks')
    }
    known.current = ids
  }, [toast])

  const load = useCallback(async () => {
    let rows
    try {
      rows = navigator.onLine ? await fetchServer() : await store.getCachedTasks()
    } catch {
      rows = await store.getCachedTasks()
    }
    announceNew(rows)
    setTasks(rows)
    refreshLocal()
  }, [announceNew, fetchServer, refreshLocal])

  const sync = useCallback(async (silent, quietSuccess = false) => {
    if (!navigator.onLine) return null
    setSyncing(true)
    try {
      const r = await flushOutbox(supabase)
      if (!silent || r.synced || r.conflicts || r.failed) {
        if (r.conflicts) toast.warning(`${r.conflicts} conflict(s) auto-resolved — see the conflict log.`, 'Sync')
        else if (r.failed) toast.error(`${r.failed} change(s) rejected by server. See the conflict log.`, 'Sync')
        else if (r.synced && !quietSuccess) toast.success(`${r.synced} offline change(s) synced.`)
      }
      await load()
      return r
    } finally { setSyncing(false) }
  }, [load, toast])

  useEffect(() => { load().then(() => sync(true)) }, [])
  useEffect(() => { if (online) sync(false) }, [online])
  useRealtime('tasks', () => { if (navigator.onLine) load() })
  useRealtime('task_assignees', () => { if (navigator.onLine) load() }, { filter: `worker_id=eq.${profile.id}` })

  const toggleDuty = async () => {
    setBusy('duty')
    try {
      const { error } = await supabase.from('profiles').update({ on_duty: !onDuty }).eq('id', profile.id)
      if (error) throw error
      await refreshProfile()
      toast.success(onDuty ? 'You are off duty. You will not get new tasks; your open tasks stay with you.' : 'You are on duty. New tasks can reach you.')
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy('') }
  }

  const decline = async () => {
    const reason = declineFor?.reason?.trim()
    if (!reason || reason.length < 3) { toast.error('Say why you cannot take this task'); return }
    setBusy('decline')
    try {
      const { data, error } = await supabase.rpc('decline_task', { p_task_id: declineFor.task.id, p_reason: reason })
      if (error) throw error
      toast.success(data?.replacement ? 'Declined. A replacement has been assigned.' : 'Declined. No one else is free right now, so the officer will assign someone.')
      setDeclineFor(null)
      await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy('') }
  }

  const update = async (task, status, notes) => {
    if (!canTransition(task.status, status)) { toast.error('That transition is not allowed'); return }
    if (status === 'failed' && !notes?.trim()) { toast.error('Describe what went wrong'); return }
    if (inFlight.current.has(task.id)) return
    inFlight.current.add(task.id)
    setWorking(task.id)
    try {
      if ((await store.getOutbox()).some((o) => o.task_id === task.id && o.status === status)) {
        toast.info('This change is already saved and waiting to sync.'); setNoteFor(null); return
      }
      const stamped = notes ? `[${new Date().toLocaleString('en-GB')}] ${notes.trim()}` : null
      const pos = GPS_STATUSES.includes(status) ? await getPosition() : null
      const gps = !GPS_STATUSES.includes(status) ? '' : pos ? ' · location recorded' : ' · no GPS fix, saved without location'
      const local = { ...task, status, notes: stamped ? `${task.notes ? task.notes + '\n' : ''}${stamped}` : task.notes, _pending: true }
      await store.putCachedTask(local)
      await store.enqueue({ op_id: uuid(), type: 'task_status', task_id: task.id, task_title: task.title, status, notes: stamped, base_version: task.version,
        pos: pos ? { lat: pos.lat, lng: pos.lng } : null })
      setTasks((ts) => ts.map((t) => (t.id === task.id ? local : t)))
      setNoteFor(null)
      await refreshLocal()
      if (navigator.onLine) {
        const r = await sync(true, true)
        if (r && !r.failed && !r.conflicts && !r.remaining) toast.success(`${DONE_MSG[status] || 'Saved'}${gps}.`)
      } else toast.info(`Saved offline${gps}. Will sync when signal returns.`)
    } finally {
      inFlight.current.delete(task.id)
      setWorking(null)
    }
  }

  if (!tasks) return <Spinner />
  const openCount = tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length
  const counts = viewCounts(tasks)
  const active = sortTasks(filterTasks(tasks, { view, q }), sortBy)
  const done = tasks.filter((t) => ['completed', 'cancelled'].includes(t.status))
  return (
    <>
      <PageHeader title="Field worker portal" description="Offline-first: tasks are cached on this device; status updates queue locally and sync with conflict resolution."
        actions={<div className="flex flex-wrap gap-2">
          <Button variant={onDuty ? 'primary' : 'secondary'} loading={busy === 'duty'} disabled={!online} onClick={toggleDuty} aria-pressed={onDuty}
            title={onDuty ? 'Go off duty: no new tasks will be sent to you' : 'Go on duty: new tasks can reach you'}>
            <Power className="h-4 w-4" />{onDuty ? 'On duty' : 'Off duty'}
          </Button>
          <Button variant="secondary" loading={syncing} disabled={!online} onClick={() => sync(false)}><RefreshCw className="h-4 w-4" />Sync now</Button>
          <Button variant="warning" disabled={!online} onClick={() => setNeedOpen(true)} title="Tell the NGO coordinators what people here need"><HandHeart className="h-4 w-4" />People need help</Button>
        </div>} />
      <FieldNeedModal open={needOpen} onClose={() => setNeedOpen(false)} tasks={tasks} online={online} />
      {!onDuty && <Alert tone="warning" className="mb-4" title="You are off duty">No new tasks will be assigned to you. Tasks you already have stay here until they are done.</Alert>}
      {profile.field_team && <p className="-mt-2 mb-4 text-sm text-slate-500">Team: <strong className="text-slate-700">{profile.field_team}</strong>. You get tasks that match this team.</p>}
      {!online && <Alert tone="warning" className="mb-4" title="Offline mode"><CloudOff className="mr-1 inline h-4 w-4" aria-hidden />Showing tasks cached {cachedAt ? timeAgo(cachedAt) : 'earlier'}. Your updates are stored on this device.</Alert>}
      {outbox.length > 0 && <Alert tone="info" className="mb-4">{outbox.length} change(s) waiting to sync.</Alert>}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {openCount > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div role="group" aria-label="Show tasks" className="flex flex-wrap gap-1">
                {Object.entries(TASK_VIEWS).map(([k, v]) => (
                  <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${view === k ? 'bg-brand-700 text-white ring-brand-700' : 'bg-surface text-slate-600 ring-slate-200 hover:bg-slate-50'} ${k === 'overdue' && counts.overdue > 0 && view !== k ? '!text-red-700 !ring-red-200' : ''}`}>
                    {v.label} <span className="tabular-nums opacity-75">{counts[k]}</span>
                  </button>
                ))}
              </div>
              <div className="flex gap-2 sm:ml-auto">
                <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
                  <Input type="search" aria-label="Search tasks by ward, report code or title" placeholder="Ward, code, title" value={q} onChange={(e) => setQ(e.target.value)} className="!py-1.5 pl-8 text-sm" />
                </div>
                <Select aria-label="Sort tasks" value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="!w-auto !py-1.5 text-sm">
                  <option value="due">Due soonest</option>
                  <option value="newest">Recently updated</option>
                </Select>
              </div>
            </div>
          )}
          {openCount === 0 && <Card><EmptyState icon={CheckCircle2} title="No active tasks">{onDuty ? 'New assignments appear here instantly when a plan is dispatched.' : 'You are off duty, so no new tasks will be sent to you.'}</EmptyState></Card>}
          {openCount > 0 && active.length === 0 && (
            <Card><EmptyState icon={Search} title="No tasks match">
              <Button size="sm" variant="secondary" onClick={() => { setView('all'); setQ('') }}>Show all open tasks</Button>
            </EmptyState></Card>
          )}
          {active.map((t) => (
            <Card key={t.id} bodyClass="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{t.title}</p>
                  <p className="text-sm text-slate-500">{t.incidents?.reference_code} · {t.incidents?.title}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3.5 w-3.5" aria-hidden />{t.incidents?.wards?.name} · depth {t.incidents?.water_depth_cm ?? '—'} cm · due {fmtDateTime(t.due_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {isOverdue(t) && <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 text-xs font-medium text-red-700"><AlarmClock className="h-3 w-3" aria-hidden />overdue</span>}
                  {t._pending && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">pending sync</span>}<StatusBadge status={t.status} />
                </div>
              </div>
              <CrewList task={t} me={profile.id} />
              {t.notes && <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs text-slate-600">{t.notes}</pre>}
              <div className="mt-3 flex flex-wrap gap-2">
                {(NEXT[t.status] || []).map(([s, label, Icon]) => (
                  <Button key={s} size="sm" variant={s === 'failed' ? 'danger' : s === 'completed' ? 'primary' : 'secondary'}
                    disabled={working === t.id} loading={working === t.id && !['failed', 'completed'].includes(s)}
                    onClick={() => (s === 'failed' || s === 'completed' ? setNoteFor({ task: t, status: s, notes: '' }) : update(t, s))}>
                    <Icon className="h-4 w-4" />{label}
                  </Button>
                ))}
                {t.status === 'assigned' && !t._pending && (
                  <Button size="sm" variant="ghost" disabled={!online || working === t.id} onClick={() => setDeclineFor({ task: t, reason: '' })}
                    title={online ? 'You can decline before accepting; someone else will be assigned' : 'Declining needs signal, so a replacement can be found at once'}>
                    <Hand className="h-4 w-4" />Can&apos;t take it{!online && ' (needs signal)'}
                  </Button>
                )}
                {t.incidents && <a className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${t.incidents.lat},${t.incidents.lng}`}>Navigate</a>}
              </div>
            </Card>
          ))}
          {done.length > 0 && (
            <Card title="Completed / cancelled" bodyClass="p-0">
              <ul className="divide-y divide-slate-100">{done.slice(0, 10).map((t) => <li key={t.id} className="flex items-center justify-between px-4 py-2 text-sm"><span className="truncate">{t.title} · {t.incidents?.reference_code}</span><StatusBadge status={t.status} /></li>)}</ul>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card title="Sync queue" subtitle="Stored in IndexedDB">
            {outbox.length === 0 ? <p className="text-sm text-slate-500">All changes synced.</p> : (
              <ul className="space-y-1 text-sm">{outbox.map((o) => <li key={o.op_id} className="flex justify-between gap-2"><span className="truncate">{o.task_title || o.payload?.title}</span><span className="text-xs text-slate-500">{o.status ? `→ ${humanize(o.status)}` : 'new report'}</span></li>)}</ul>
            )}
          </Card>
          <Card title="Conflict log" actions={conflicts.length > 0 && <Button size="sm" variant="ghost" onClick={async () => { await store.clearConflicts(); refreshLocal() }}>Clear</Button>}>
            {conflicts.length === 0 ? <p className="text-sm text-slate-500">No conflicts.</p> : (
              <ul className="space-y-3 text-sm">
                {conflicts.map((c) => (
                  <li key={c.id} className="rounded-lg border border-slate-200 p-2">
                    <p className="flex items-center gap-1 font-medium"><GitMerge className="h-4 w-4 text-amber-500" aria-hidden />{c.task_title}</p>
                    <p className="text-xs text-slate-500">Offline: {humanize(c.local_status)} · Server: {humanize(c.server_status)} · <strong>{c.winner === 'client' ? 'your change kept' : c.winner === 'merge' ? 'merged' : 'server kept'}</strong></p>
                    <p className="mt-1 text-xs text-slate-600">{c.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Modal open={Boolean(noteFor)} onClose={() => setNoteFor(null)} title={noteFor?.status === 'failed' ? (noteFor.task.status === 'accepted' ? 'Report a problem' : 'Report failure') : 'Complete task'}
        footer={<><Button variant="secondary" onClick={() => setNoteFor(null)}>Cancel</Button><Button variant={noteFor?.status === 'failed' ? 'danger' : 'primary'} loading={Boolean(noteFor) && working === noteFor.task.id} onClick={() => update(noteFor.task, noteFor.status, noteFor.notes)}>Save</Button></>}>
        {noteFor?.status === 'failed' && <p className="mb-3 text-sm text-slate-600">The officer sees this at once and can send another crew, or you can retry later. Your location is recorded if the phone has a GPS fix.</p>}
        {noteFor && (
          <Field label={noteFor.status === 'failed' ? 'What went wrong?' : 'Completion notes (optional)'} required={noteFor.status === 'failed'}>
            {(a) => <Textarea {...a} rows={3} value={noteFor.notes} onChange={(e) => setNoteFor({ ...noteFor, notes: e.target.value })} placeholder={noteFor.status === 'failed' ? 'e.g. Pump generator out of fuel; road access blocked' : 'e.g. Drain cleared, water receding'} />}
          </Field>
        )}
      </Modal>

      <Modal open={Boolean(declineFor)} onClose={() => setDeclineFor(null)} title="Can't take this task"
        footer={<><Button variant="secondary" onClick={() => setDeclineFor(null)}>Keep it</Button><Button variant="danger" loading={busy === 'decline'} onClick={decline}>Decline</Button></>}>
        {declineFor && (
          <>
            <p className="mb-3 text-sm text-slate-600">{declineFor.task.title}: {declineFor.task.incidents?.reference_code}. The system will try to send a replacement with the same skills. If no one is free, the officer is told.</p>
            <Field label="Why can't you take it?" required>
              {(a) => <Textarea {...a} rows={3} maxLength={300} value={declineFor.reason} onChange={(e) => setDeclineFor({ ...declineFor, reason: e.target.value })} placeholder="e.g. Already on a pump at Mugda; sick today; no transport to that ward" />}
            </Field>
          </>
        )}
      </Modal>
    </>
  )
}

function CrewList({ task, me }) {
  const { have, need, short } = staffing(task)
  if (!task.crew?.length) return null
  return (
    <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50/60 p-2">
      <p className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600">
        <Users className="h-3.5 w-3.5" aria-hidden />Crew {have} of {need}
        {short && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">short-staffed</span>}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        {task.crew.map((c) => (
          <li key={c.worker?.id} className="flex items-center gap-1">
            {c.is_lead && <Crown className="h-3 w-3 text-amber-500" aria-label="Lead" />}
            <span className={c.worker?.id === me ? 'font-semibold' : ''}>{c.worker?.id === me ? 'You' : c.worker?.full_name}</span>
            {c.worker?.field_team && <span className="text-slate-400">· {c.worker.field_team}</span>}
            {c.worker?.id !== me && c.worker?.phone && (
              <a href={`tel:${c.worker.phone}`} className="inline-flex items-center rounded px-1 text-brand-700 hover:bg-brand-50" aria-label={`Call ${c.worker.full_name}`}><Phone className="h-3 w-3" /></a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

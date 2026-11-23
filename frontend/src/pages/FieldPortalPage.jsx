import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, CloudOff, GitMerge, MapPin, PlayCircle, RefreshCw, ThumbsUp, XCircle } from 'lucide-react'
import { Alert, Button, Card, EmptyState, Field, Modal, PageHeader, Spinner, StatusBadge, Textarea } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useOnline } from '../hooks/useOnline'
import { useRealtime } from '../hooks/useRealtime'
import { canTransition } from '../offline/conflict'
import * as store from '../offline/db'
import { flushOutbox } from '../offline/sync'
import { fmtDateTime, humanize, timeAgo, uuid } from '../lib/format'
import { supabase } from '../lib/supabase'

const NEXT = {
  assigned: [['accepted', 'Accept', ThumbsUp], ['in_progress', 'Start work', PlayCircle]],
  accepted: [['in_progress', 'Start work', PlayCircle]],
  in_progress: [['completed', 'Mark completed', CheckCircle2], ['failed', 'Report failure', XCircle]],
  failed: [['in_progress', 'Retry', PlayCircle]],
}

export default function FieldPortalPage() {
  const { profile } = useAuth()
  const toast = useToast()
  const online = useOnline()
  const [tasks, setTasks] = useState(null)
  const [outbox, setOutbox] = useState([])
  const [conflicts, setConflicts] = useState([])
  const [cachedAt, setCachedAt] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [noteFor, setNoteFor] = useState(null)

  const refreshLocal = useCallback(async () => {
    setOutbox(await store.getOutbox())
    setConflicts(await store.getConflicts())
    setCachedAt(await store.getMeta('tasks_cached_at'))
  }, [])

  const fetchServer = useCallback(async () => {
    const { data, error } = await supabase.from('tasks')
      .select('*, incidents(reference_code,title,lat,lng,water_depth_cm,wards(name))')
      .eq('assigned_to', profile.id).order('updated_at', { ascending: false })
    if (error) throw error
    await store.cacheTasks(data)
    return data
  }, [profile.id])

  const load = useCallback(async () => {
    try {
      if (navigator.onLine) setTasks(await fetchServer())
      else setTasks(await store.getCachedTasks())
    } catch {
      setTasks(await store.getCachedTasks())       // network failed mid-request -> cached view
    }
    refreshLocal()
  }, [fetchServer, refreshLocal])

  const sync = useCallback(async (silent) => {
    if (!navigator.onLine) return
    setSyncing(true)
    try {
      const r = await flushOutbox(supabase)
      if (!silent || r.synced || r.conflicts || r.failed) {
        if (r.conflicts) toast.warning(`${r.conflicts} conflict(s) auto-resolved — see the conflict log.`, 'Sync')
        else if (r.failed) toast.error(`${r.failed} change(s) rejected by server.`, 'Sync')
        else if (r.synced) toast.success(`${r.synced} offline change(s) synced.`)
      }
      await load()
    } finally { setSyncing(false) }
  }, [load, toast])

  useEffect(() => { load().then(() => sync(true)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (online) sync(false) }, [online]) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime('tasks', () => { if (navigator.onLine) load() }, { filter: `assigned_to=eq.${profile.id}` })

  const update = async (task, status, notes) => {
    if (!canTransition(task.status, status)) { toast.error('That transition is not allowed'); return }
    if (status === 'failed' && !notes?.trim()) { toast.error('Describe why the task failed'); return }
    const stamped = notes ? `[${new Date().toLocaleString('en-GB')}] ${notes.trim()}` : null
    // optimistic local update first (works offline)
    const local = { ...task, status, notes: stamped ? `${task.notes ? task.notes + '\n' : ''}${stamped}` : task.notes, _pending: true }
    await store.putCachedTask(local)
    await store.enqueue({ op_id: uuid(), type: 'task_status', task_id: task.id, task_title: task.title, status, notes: stamped, base_version: task.version })
    setTasks((ts) => ts.map((t) => (t.id === task.id ? local : t)))
    setNoteFor(null)
    await refreshLocal()
    if (navigator.onLine) sync(true)
    else toast.info('Saved offline. Will sync when signal returns.')
  }

  if (!tasks) return <Spinner />
  const active = tasks.filter((t) => !['completed', 'cancelled'].includes(t.status))
  const done = tasks.filter((t) => ['completed', 'cancelled'].includes(t.status))
  return (
    <>
      <PageHeader title="Field worker portal" description="Offline-first: tasks are cached on this device; status updates queue locally and sync with conflict resolution."
        actions={<Button variant="secondary" loading={syncing} disabled={!online} onClick={() => sync(false)}><RefreshCw className="h-4 w-4" />Sync now</Button>} />
      {!online && <Alert tone="warning" className="mb-4" title="Offline mode"><CloudOff className="mr-1 inline h-4 w-4" aria-hidden />Showing tasks cached {cachedAt ? timeAgo(cachedAt) : 'earlier'}. Your updates are stored on this device.</Alert>}
      {outbox.length > 0 && <Alert tone="info" className="mb-4">{outbox.length} change(s) waiting to sync.</Alert>}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {active.length === 0 && <Card><EmptyState icon={CheckCircle2} title="No active tasks">New assignments appear here instantly when a plan is dispatched.</EmptyState></Card>}
          {active.map((t) => (
            <Card key={t.id} bodyClass="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{t.title}</p>
                  <p className="text-sm text-slate-500">{t.incidents?.reference_code} · {t.incidents?.title}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3.5 w-3.5" aria-hidden />{t.incidents?.wards?.name} · depth {t.incidents?.water_depth_cm ?? '—'} cm · due {fmtDateTime(t.due_at)}</p>
                </div>
                <div className="flex items-center gap-2">{t._pending && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">pending sync</span>}<StatusBadge status={t.status} /></div>
              </div>
              {t.notes && <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs text-slate-600">{t.notes}</pre>}
              <div className="mt-3 flex flex-wrap gap-2">
                {(NEXT[t.status] || []).map(([s, label, Icon]) => (
                  <Button key={s} size="sm" variant={s === 'failed' ? 'danger' : s === 'completed' ? 'primary' : 'secondary'}
                    onClick={() => (s === 'failed' || s === 'completed' ? setNoteFor({ task: t, status: s, notes: '' }) : update(t, s))}>
                    <Icon className="h-4 w-4" />{label}
                  </Button>
                ))}
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

      <Modal open={Boolean(noteFor)} onClose={() => setNoteFor(null)} title={noteFor?.status === 'failed' ? 'Report failure' : 'Complete task'}
        footer={<><Button variant="secondary" onClick={() => setNoteFor(null)}>Cancel</Button><Button variant={noteFor?.status === 'failed' ? 'danger' : 'primary'} onClick={() => update(noteFor.task, noteFor.status, noteFor.notes)}>Save</Button></>}>
        {noteFor && (
          <Field label={noteFor.status === 'failed' ? 'What went wrong?' : 'Completion notes (optional)'} required={noteFor.status === 'failed'}>
            {(a) => <Textarea {...a} rows={3} value={noteFor.notes} onChange={(e) => setNoteFor({ ...noteFor, notes: e.target.value })} placeholder={noteFor.status === 'failed' ? 'e.g. Pump generator out of fuel; road access blocked' : 'e.g. Drain cleared, water receding'} />}
          </Field>
        )}
      </Modal>
    </>
  )
}

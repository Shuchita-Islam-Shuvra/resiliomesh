import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Circle, Loader2, RotateCcw, Undo2, Workflow, XCircle } from 'lucide-react'
import { Alert, Button, Card, EmptyState, PageHeader, Select, Spinner, StatusBadge, Tabs, Th } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { fmtDateTime, humanize, timeAgo } from '../lib/format'
import { supabase } from '../lib/supabase'

const STEP_ORDER = ['validate_plan', 'reserve_resources', 'create_tasks', 'notify_teams', 'activate_incidents']
const STEP_ICON = { succeeded: CheckCircle2, failed: XCircle, running: Loader2, compensated: Undo2, pending: Circle }
const STEP_COLOR = { succeeded: 'text-emerald-600', failed: 'text-rose-600', running: 'text-sky-600 animate-spin', compensated: 'text-orange-500', pending: 'text-slate-300' }

export default function WorkflowsPage() {
  const [tab, setTab] = useState('runs')
  return (
    <>
      <PageHeader title="Automated workflow & task history" description="Each approved plan runs a 5-step dispatch saga. Failed steps retry with exponential backoff; if retries are exhausted, completed steps are compensated (stock released, tasks cancelled, incidents rolled back)." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'runs', label: 'Workflow runs' }, { value: 'tasks', label: 'Task history' }]} />
      {tab === 'runs' ? <Runs /> : <Tasks />}
    </>
  )
}

function Runs() {
  const { hasRole } = useAuth()
  const toast = useToast()
  const [runs, setRuns] = useState(null)
  const [steps, setSteps] = useState({})
  const [worker, setWorker] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase.from('workflow_runs').select('*, allocation_plans(incident_ids, assignments)').order('created_at', { ascending: false }).limit(20)
    setRuns(data || [])
    const ids = (data || []).map((r) => r.id)
    if (ids.length) {
      const { data: st } = await supabase.from('workflow_steps').select('*').in('run_id', ids)
      const g = {}
      for (const s of st || []) (g[s.run_id] ??= {})[s.step_name] = s
      setSteps(g)
    }
  }, [])
  useEffect(() => { load(); api('/api/workflows/worker').then(setWorker).catch(() => setWorker(null)) }, [load])
  useRealtime(['workflow_runs', 'workflow_steps'], useDebouncedCallback(load, 300))

  const retry = async (id) => {
    setBusy(id)
    try {
      const { error } = await supabase.rpc('retry_workflow_run', { p_run_id: id })
      if (error) throw error
      toast.success('Run re-queued. Completed steps are idempotent and will not double-reserve.')
      api('/api/workflows/process-now', { method: 'POST' }).catch(() => {})
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy('') }
  }
  const processNow = async () => {
    setBusy('now')
    try { const r = await api('/api/workflows/process-now', { method: 'POST' }); toast.info(`Processed ${r.processed} queued run(s)`) } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(''); load() }
  }

  if (!runs) return <Spinner />
  return (
    <div className="space-y-4">
      <Alert tone={worker ? 'info' : 'warning'}>
        {worker ? <>Worker online · processed {worker.processed} run(s) · last poll {worker.last_poll ? timeAgo(worker.last_poll * 1000) : '—'}</> : 'Worker status unavailable (backend asleep?). Use "Process queue now".'}
        <Button size="sm" variant="secondary" className="ml-3" loading={busy === 'now'} onClick={processNow}>Process queue now</Button>
      </Alert>
      {runs.length === 0 ? <Card><EmptyState icon={Workflow} title="No workflow runs yet">
          <p>A run starts when an allocation plan is approved.</p>
          <Link to="/resources?tab=plans" className="mt-3 inline-block"><Button size="sm">Go to Optimise &amp; approve</Button></Link>
        </EmptyState></Card> : runs.map((r) => (
        <Card key={r.id} bodyClass="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-xs text-slate-500">{r.id.slice(0, 8)} · {r.workflow}</p>
              <p className="text-sm text-slate-700">{r.allocation_plans?.incident_ids?.length} incident(s) · {r.allocation_plans?.assignments?.length} assignment(s) · attempt {r.attempts}/{r.max_attempts} · {fmtDateTime(r.created_at)}</p>
            </div>
            <div className="flex items-center gap-2">
              {r.inject_failure && <span className="rounded bg-rose-50 px-1.5 text-xs text-rose-700 ring-1 ring-rose-200">fault injected: {r.inject_failure}</span>}
              <StatusBadge status={r.status} />
              {['failed', 'compensated'].includes(r.status) && hasRole('admin', 'city_officer') && <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => retry(r.id)}><RotateCcw className="h-4 w-4" />Retry</Button>}
            </div>
          </div>
          <ol className="mt-4 grid gap-2 sm:grid-cols-5" aria-label="Workflow steps">
            {STEP_ORDER.map((name, i) => {
              const s = steps[r.id]?.[name]
              const st = s?.status || 'pending'
              const Icon = STEP_ICON[st] || Circle
              return (
                <li key={name} className={`rounded-lg border p-2.5 ${st === 'failed' ? 'border-rose-200 bg-rose-50' : st === 'compensated' ? 'border-orange-200 bg-orange-50' : 'border-slate-200'}`}>
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><Icon className={`h-4 w-4 ${STEP_COLOR[st]}`} aria-hidden />{i + 1}. {humanize(name)}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">{humanize(st)}{s?.attempts ? ` · ${s.attempts} attempt(s)` : ''}</p>
                  {s?.error && <p className="mt-1 line-clamp-3 text-[11px] text-rose-700" title={s.error}>{s.error}</p>}
                </li>
              )
            })}
          </ol>
          {r.last_error && <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-600"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />{r.last_error}</p>}
        </Card>
      ))}
    </div>
  )
}

function Tasks() {
  const [rows, setRows] = useState(null)
  const [status, setStatus] = useState('')
  const load = useCallback(async () => {
    let q = supabase.from('tasks').select('*, incidents(reference_code), assignee:profiles!tasks_assigned_to_fkey(full_name)').order('updated_at', { ascending: false }).limit(200)
    if (status) q = q.eq('status', status)
    const { data } = await q
    setRows(data || [])
  }, [status])
  useEffect(() => { load() }, [load])
  useRealtime('tasks', useDebouncedCallback(load, 500))
  if (!rows) return <Spinner />
  return (
    <Card bodyClass="p-0">
      <div className="p-4"><Select aria-label="Filter tasks by status" className="max-w-[220px]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['pending', 'assigned', 'accepted', 'in_progress', 'completed', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50"><tr><Th>Task</Th><Th>Incident</Th><Th>Assignee</Th><Th>Status</Th><Th className="hidden md:table-cell">Updated</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2"><p className="font-medium">{t.title}</p><p className="text-xs text-slate-500">{humanize(t.task_type)} · v{t.version}</p></td>
                <td className="px-3 py-2">{t.incidents?.reference_code}</td>
                <td className="px-3 py-2">{t.assignee?.full_name || '—'}</td>
                <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                <td className="hidden px-3 py-2 text-xs text-slate-500 md:table-cell">{timeAgo(t.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

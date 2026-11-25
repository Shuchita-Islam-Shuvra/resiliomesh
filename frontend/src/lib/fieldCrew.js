export const DONE_STATUSES = ['completed', 'cancelled']

export function isOverdue(task, now = Date.now()) {
  if (!task?.due_at || DONE_STATUSES.includes(task.status)) return false
  return new Date(task.due_at).getTime() < now
}

export function sortCrew(rows = []) {
  return [...rows].sort((a, b) => (b.is_lead - a.is_lead) || (a.worker?.full_name || '').localeCompare(b.worker?.full_name || ''))
}

export function staffing(task) {
  const have = task?.crew?.length ?? (task?.assigned_to ? 1 : 0)
  const need = task?.crew_size || 1
  return { have, need, short: have < need }
}

export const ATTENTION = {
  failed: { label: 'Failed', tone: 'red', hint: 'The crew reported a problem. Re-staff it or let them retry.' },
  no_crew: { label: 'No crew', tone: 'red', hint: 'Nobody fitting and on duty was free. Assign a crew.' },
  overdue: { label: 'Overdue', tone: 'amber', hint: 'Past its due time and still open.' },
  short: { label: 'Short-staffed', tone: 'amber', hint: 'Fewer people than the job needs.' },
  declined: { label: 'Declined', tone: 'slate', hint: 'A worker declined it.' },
}
const ATTENTION_ORDER = Object.keys(ATTENTION)

export function taskAttention(task, now = Date.now()) {
  if (!task || DONE_STATUSES.includes(task.status)) return []
  const { have, short } = staffing(task)
  const out = []
  if (task.status === 'failed') out.push('failed')
  if (have === 0) out.push('no_crew')
  if (isOverdue(task, now)) out.push('overdue')
  if (have > 0 && short) out.push('short')
  if ((task.declines?.length || 0) > 0) out.push('declined')
  return out
}

export function attentionQueue(tasks = [], now = Date.now()) {
  const rank = (r) => (r.length ? ATTENTION_ORDER.indexOf(r[0]) : 99)
  return tasks
    .map((t) => ({ task: t, reasons: taskAttention(t, now) }))
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => rank(a.reasons) - rank(b.reasons) || dueMs(a.task) - dueMs(b.task))
}

const dueMs = (t) => (t?.due_at ? new Date(t.due_at).getTime() : Number.POSITIVE_INFINITY)

export const TASK_VIEWS = {
  all: { label: 'All open', match: () => true },
  new: { label: 'New', match: (t) => t.status === 'assigned' },
  active: { label: 'Working', match: (t) => ['accepted', 'in_progress'].includes(t.status) },
  overdue: { label: 'Overdue', match: (t, now) => isOverdue(t, now) },
  failed: { label: 'Problem', match: (t) => t.status === 'failed' },
}

export function filterTasks(tasks = [], { view = 'all', q = '' } = {}, now = Date.now()) {
  const match = (TASK_VIEWS[view] || TASK_VIEWS.all).match
  const needle = q.trim().toLowerCase()
  return tasks.filter((t) => !DONE_STATUSES.includes(t.status) && match(t, now) && (!needle || [
    t.title, t.incidents?.reference_code, t.incidents?.title, t.incidents?.wards?.name,
  ].some((s) => (s || '').toLowerCase().includes(needle))))
}

export function sortTasks(tasks = [], by = 'due') {
  const list = [...tasks]
  if (by === 'newest') return list.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
  return list.sort((a, b) => dueMs(a) - dueMs(b) || new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
}

export function viewCounts(tasks = [], now = Date.now()) {
  const open = tasks.filter((t) => !DONE_STATUSES.includes(t.status))
  return Object.fromEntries(Object.entries(TASK_VIEWS).map(([k, v]) => [k, open.filter((t) => v.match(t, now)).length]))
}

export function distanceM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(Number(v)))) return null
  const R = 6371000
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

export const fmtDistance = (m) => (m == null ? '—' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`)

export function getPosition(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve(null); return }
    const timer = setTimeout(() => resolve(null), timeoutMs + 500)
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(timer); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }) },
      () => { clearTimeout(timer); resolve(null) },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 },
    )
  })
}

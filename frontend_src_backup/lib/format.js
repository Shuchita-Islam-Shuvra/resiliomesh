export const ROLE_LABEL = {
  citizen: 'Citizen',
  city_officer: 'Water Resilience Officer',
  ngo_coordinator: 'NGO Coordinator',
  field_worker: 'Field Worker',
  admin: 'System Admin',
}

export const CATEGORY_LABEL = {
  waterlogging: 'Waterlogging',
  blocked_drain: 'Blocked drain',
  overflow: 'Drain overflow',
  road_flooded: 'Road flooded',
  relief_need: 'Relief needed',
}

export const RESOURCE_LABEL = {
  pump: 'Dewatering pump', crew: 'Maintenance crew', relief_kit: 'Relief kit', boat: 'Rescue boat',
  sandbag: 'Sandbags', water_tank: 'Water tank', medical_kit: 'Medical kit',
}

export const RISK_COLOR = { low: '#16a34a', moderate: '#ca8a04', high: '#ea580c', critical: '#dc2626' }

export const STATUS_STYLE = {
  reported: 'bg-slate-100 text-slate-700 ring-slate-300',
  verified: 'bg-sky-50 text-sky-700 ring-sky-300',
  assessed: 'bg-indigo-50 text-indigo-700 ring-indigo-300',
  approved: 'bg-violet-50 text-violet-700 ring-violet-300',
  in_progress: 'bg-amber-50 text-amber-800 ring-amber-300',
  resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-300',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-300',
  duplicate: 'bg-zinc-100 text-zinc-600 ring-zinc-300',
  reserved: 'bg-amber-50 text-amber-800 ring-amber-300',
  dispatched: 'bg-sky-50 text-sky-700 ring-sky-300',
  consumed: 'bg-emerald-50 text-emerald-700 ring-emerald-300',
  released: 'bg-zinc-100 text-zinc-600 ring-zinc-300',
  pending: 'bg-slate-100 text-slate-700 ring-slate-300',
  assigned: 'bg-sky-50 text-sky-700 ring-sky-300',
  accepted: 'bg-indigo-50 text-indigo-700 ring-indigo-300',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-300',
  failed: 'bg-rose-50 text-rose-700 ring-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-600 ring-zinc-300',
  pending_approval: 'bg-amber-50 text-amber-800 ring-amber-300',
  executing: 'bg-sky-50 text-sky-700 ring-sky-300',
  executed: 'bg-emerald-50 text-emerald-700 ring-emerald-300',
  superseded: 'bg-zinc-100 text-zinc-600 ring-zinc-300',
  queued: 'bg-slate-100 text-slate-700 ring-slate-300',
  running: 'bg-sky-50 text-sky-700 ring-sky-300',
  retrying: 'bg-amber-50 text-amber-800 ring-amber-300',
  succeeded: 'bg-emerald-50 text-emerald-700 ring-emerald-300',
  compensating: 'bg-orange-50 text-orange-700 ring-orange-300',
  compensated: 'bg-orange-50 text-orange-700 ring-orange-300',
  open: 'bg-sky-50 text-sky-700 ring-sky-300',
  partially_fulfilled: 'bg-amber-50 text-amber-800 ring-amber-300',
  fulfilled: 'bg-emerald-50 text-emerald-700 ring-emerald-300',
}

export const humanize = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—')

export function timeAgo(date) {
  if (!date) return '—'
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

export const fmtNum = (n, digits = 0) =>
  n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits })

export const uuid = () =>
  globalThis.crypto?.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

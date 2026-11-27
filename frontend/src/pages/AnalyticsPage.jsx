import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, Boxes, CalendarRange, CheckCircle2, CloudRain, Copy, Database, Download, Gauge, HandHeart, Layers, MapPinned, Timer, Upload } from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Alert, Button, Card, PageHeader, Select, Spinner, StatCard } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { areaLabel } from '../lib/areas'
import { CATEGORY_LABEL, RESOURCE_LABEL, RISK_COLOR, fmtNum, humanize } from '../lib/format'
import { supabase } from '../lib/supabase'

const STATUS_COLOR = {
  reported: '#94a3b8', verified: '#0ea5e9', assessed: '#6366f1', approved: '#8b5cf6',
  in_progress: '#f59e0b', resolved: '#10b981', rejected: '#f43f5e', duplicate: '#a1a1aa',
}
const CAT_COLOR = ['#0f766e', '#0284c7', '#d97706', '#dc2626', '#7c3aed']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// One colour per relief item; "asked for" is an outlined light bar, "delivered" the solid one.
const RESOURCE_COLOR = {
  relief_kit: '#f59e0b', medical_kit: '#e11d48', water_tank: '#0ea5e9', sandbag: '#65a30d',
  boat: '#8b5cf6', pump: '#14b8a6', crew: '#6366f1',
}
const ASKED_OPACITY = 0.2
const AXIS = { fontSize: 11, fill: 'var(--color-slate-500)' }
// Numbers printed on bars: slate-700 is dark grey in light mode and near-white in dark mode.
const VALUE_LABEL = { fill: 'var(--color-slate-700)', fillOpacity: 1, stroke: 'none', fontSize: 11, fontWeight: 600 }
const round = (v) => (v === null || v === undefined ? '' : Math.round(v))
const GRID = <CartesianGrid strokeDasharray="3 3" stroke="var(--color-slate-200)" vertical={false} />

function ChartTip({ active, payload, label, labelFmt }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <p className="mb-1 font-semibold text-slate-800">{labelFmt ? labelFmt(label) : label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-slate-600">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.payload?.fill }} />
          {p.name}: <strong className="text-slate-900">{fmtNum(p.value, 1)}</strong>
        </p>
      ))}
    </div>
  )
}

const ChartBox = ({ h = 'h-72', children }) => <div className={`${h} w-full min-w-0`}>{children}</div>
const Empty = ({ text = 'No data in this window' }) => <div className="flex h-full items-center justify-center text-sm text-slate-400">{text}</div>

export default function AnalyticsPage() {
  const { hasRole, area } = useAuth()
  const toast = useToast()
  const [days, setDays] = useState(30)
  const [ward, setWard] = useState('')
  const [wards, setWards] = useState([])
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [ms, setMs] = useState(null)
  const [loading, setLoading] = useState(false)
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const t0 = performance.now()
    const { data, error } = await supabase.rpc('analytics_dashboard', { p_days: Number(days), p_ward: ward || null })
    setMs(Math.round(performance.now() - t0))
    setLoading(false)
    if (error) setErr(errorMessage(error)); else { setErr(''); setD(data) }
  }, [days, ward])
  useEffect(() => { load() }, [load])
  useEffect(() => { supabase.from('wards').select('id,name,city_corporation').order('name').then(({ data }) => setWards(data || [])) }, [])

  const statusData = useMemo(() => Object.entries(d?.by_status || {}).map(([k, v]) => ({ key: k, name: humanize(k), value: v })), [d])
  const statusTotal = statusData.reduce((s, x) => s + x.value, 0)
  const monthly = useMemo(() => (d?.historical?.monthly || []).map((m) => ({ ...m, label: MONTHS[m.month - 1] })), [d])
  const byWard = useMemo(() => (d?.by_ward || []).slice().sort((a, b) => (b.current_risk_score || 0) - (a.current_risk_score || 0)).slice(0, 12), [d])
  // Fixed incident scale, so a risk-score label can be lifted clear of the incidents line where they meet.
  const incidentMax = Math.max(4, Math.ceil(Math.max(0, ...byWard.map((w) => w.incidents || 0)) * 1.2))
  const daily = d?.daily || []
  // officers only see their own area: offer only those wards
  const wardOptions = useMemo(() => (hasRole('city_officer') && area ? wards.filter((w) => w.city_corporation === area) : wards), [wards, area, hasRole])
  const scopeLabel = ward ? (wards.find((w) => w.id === ward)?.name || 'this ward') : hasRole('city_officer') ? areaLabel(area) : 'All Dhaka'
  const relief = d?.relief || {}
  const reliefByType = (relief.by_type || []).map((x) => ({ ...x, label: RESOURCE_LABEL[x.need_type] || humanize(x.need_type), color: RESOURCE_COLOR[x.need_type] || '#64748b' }))
  const workflowData = Object.entries(d?.workflows || {}).map(([k, v]) => ({ key: k, name: humanize(k), value: v }))
  const isNgo = hasRole('ngo_coordinator')
  const hasDaily = daily.some((x) => x.reported || x.resolved)

  const exportCsv = () => {
    const rows = [['ward_id', 'name', 'incidents', 'avg_risk', 'high_risk', 'current_risk_score'], ...(d?.by_ward || []).map((w) => [w.ward_id, w.name, w.incidents, w.avg_risk ?? '', w.high_risk, w.current_risk_score ?? ''])]
    const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `resiliomesh-wards-${days}d.csv`; a.click()
    URL.revokeObjectURL(a.href)
  }

  const doImport = async () => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) { toast.error('Please choose a .csv file'); return }
    setImporting(true); setReport(null)
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await api('/api/analytics/import', { method: 'POST', form: fd, timeoutMs: 180000 })
      setReport(r); toast.success(`${fmtNum(r.inserted)} new records imported`); load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setImporting(false) }
  }

  if (!d && !err) return <Spinner label="Aggregating analytics…" />
  const t = d?.totals || {}

  return (
    <>
      <PageHeader eyebrow="Intelligence" title="Advanced analytics"
        description={`${scopeLabel} · last ${days} days (Dhaka time). Live operations, plus ${fmtNum(d?.historical?.total_records)} simulated historical flood records for trends.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="an-days">Time window</label>
            <Select id="an-days" value={days} onChange={(e) => setDays(e.target.value)} className="!w-auto"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></Select>
            <label className="sr-only" htmlFor="an-ward">Ward</label>
            <Select id="an-ward" value={ward} onChange={(e) => setWard(e.target.value)} className="!w-auto max-w-[200px]"><option value="">All wards</option>{wardOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
            <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" />Export</Button>
          </div>
        }>
        {ms !== null && <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600"><Gauge className="h-3.5 w-3.5" aria-hidden />Computed in {ms} ms{loading ? ' · refreshing…' : ''}</p>}
      </PageHeader>
      {err && <Alert tone="error" className="mb-4">{err}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard index={0} label="New reports" value={t.reports ?? 0} hint="In this period, duplicates left out" icon={Activity} />
        <StatCard index={1} label="Open now" value={t.open_now ?? 0} hint="Every open report, however old" icon={Layers} tone="sky" />
        <StatCard index={2} label="Resolved" value={t.resolved ?? 0} hint={t.resolution_rate != null ? `In this period · ${t.resolution_rate}% of its genuine reports done` : 'In this period'} icon={CheckCircle2} tone="green" />
        <StatCard index={3} label="Duplicates merged" value={t.duplicates ?? 0} hint={`${t.rejected ?? 0} rejected as false`} icon={Copy} tone="violet" />
        <StatCard index={4} label="Avg risk" value={t.avg_risk ?? '—'} decimals={1} hint="Of this period's reports" icon={Gauge} tone="amber" />
        <StatCard index={5} label="Avg resolution" value={t.avg_resolution_hours ?? '—'} decimals={1} suffix=" h" hint={`Report to resolved · P90 ${t.p90_resolution_hours ?? '—'} h`} icon={Timer} tone="red" />
      </div>

      {isNgo && <ReliefSection relief={relief} data={reliefByType} className="mt-5" />}

      <div className="mt-5 grid gap-5">
        <Card index={1} icon={CalendarRange} title="Daily reports vs resolutions" subtitle={`${scopeLabel} · Dhaka days · a report counts on the day it came in, a resolution on the day it was resolved`}>
          <ChartBox h="h-72">
            {!hasDaily ? <Empty text="No reports in this window — try a longer period" /> : (
              <ResponsiveContainer>
                <AreaChart data={daily} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gRep" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.35} /><stop offset="100%" stopColor="#0ea5e9" stopOpacity={0} /></linearGradient>
                    <linearGradient id="gRes" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.35} /><stop offset="100%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                  </defs>
                  {GRID}
                  <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => v.slice(5)} minTickGap={20} />
                  <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTip />} />
                  <Area type="monotone" dataKey="reported" name="Reported" stroke="#0284c7" strokeWidth={2} fill="url(#gRep)" animationDuration={900} />
                  <Area type="monotone" dataKey="resolved" name="Resolved" stroke="#059669" strokeWidth={2} fill="url(#gRes)" animationDuration={900} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </ChartBox>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card index={2} icon={Layers} title="Status mix" subtitle="This period's reports, by where they are now (duplicates included)">
            <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <ChartBox h="h-56">
                {!statusTotal ? <Empty /> : (
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={statusData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={2} stroke="none" animationDuration={900}>
                        {statusData.map((s) => <Cell key={s.key} fill={STATUS_COLOR[s.key] || '#94a3b8'} />)}
                      </Pie>
                      <Tooltip content={<ChartTip />} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </ChartBox>
              <ul className="space-y-1.5 text-sm">
                {statusData.sort((a, b) => b.value - a.value).map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-slate-600"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[s.key] }} />{s.name}</span>
                    <span className="tabular-nums text-slate-900"><strong>{s.value}</strong> <span className="text-xs text-slate-400">{Math.round((100 * s.value) / statusTotal)}%</span></span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card index={3} icon={BarChart3} title="Reports by category" subtitle="This period, duplicates left out">
            <ChartBox h="h-56">
              {!(d?.by_category || []).length ? <Empty /> : (
                <ResponsiveContainer>
                  <BarChart data={(d?.by_category || []).map((c) => ({ ...c, label: CATEGORY_LABEL[c.category] }))} layout="vertical" margin={{ top: 4, right: 32, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-slate-200)" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="label" width={110} tick={AXIS} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--color-slate-100)' }} />
                    <Bar dataKey="count" name="Reports" radius={[0, 6, 6, 0]} barSize={18} animationDuration={900}>
                      {(d?.by_category || []).map((c, i) => <Cell key={c.category} fill={CAT_COLOR[i % CAT_COLOR.length]} />)}
                      <LabelList dataKey="count" position="right" style={VALUE_LABEL} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartBox>
          </Card>
        </div>

        <Card index={4} icon={MapPinned} title="Ward risk vs incident load" subtitle="Top 12 wards by current AI risk score">
          <ChartBox h="h-80">
            <ResponsiveContainer>
              <ComposedChart data={byWard} margin={{ top: 20, right: 4, left: -18, bottom: 0 }}>
                {GRID}
                <XAxis dataKey="name" tick={{ ...AXIS, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} angle={-35} textAnchor="end" height={70} />
                <YAxis yAxisId="l" domain={[0, incidentMax]} allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={AXIS} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--color-slate-100)' }} />
                <Bar yAxisId="r" dataKey="current_risk_score" name="Ward risk" radius={[6, 6, 0, 0]} barSize={22} animationDuration={900}>
                  {byWard.map((w) => {
                    const s = w.current_risk_score || 0
                    return <Cell key={w.ward_id} fill={RISK_COLOR[s >= 75 ? 'critical' : s >= 55 ? 'high' : s >= 35 ? 'moderate' : 'low']} fillOpacity={0.85} />
                  })}
                  <LabelList dataKey="current_risk_score" content={<WardScoreLabel wards={byWard} incidentMax={incidentMax} />} />
                </Bar>
                <Line yAxisId="l" type="monotone" dataKey="incidents" name="Incidents" stroke="var(--color-slate-900)" strokeWidth={2} dot={{ r: 3 }} animationDuration={900} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartBox>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
            {Object.entries(RISK_COLOR).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded" style={{ background: c }} />{humanize(k)} risk</span>)}
            <span className="inline-flex items-center gap-1"><span className="h-0.5 w-4 bg-slate-900" />Incidents</span>
          </div>
        </Card>

        <div className="grid gap-5 xl:grid-cols-5">
          <Card index={5} icon={CloudRain} title="Monsoon seasonality" subtitle={`${scopeLabel} · ${fmtNum(d?.historical?.total_records)} simulated events · count and mean rainfall per month`} className="xl:col-span-3">
            <ChartBox h="h-72">
              <ResponsiveContainer>
                <ComposedChart data={monthly} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <defs><linearGradient id="gEv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0284c7" /><stop offset="100%" stopColor="#7dd3fc" /></linearGradient></defs>
                  {GRID}
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="l" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="r" orientation="right" tick={AXIS} tickLine={false} axisLine={false} unit=" mm" width={56} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--color-slate-100)' }} />
                  <Bar yAxisId="l" dataKey="events" name="Events" fill="url(#gEv)" radius={[6, 6, 0, 0]} animationDuration={900} />
                  <Line yAxisId="r" type="monotone" dataKey="avg_rainfall_mm" name="Avg rainfall (mm)" stroke="#d97706" strokeWidth={2.5} dot={false} animationDuration={900} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartBox>
          </Card>
          <Card index={6} icon={CalendarRange} title="Events per year" subtitle={`${scopeLabel} · simulated historical record`} className="xl:col-span-2">
            <ChartBox h="h-72">
              <ResponsiveContainer>
                <BarChart data={d?.historical?.yearly || []} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <defs><linearGradient id="gYr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c3aed" /><stop offset="100%" stopColor="#c4b5fd" /></linearGradient></defs>
                  {GRID}
                  <XAxis dataKey="year" tick={AXIS} tickLine={false} axisLine={false} minTickGap={8} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--color-slate-100)' }} />
                  <Bar dataKey="events" name="Events" fill="url(#gYr)" radius={[6, 6, 0, 0]} animationDuration={900} />
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>
          </Card>
        </div>
        {d?.historical?.synthetic && (
          <p className="-mt-2 text-xs text-slate-500">
            The two charts above use simulated history: no open, ward-level waterlogging record exists for Dhaka, so it was generated from Dhaka's monthly rainfall climatology (see README, "Data &amp; limitations"). Import real records below to replace it.
          </p>
        )}

        {!isNgo && <ReliefSection relief={relief} data={reliefByType} />}

        <Card index={8} icon={Boxes} title="Stock & dispatch" subtitle={isNgo ? "Your NGO's stock, and dispatch runs in this period" : hasRole('admin') ? 'All stock, and dispatch runs in this period' : 'Your authority and its area, and dispatch runs in this period'}>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">In use right now</p>
              {!(d?.resources || []).length ? <p className="text-sm text-slate-400">No stock registered.</p> : (
                <ul className="space-y-2.5">
                  {d.resources.map((r) => (
                    <li key={r.resource_type}>
                      <div className="flex justify-between gap-2 text-sm"><span className="text-slate-700">{RESOURCE_LABEL[r.resource_type] || humanize(r.resource_type)}</span><span className="tabular-nums text-slate-500">{fmtNum(r.total - r.available)} of {fmtNum(r.total)} out · {r.utilization_pct ?? 0}%</span></div>
                      <div className="mt-1 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-brand-600" style={{ width: `${Math.min(100, r.utilization_pct || 0)}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Dispatch workflows</p>
              {!workflowData.length ? <p className="text-sm text-slate-400">No dispatch runs in this period.</p> : (
                <ul className="space-y-1.5 text-sm">
                  {workflowData.sort((a, b) => b.value - a.value).map((w) => (
                    <li key={w.key} className="flex justify-between"><span className="text-slate-600">{w.name}</span><strong className="tabular-nums">{w.value}</strong></li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        {hasRole('admin', 'city_officer') && (
          <Card index={7} icon={Database} title="Bulk historical import"
            subtitle="CSV: ward_id, event_date, rainfall_mm, max_depth_cm, duration_hr, households_affected · duplicates, invalid rows and missing values are handled automatically">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-700 transition hover:border-brand-500 hover:bg-brand-50">
                <Upload className="h-4 w-4" aria-hidden /><span className="max-w-[240px] truncate">{file ? file.name : 'Choose CSV file…'}</span>
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
              <Button loading={importing} disabled={!file} onClick={doImport}><Database className="h-4 w-4" />{importing ? 'Importing…' : 'Import'}</Button>
              <span className="text-xs text-slate-500">Try <code className="rounded bg-slate-100 px-1">data/bulk_import_sample.csv</code> (~125k rows with injected duplicates & gaps)</span>
            </div>
            {report && (
              <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
                {[['Rows read', report.rows_read, 'text-slate-900'], ['Invalid rejected', report.rejected_invalid_key, 'text-rose-600'], ['Duplicates in file', report.duplicates_in_file, 'text-violet-600'],
                  ['Already in DB', report.duplicates_existing_in_db, 'text-violet-600'], ['Inserted', report.inserted, 'text-emerald-600'],
                  ['Missing imputed', Object.values(report.missing_values_imputed).reduce((a, b) => a + b, 0), 'text-amber-600'], ['Total time', `${report.total_ms} ms`, 'text-slate-900']].map(([k, v, c]) => (
                  <div key={k} className="rounded-xl border border-slate-100 bg-slate-50 p-3"><dt className="text-xs text-slate-500">{k}</dt><dd className={`text-lg font-bold ${c}`}>{typeof v === 'number' ? fmtNum(v) : v}</dd></div>
                ))}
              </dl>
            )}
          </Card>
        )}
      </div>
    </>
  )
}

// Risk score above a ward's bar. Where the incidents line crosses that spot, the number moves just above the line's dot.
function WardScoreLabel({ x, y, width, height, value, index, wards, incidentMax }) {
  if (value === null || value === undefined) return null
  let labelY = y - 6
  const base = y + height
  if (value > 0 && height > 0) {
    const plotHeight = (height * 100) / value
    const lineY = base - (plotHeight * (wards[index]?.incidents || 0)) / incidentMax
    if (labelY > lineY - 14 && labelY < lineY + 10) labelY = lineY - 10
  }
  return <text x={x + width / 2} y={labelY} textAnchor="middle" style={VALUE_LABEL}>{round(value)}</text>
}

function ReliefTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  return (
    <div className="rounded-xl border border-slate-200 bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <p className="mb-1 font-semibold text-slate-800">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-slate-600">
          <span className="h-2 w-2 rounded-full" style={{ background: item.color, opacity: p.dataKey === 'requested' ? ASKED_OPACITY : 1 }} />
          {p.name}: <strong className="text-slate-900">{fmtNum(p.value, 1)}</strong>
        </p>
      ))}
    </div>
  )
}

function ReliefSection({ relief, data, className = '' }) {
  const pct = relief.units_requested ? Math.round((100 * relief.units_delivered) / relief.units_requested) : null
  return (
    <Card index={7} icon={HandHeart} className={className} title="Relief for people (NGO)"
      subtitle="Community needs in this period: what was asked for, what reached people, how fast">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Needs logged" value={relief.needs_logged ?? 0} hint={`${relief.duplicates_blocked ?? 0} duplicates blocked`} />
        <StatCard label="Open now" value={relief.needs_open_now ?? 0} hint={`${relief.awaiting_confirmation ?? 0} waiting for confirmation`} tone="sky" />
        <StatCard label="Households waiting" value={relief.households_waiting ?? 0} tone="amber" />
        <StatCard label="Households served" value={relief.households_served ?? 0} hint={`${relief.needs_fulfilled ?? 0} needs fully met`} tone="green" />
        <StatCard label="Units delivered" value={relief.units_delivered ?? 0} hint={pct != null ? `${pct}% of ${fmtNum(relief.units_requested)} asked for` : 'Nothing asked for yet'} tone="violet" />
        <StatCard label="Time to first relief" value={relief.avg_hours_to_first_relief ?? '—'} decimals={1} suffix=" h" hint="Need logged to first stock reserved" tone="red" />
      </div>
      <div className="mt-4 h-64 w-full min-w-0">
        {!data.length ? <Empty text="No relief needs in this period" /> : (
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 20, right: 4, left: -18, bottom: 0 }}>
              {GRID}
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
              <Tooltip content={<ReliefTip />} cursor={{ fill: 'var(--color-slate-100)' }} />
              <Bar dataKey="requested" name="Asked for" radius={[6, 6, 0, 0]} animationDuration={900}>
                {data.map((x) => <Cell key={x.need_type} fill={x.color} fillOpacity={ASKED_OPACITY} stroke={x.color} strokeWidth={2} />)}
                <LabelList dataKey="requested" position="top" style={VALUE_LABEL} />
              </Bar>
              <Bar dataKey="delivered" name="Delivered" radius={[6, 6, 0, 0]} animationDuration={900}>
                {data.map((x) => <Cell key={x.need_type} fill={x.color} />)}
                <LabelList dataKey="delivered" position="top" style={VALUE_LABEL} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {data.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          {data.map((x) => (
            <span key={x.need_type} className="inline-flex items-center gap-1.5">
              <span className="flex" aria-hidden>
                <span className="h-3 w-3 rounded-l-sm border-2" style={{ borderColor: x.color, background: `${x.color}33` }} />
                <span className="h-3 w-3 rounded-r-sm" style={{ background: x.color }} />
              </span>
              {x.label}
            </span>
          ))}
          <span className="text-slate-400">Outlined bar = asked for · Solid bar = delivered</span>
        </div>
      )}
    </Card>
  )
}

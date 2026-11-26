import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, CalendarRange, CheckCircle2, CloudRain, Copy, Database, Download, Gauge, Layers, MapPinned, Timer, Upload } from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Alert, Button, Card, PageHeader, Select, Spinner, StatCard } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { CATEGORY_LABEL, RISK_COLOR, fmtNum, humanize } from '../lib/format'
import { supabase } from '../lib/supabase'

const STATUS_COLOR = {
  reported: '#94a3b8', verified: '#0ea5e9', assessed: '#6366f1', approved: '#8b5cf6',
  in_progress: '#f59e0b', resolved: '#10b981', rejected: '#f43f5e', duplicate: '#a1a1aa',
}
const CAT_COLOR = ['#0f766e', '#0284c7', '#d97706', '#dc2626', '#7c3aed']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const AXIS = { fontSize: 11, fill: '#64748b' }
const GRID = <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />

function ChartTip({ active, payload, label, labelFmt }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
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
  const { hasRole } = useAuth()
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
  useEffect(() => { supabase.from('wards').select('id,name').order('name').then(({ data }) => setWards(data || [])) }, [])

  const statusData = useMemo(() => Object.entries(d?.by_status || {}).map(([k, v]) => ({ key: k, name: humanize(k), value: v })), [d])
  const statusTotal = statusData.reduce((s, x) => s + x.value, 0)
  const monthly = useMemo(() => (d?.historical?.monthly || []).map((m) => ({ ...m, label: MONTHS[m.month - 1] })), [d])
  const byWard = useMemo(() => (d?.by_ward || []).slice().sort((a, b) => (b.current_risk_score || 0) - (a.current_risk_score || 0)).slice(0, 12), [d])
  const daily = d?.daily || []
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
  const resolutionRate = t.incidents ? Math.round((100 * (t.resolved || 0)) / Math.max(1, t.incidents - (t.duplicates || 0))) : 0

  return (
    <>
      <PageHeader eyebrow="Intelligence" title="Advanced analytics"
        description={`Server-side aggregation over live operations and ${fmtNum(d?.historical?.total_records)} historical flood records.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="an-days">Time window</label>
            <Select id="an-days" value={days} onChange={(e) => setDays(e.target.value)} className="!w-auto"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></Select>
            <label className="sr-only" htmlFor="an-ward">Ward</label>
            <Select id="an-ward" value={ward} onChange={(e) => setWard(e.target.value)} className="!w-auto max-w-[200px]"><option value="">All wards</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
            <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" />Export</Button>
          </div>
        }>
        {ms !== null && <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600"><Gauge className="h-3.5 w-3.5" aria-hidden />Computed in {ms} ms{loading ? ' · refreshing…' : ''}</p>}
      </PageHeader>
      {err && <Alert tone="error" className="mb-4">{err}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard index={0} label="Incidents" value={t.incidents ?? 0} icon={Activity} />
        <StatCard index={1} label="Active now" value={t.active ?? 0} icon={Layers} tone="sky" />
        <StatCard index={2} label="Resolved" value={t.resolved ?? 0} hint={`${resolutionRate}% resolution rate`} icon={CheckCircle2} tone="green" />
        <StatCard index={3} label="Duplicates merged" value={t.duplicates ?? 0} icon={Copy} tone="violet" />
        <StatCard index={4} label="Avg risk" value={t.avg_risk ?? '—'} decimals={1} icon={Gauge} tone="amber" />
        <StatCard index={5} label="Avg resolution" value={t.avg_resolution_hours ?? '—'} decimals={1} suffix=" h" hint={`P90 ${t.p90_resolution_hours ?? '—'} h`} icon={Timer} tone="red" />
      </div>

      <div className="mt-5 grid gap-5">
        <Card index={1} icon={CalendarRange} title="Daily reports vs resolutions" subtitle={`Last ${days} days${ward ? ' · filtered ward' : ''}`}>
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
          <Card index={2} icon={Layers} title="Status mix" subtitle="Where incidents are in the workflow">
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

          <Card index={3} icon={BarChart3} title="Reports by category" subtitle="Excluding duplicates">
            <ChartBox h="h-56">
              {!(d?.by_category || []).length ? <Empty /> : (
                <ResponsiveContainer>
                  <BarChart data={(d?.by_category || []).map((c) => ({ ...c, label: CATEGORY_LABEL[c.category] }))} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="label" width={110} tick={AXIS} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip />} cursor={{ fill: '#f1f5f9' }} />
                    <Bar dataKey="count" name="Reports" radius={[0, 6, 6, 0]} barSize={18} animationDuration={900}>
                      {(d?.by_category || []).map((c, i) => <Cell key={c.category} fill={CAT_COLOR[i % CAT_COLOR.length]} />)}
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
              <ComposedChart data={byWard} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                {GRID}
                <XAxis dataKey="name" tick={{ ...AXIS, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} angle={-35} textAnchor="end" height={70} />
                <YAxis yAxisId="l" allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={AXIS} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTip />} cursor={{ fill: '#f1f5f9' }} />
                <Bar yAxisId="r" dataKey="current_risk_score" name="Ward risk" radius={[6, 6, 0, 0]} barSize={22} animationDuration={900}>
                  {byWard.map((w) => {
                    const s = w.current_risk_score || 0
                    return <Cell key={w.ward_id} fill={RISK_COLOR[s >= 75 ? 'critical' : s >= 55 ? 'high' : s >= 35 ? 'moderate' : 'low']} fillOpacity={0.85} />
                  })}
                </Bar>
                <Line yAxisId="l" type="monotone" dataKey="incidents" name="Incidents" stroke="#0f172a" strokeWidth={2} dot={{ r: 3 }} animationDuration={900} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartBox>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
            {Object.entries(RISK_COLOR).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded" style={{ background: c }} />{humanize(k)} risk</span>)}
            <span className="inline-flex items-center gap-1"><span className="h-0.5 w-4 bg-slate-900" />Incidents</span>
          </div>
        </Card>

        <div className="grid gap-5 xl:grid-cols-5">
          <Card index={5} icon={CloudRain} title="Monsoon seasonality" subtitle={`${fmtNum(d?.historical?.total_records)} historical events · count and mean rainfall per month`} className="xl:col-span-3">
            <ChartBox h="h-72">
              <ResponsiveContainer>
                <ComposedChart data={monthly} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <defs><linearGradient id="gEv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0284c7" /><stop offset="100%" stopColor="#7dd3fc" /></linearGradient></defs>
                  {GRID}
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="l" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="r" orientation="right" tick={AXIS} tickLine={false} axisLine={false} unit=" mm" width={56} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: '#f1f5f9' }} />
                  <Bar yAxisId="l" dataKey="events" name="Events" fill="url(#gEv)" radius={[6, 6, 0, 0]} animationDuration={900} />
                  <Line yAxisId="r" type="monotone" dataKey="avg_rainfall_mm" name="Avg rainfall (mm)" stroke="#d97706" strokeWidth={2.5} dot={false} animationDuration={900} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartBox>
          </Card>
          <Card index={6} icon={CalendarRange} title="Events per year" subtitle="All wards, historical record" className="xl:col-span-2">
            <ChartBox h="h-72">
              <ResponsiveContainer>
                <BarChart data={d?.historical?.yearly || []} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <defs><linearGradient id="gYr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c3aed" /><stop offset="100%" stopColor="#c4b5fd" /></linearGradient></defs>
                  {GRID}
                  <XAxis dataKey="year" tick={AXIS} tickLine={false} axisLine={false} minTickGap={8} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: '#f1f5f9' }} />
                  <Bar dataKey="events" name="Events" fill="url(#gYr)" radius={[6, 6, 0, 0]} animationDuration={900} />
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>
          </Card>
        </div>

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

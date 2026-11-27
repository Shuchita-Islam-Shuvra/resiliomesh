import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Activity, BrainCircuit, CloudRain, FlaskConical, RefreshCw, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Alert, AnimatedNumber, Button, Card, PageHeader, RiskBadge, Skeleton } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { areaLabel } from '../lib/areas'
import { errorMessage } from '../lib/errors'
import { RISK_COLOR } from '../lib/format'

const GROUPS = [
  { title: 'Rainfall', items: [['rain_past_24h_mm', 0, 250, 1, 'mm'], ['rain_next_24h_mm', 0, 300, 1, 'mm'], ['max_hourly_mm', 0, 120, 1, 'mm/h']] },
  { title: 'Drainage & terrain', items: [['drainage_capacity_mm_hr', 10, 50, 1, 'mm/h'], ['impervious_pct', 50, 100, 1, '%'], ['elevation_m', 3, 9, 0.1, 'm'], ['asset_condition', 0, 100, 1, '/100'], ['blocked_assets', 0, 8, 1, '']] },
  { title: 'History & signals', items: [['historical_events_10y', 0, 60, 1, ''], ['recent_reports_6h', 0, 10, 1, '']] },
]
const FACTOR_GROUPS = [
  { key: 'weather', label: 'Weather & season', color: '#2a78d6', features: ['rain_past_24h_mm', 'rain_next_24h_mm', 'max_hourly_mm', 'monsoon'] },
  { key: 'drainage', label: 'Drainage & terrain', color: '#eb6834', features: ['drainage_capacity_mm_hr', 'impervious_pct', 'elevation_m', 'asset_condition', 'blocked_assets'] },
  { key: 'history', label: 'History & signals', color: '#1baf7a', features: ['historical_events_10y', 'recent_reports_6h'] },
]
const groupOf = (feature) => FACTOR_GROUPS.find((g) => g.features.includes(feature)) || { label: 'Other', color: '#64748b' }
const PRESETS = {
  'Dry day': { rain_past_24h_mm: 0, rain_next_24h_mm: 0, max_hourly_mm: 0, depth: 0 },
  'Normal monsoon': { rain_past_24h_mm: 35, rain_next_24h_mm: 45, max_hourly_mm: 14, depth: 15 },
  'Cloudburst': { rain_past_24h_mm: 140, rain_next_24h_mm: 220, max_hourly_mm: 85, depth: 70 },
}

function Gauge({ score, level }) {
  const r = 70, c = Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  return (
    <svg viewBox="0 0 180 110" className="mx-auto w-full max-w-[260px]" role="img" aria-label={`Risk score ${score.toFixed(1)}, ${level}`}>
      <defs>
        <linearGradient id="gauge" x1="0" x2="1">
          <stop offset="0%" stopColor={RISK_COLOR.low} /><stop offset="40%" stopColor={RISK_COLOR.moderate} />
          <stop offset="70%" stopColor={RISK_COLOR.high} /><stop offset="100%" stopColor={RISK_COLOR.critical} />
        </linearGradient>
      </defs>
      <path d="M20 95 A70 70 0 0 1 160 95" fill="none" stroke="var(--color-slate-200)" strokeWidth="14" strokeLinecap="round" />
      <motion.path d="M20 95 A70 70 0 0 1 160 95" fill="none" stroke="url(#gauge)" strokeWidth="14" strokeLinecap="round"
        strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pct) }} transition={{ type: 'spring', stiffness: 80, damping: 18 }} />
      <text x="90" y="82" textAnchor="middle" className="fill-slate-900" style={{ fontSize: 30, fontWeight: 800 }}>{score.toFixed(1)}</text>
      <text x="90" y="102" textAnchor="middle" className="fill-slate-500" style={{ fontSize: 10 }}>out of 100</text>
    </svg>
  )
}

export default function RiskAnalysisPage() {
  const { hasRole, area } = useAuth()
  const rescoreLabel = `Re-score ${area ? `${areaLabel(area)} wards` : 'all wards'} with live weather`
  const toast = useToast()
  const [model, setModel] = useState(null)
  const [modelErr, setModelErr] = useState('')
  const [wx, setWx] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshOut, setRefreshOut] = useState(null)
  const [f, setF] = useState({ rain_past_24h_mm: 40, rain_next_24h_mm: 90, max_hourly_mm: 32, drainage_capacity_mm_hr: 22, impervious_pct: 90, elevation_m: 4.9, asset_condition: 35, blocked_assets: 2, historical_events_10y: 45, recent_reports_6h: 2, monsoon: 1 })
  const [ctx, setCtx] = useState({ water_depth_cm: 30 })
  const [sim, setSim] = useState(null)

  useEffect(() => {
    api('/api/risk/model').then(setModel).catch((e) => setModelErr(e.message))
    api('/api/weather/status').then(setWx).catch(() => {})
  }, [])
  useEffect(() => {
    const t = setTimeout(() => api('/api/risk/simulate', { method: 'POST', body: { features: f, context: ctx } }).then(setSim).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [f, ctx])

  const refresh = async () => {
    setRefreshing(true)
    try {
      const r = await api('/api/risk/wards/refresh', { method: 'POST', timeoutMs: 60000 })
      setRefreshOut(r)
      toast.success(`${r.updated} wards re-scored${r.degraded_weather ? ` (${r.degraded_weather} with fallback weather)` : ''}`)
      api('/api/weather/status').then(setWx).catch(() => {})
    } catch (e) { toast.error(errorMessage(e)) } finally { setRefreshing(false) }
  }
  const preset = (p) => { const { depth, ...rest } = PRESETS[p]; setF({ ...f, ...rest }); setCtx({ water_depth_cm: depth }) }
  const maxAbs = sim ? Math.max(...sim.contributions.map((c) => Math.abs(c.contribution)), 1) : 1

  return (
    <>
      <PageHeader eyebrow="Intelligence" title="AI risk analysis"
        description="Gradient-boosted XGBoost model combined with a deterministic safety rule engine. Every score is explained feature by feature (SHAP)."
        actions={hasRole('city_officer', 'admin') && <Button loading={refreshing} onClick={refresh}><RefreshCw className="h-4 w-4" />{rescoreLabel}</Button>} />
      {modelErr && <Alert tone="error" className="mb-4">Backend unavailable: {modelErr}</Alert>}

      <div className="grid gap-5">
        <Card index={0} icon={BrainCircuit} title="Model performance" subtitle={model ? `${model.version} · trained on ${model.metrics.n_train?.toLocaleString()} samples` : 'Loading model…'}>
          {!model ? <Skeleton className="h-56 w-full" /> : (
            <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
              <dl className="grid grid-cols-2 gap-3 content-start">
                {[['MAE (hold-out)', model.metrics.mae, 2, 'Mean absolute error in score points'], ['R²', model.metrics.r2, 3, 'Variance explained'],
                  ['Train rows', model.metrics.n_train, 0], ['Test rows', model.metrics.n_test, 0]].map(([k, v, dec, hint]) => (
                  <div key={k} className="rounded-xl border border-slate-100 bg-gradient-to-br from-slate-50 to-surface p-3" title={hint}>
                    <dt className="text-xs text-slate-500">{k}</dt>
                    <dd className="text-xl font-bold text-slate-900"><AnimatedNumber value={v} decimals={dec} /></dd>
                  </div>
                ))}
                <p className="col-span-2 text-xs leading-relaxed text-slate-500">Hard rules (e.g. ≥ 45 cm standing water is always HIGH) are applied after the model, so a statistical estimate can never under-warn in a clearly dangerous situation.</p>
              </dl>
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Global feature importance (gain)</p>
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600" aria-label="Factor groups">
                    {FACTOR_GROUPS.map((g) => <li key={g.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: g.color }} aria-hidden />{g.label}</li>)}
                  </ul>
                </div>
                <div className="h-72 w-full min-w-0">
                  <ResponsiveContainer>
                    <BarChart data={model.importance} layout="vertical" margin={{ left: 0, right: 24, top: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-slate-200)" />
                      <XAxis type="number" unit="%" tick={{ fontSize: 11, fill: 'var(--color-slate-500)' }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11, fill: 'var(--color-slate-600)' }} tickLine={false} axisLine={false} />
                      <Tooltip cursor={{ fill: 'var(--color-slate-100)' }} formatter={(v, _n, item) => [`${v}%`, `Importance · ${groupOf(item?.payload?.feature).label}`]} />
                      <Bar dataKey="gain_pct" radius={[0, 6, 6, 0]} barSize={14} animationDuration={900}>
                        {model.importance.map((x) => <Cell key={x.feature} fill={groupOf(x.feature).color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card index={1} icon={SlidersHorizontal} title="What-if simulator" subtitle="Change the conditions — the live model and rule engine respond instantly"
          actions={Object.keys(PRESETS).map((p) => <Button key={p} size="sm" variant="secondary" onClick={() => preset(p)}><FlaskConical className="h-3.5 w-3.5" />{p}</Button>)}>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="grid gap-5 md:grid-cols-2">
              {GROUPS.map((g) => (
                <fieldset key={g.title} className="rounded-xl border border-slate-100 p-3">
                  <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.title}</legend>
                  <div className="space-y-3">
                    {g.items.map(([k, min, max, step, unit]) => (
                      <div key={k}>
                        <label htmlFor={`sim-${k}`} className="flex justify-between text-xs text-slate-600"><span>{model?.labels?.[k] || k}</span><span className="font-semibold tabular-nums text-slate-900">{f[k]} {unit}</span></label>
                        <input id={`sim-${k}`} type="range" min={min} max={max} step={step} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} className="w-full accent-brand-700" />
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
              <fieldset className="rounded-xl border border-amber-100 bg-amber-50/40 p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-amber-700">Field report (rule input)</legend>
                <label htmlFor="sim-depth" className="flex justify-between text-xs text-slate-600"><span>Reported water depth</span><span className="font-semibold tabular-nums text-slate-900">{ctx.water_depth_cm} cm</span></label>
                <input id="sim-depth" type="range" min={0} max={150} value={ctx.water_depth_cm} onChange={(e) => setCtx({ ...ctx, water_depth_cm: Number(e.target.value) })} className="w-full accent-amber-600" />
                <label className="mt-3 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" className="h-4 w-4 rounded" checked={f.monsoon === 1} onChange={(e) => setF({ ...f, monsoon: e.target.checked ? 1 : 0 })} />Monsoon season (Jun–Sep)</label>
              </fieldset>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-gradient-to-b from-slate-50 to-surface p-4">
              {!sim ? <Skeleton className="h-72 w-full" /> : (
                <>
                  <Gauge score={sim.score} level={sim.level} />
                  <div className="mt-1 flex justify-center"><motion.div key={sim.level} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><RiskBadge level={sim.level} /></motion.div></div>
                  <p className="mt-2 text-center text-xs text-slate-500">ML estimate {sim.ml_score.toFixed(1)} · model baseline {sim.baseline}</p>
                  <p className="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Top drivers</p>
                  <ul className="space-y-1.5">
                    {sim.contributions.slice(0, 6).map((c) => (
                      <li key={c.feature} className="grid grid-cols-[minmax(0,1fr)_90px_44px] items-center gap-2 text-xs">
                        <span className="truncate text-slate-600">{c.label}</span>
                        <div className="relative h-2 rounded bg-slate-100">
                          <motion.div className={`absolute top-0 h-2 rounded ${c.contribution >= 0 ? 'left-1/2 bg-rose-500' : 'right-1/2 bg-emerald-500'}`}
                            animate={{ width: `${(Math.abs(c.contribution) / maxAbs) * 50}%` }} transition={{ type: 'spring', stiffness: 140, damping: 20 }} />
                        </div>
                        <span className={`text-right font-semibold tabular-nums ${c.contribution >= 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{c.contribution > 0 ? '+' : ''}{c.contribution}</span>
                      </li>
                    ))}
                  </ul>
                  {sim.rules_fired.length > 0 && (
                    <div className="mt-4 space-y-1.5">
                      <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-amber-700"><ShieldAlert className="h-3.5 w-3.5" aria-hidden />Safety rules fired</p>
                      {sim.rules_fired.map((r) => <motion.p key={r.code} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-900"><strong>{r.code}</strong> — {r.description}</motion.p>)}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </Card>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card index={2} icon={Activity} title="Weather API health" subtitle="Open-Meteo · timeout · retries · circuit breaker">
            {!wx ? <Skeleton className="h-40 w-full" /> : (
              <dl className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between"><dt className="text-slate-500">Circuit breaker</dt>
                  <dd className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${wx.breaker === 'closed' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${wx.breaker === 'closed' ? 'bg-emerald-500' : 'bg-rose-500'}`} />{wx.breaker}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Consecutive failures</dt><dd className="font-medium">{wx.consecutive_failures}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Timeout / retries</dt><dd className="font-medium">{wx.timeout_s}s / {wx.max_retries}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Chaos mode</dt><dd className="font-medium">{wx.chaos_mode}</dd></div>
                <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs">
                  {Object.entries(wx.stats).map(([k, v]) => <div key={k} className="rounded-lg bg-slate-50 px-2 py-1.5"><span className="text-slate-500">{k.replace('_', ' ')}</span> <strong className="float-right text-slate-900">{v}</strong></div>)}
                </div>
              </dl>
            )}
          </Card>
          <Card index={3} icon={CloudRain} title="Latest ward re-score" subtitle={refreshOut ? `${refreshOut.updated} wards · ${refreshOut.degraded_weather} on fallback weather` : 'Run a re-score to see live results'} className="lg:col-span-2" bodyClass="p-0">
            {!refreshOut ? <p className="p-5 text-sm text-slate-500">Click “{rescoreLabel}”. Each ward pulls its own rainfall forecast, then the model and rules recompute its risk.</p> : (
              <ul className="grid max-h-80 overflow-y-auto sm:grid-cols-2">
                {refreshOut.wards.slice().sort((a, b) => b.score - a.score).map((w, i) => (
                  <motion.li key={w.ward_id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }}
                    className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">{w.name} <span className="text-xs text-slate-400">· {w.rain_next_24h_mm} mm · {w.weather_source}</span></span>
                    <RiskBadge level={w.level} score={w.score} />
                  </motion.li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}

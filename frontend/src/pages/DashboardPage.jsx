import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, ClipboardList, Clock, Droplets, HandHeart, Home, Package, Plus, ShieldCheck, Smartphone, Users, Workflow } from 'lucide-react'
import { motion } from 'framer-motion'
import { Alert, Button, Card, EmptyState, PageHeader, RiskBadge, Spinner, StatCard, StatusBadge } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { supabase } from '../lib/supabase'
import { CATEGORY_LABEL, RESOURCE_LABEL, fmtNum, timeAgo } from '../lib/format'
import { errorMessage } from '../lib/errors'
import { areaLabel } from '../lib/areas'

export default function DashboardPage() {
  const { profile } = useAuth()
  if (profile.role === 'citizen') return <CitizenDashboard />
  if (profile.role === 'field_worker') return <FieldDashboard />
  if (profile.role === 'ngo_coordinator') return <NgoDashboard />
  return <StaffDashboard />
}

function Greeting() {
  const { profile, org } = useAuth()
  const h = new Date().getHours()
  return `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, ${profile.full_name.split(' ')[0]}${org ? ` · ${org.name}` : ''}`
}

function StaffDashboard() {
  const { area } = useAuth()
  const [a, setA] = useState(null)
  const [wards, setWards] = useState([])
  const [queues, setQueues] = useState({ reported: [], verified: [], plans: [] })
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const [an, wr, rep, ver, pl] = await Promise.all([
      supabase.rpc('analytics_dashboard', { p_days: 7 }),
      supabase.rpc('ward_risk_summary'),
      supabase.from('incidents').select('id,reference_code,title,category,ward_id,created_at,severity_reported').eq('status', 'reported').order('created_at').limit(6),
      supabase.from('incidents').select('id,reference_code,title,category,ward_id,created_at').eq('status', 'verified').order('created_at').limit(6),
      supabase.from('allocation_plans').select('id,incident_ids,feasible,relaxed,created_at').eq('status', 'pending_approval').order('created_at', { ascending: false }).limit(5),
    ])
    const e = an.error || wr.error || rep.error || ver.error
    if (e) setErr(errorMessage(e))
    setA(an.data); setWards(wr.data || [])
    setQueues({ reported: rep.data || [], verified: ver.data || [], plans: pl.data || [] })
  }, [])
  useEffect(() => { load() }, [load])
  const refresh = useDebouncedCallback(load, 800)
  useRealtime(['incidents', 'allocation_plans', 'resources', 'wards'], refresh)

  if (!a && !err) return <Spinner />
  const t = a?.totals || {}
  return (
    <>
      <Hero icon={ShieldCheck} eyebrow={area ? `Drainage command center · ${areaLabel(area)}` : 'Drainage command center'} title={area ? `${areaLabel(area)} operations overview` : 'Operations overview'} subtitle={<Greeting />}
        actions={<Link to="/incidents/new"><Button className="!bg-white !from-white !to-white !text-brand-800 hover:!bg-brand-50"><Plus className="h-4 w-4" />New report</Button></Link>}
        stats={[['Awaiting verification', queues.reported.length], ['Awaiting AI assessment', queues.verified.length], ['Plans to approve', queues.plans.length]]} />
      {err && <Alert tone="error" className="mb-4">{err}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard index={0} label="Active incidents" value={t.active ?? 0} hint="last 7 days" icon={Droplets} />
        <StatCard index={1} label="Critical" value={t.critical ?? 0} hint="AI-assessed critical" icon={AlertTriangle} tone="red" />
        <StatCard index={2} label="People affected" value={t.people_affected ?? 0} hint="excl. duplicates" icon={Users} tone="amber" />
        <StatCard index={3} label="Avg. resolution" value={t.avg_resolution_hours ?? '—'} decimals={1} suffix=" h" hint={`P90 ${t.p90_resolution_hours ?? '—'} h`} icon={Clock} tone="green" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Highest-risk wards" subtitle="Live AI ward risk (weather + drainage + history)" className="xl:col-span-2" bodyClass="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Ward</th><th className="px-4 py-2">Risk</th><th className="px-4 py-2">Active</th><th className="px-4 py-2">Critical</th><th className="px-4 py-2">Updated</th></tr></thead>
              <tbody>
                {wards.slice(0, 8).map((w) => (
                  <tr key={w.ward_id} className="border-t border-slate-100">
                    <td className="px-4 py-2"><span className="font-medium text-slate-800">{w.name}</span> <span className="text-xs text-slate-400">{w.ward_id}</span></td>
                    <td className="px-4 py-2"><RiskBadge level={w.risk_level} score={w.risk_score} /></td>
                    <td className="px-4 py-2">{w.active_incidents}</td>
                    <td className="px-4 py-2">{w.critical_incidents > 0 ? <span className="font-semibold text-rose-600">{w.critical_incidents}</span> : 0}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{timeAgo(w.risk_updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Resource utilisation" subtitle="Reserved or dispatched share of stock">
          <ul className="space-y-3">
            {(a?.resources || []).map((r) => (
              <li key={r.resource_type}>
                <div className="flex justify-between text-sm"><span className="text-slate-700">{RESOURCE_LABEL[r.resource_type]}</span><span className="text-slate-500">{r.available}/{r.total} free</span></div>
                <div className="mt-1 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={r.utilization_pct || 0} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.resource_type} utilisation`}>
                  <div className={`h-2 rounded-full ${r.utilization_pct > 80 ? 'bg-rose-500' : r.utilization_pct > 50 ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${r.utilization_pct || 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Queue title="Awaiting verification" items={queues.reported} empty="No new reports" />
        <Queue title="Awaiting AI assessment" items={queues.verified} empty="Nothing to assess" />
        <Card title="Plans awaiting approval" actions={<Link className="text-xs font-medium text-brand-700 hover:underline" to="/resources?tab=plans">Open</Link>}>
          {queues.plans.length === 0 ? <p className="text-sm text-slate-500">No pending plans</p> : (
            <ul className="space-y-2 text-sm">
              {queues.plans.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span><Workflow className="mr-1 inline h-4 w-4 text-slate-400" aria-hidden />{p.incident_ids.length} incident(s)</span>
                  <span className="text-xs text-slate-500">{p.relaxed ? 'relaxed · ' : ''}{timeAgo(p.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}

function Queue({ title, items, empty }) {
  return (
    <Card title={title} actions={<Link className="text-xs font-medium text-brand-700 hover:underline" to="/incidents">View all</Link>}>
      {items.length === 0 ? <p className="text-sm text-slate-500">{empty}</p> : (
        <ul className="divide-y divide-slate-100">
          {items.map((i) => (
            <li key={i.id} className="py-2">
              <Link to={`/incidents/${i.id}`} className="block rounded hover:bg-slate-50">
                <p className="truncate text-sm font-medium text-slate-800">{i.title}</p>
                <p className="text-xs text-slate-500">{i.reference_code} · {CATEGORY_LABEL[i.category]} · {timeAgo(i.created_at)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function CitizenDashboard() {
  const { profile, security } = useAuth()
  const [mine, setMine] = useState(null)
  const [ward, setWard] = useState(null)
  const [request, setRequest] = useState(null)
  const load = useCallback(async () => {
    const [{ data }, { data: w }, { data: rq }] = await Promise.all([
      supabase.from('incidents').select('id,reference_code,title,status,category,created_at,risk_level,risk_score').eq('reporter_id', profile.id).order('created_at', { ascending: false }).limit(20),
      supabase.rpc('ward_risk_summary'),
      supabase.from('role_requests').select('requested_role,status').eq('user_id', profile.id).eq('status', 'pending').limit(1).maybeSingle(),
    ])
    setMine(data || [])
    setWard((w || []).find((x) => x.ward_id === profile.ward_id) || null)
    setRequest(rq || null)
  }, [profile.id, profile.ward_id])
  useEffect(() => { load() }, [load])
  useRealtime('incidents', load, { filter: `reporter_id=eq.${profile.id}` })
  if (!mine) return <Spinner />
  const count = (s) => mine.filter((m) => s.includes(m.status)).length
  return (
    <>
      <PageHeader title="My reports" description={<Greeting />} actions={<Link to="/incidents/new"><Button><Plus className="h-4 w-4" />Report waterlogging</Button></Link>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Submitted" value={mine.length} icon={ClipboardList} />
        <StatCard label="Under review" value={count(['reported', 'verified', 'assessed'])} icon={Clock} tone="amber" />
        <StatCard label="Team dispatched" value={count(['approved', 'in_progress'])} icon={Workflow} tone="sky" />
        <StatCard label="Resolved" value={count(['resolved'])} icon={CheckCircle2} tone="green" />
      </div>
      {request && (
        <Alert tone="info" className="mt-5" title="Your staff access request is pending">
          Administrators verify you against the official staff roster. Speed it up: verify your mobile number and upload your office ID card or appointment letter.{' '}
          <Link to="/account" className="font-semibold underline">Account &amp; security</Link>
        </Alert>
      )}
      {!request && security && !security.phone_verified && (
        <Alert tone={security.require_phone_verification ? 'warning' : 'info'} className="mt-5" title="Verify your mobile number">
          {security.require_phone_verification ? 'A verified Bangladeshi mobile number is required before you can submit reports.' : 'Reports from verified numbers are trusted and handled faster.'}{' '}
          <Link to="/account" className="font-semibold underline">Verify now</Link>
        </Alert>
      )}
      {ward && (
        <Alert tone={['high', 'critical'].includes(ward.risk_level) ? 'warning' : 'info'} className="mt-5" title={`Your area: ${ward.name}`}>
          Current waterlogging risk is <strong>{ward.risk_level}</strong>. {['high', 'critical'].includes(ward.risk_level) ? 'Avoid low-lying roads and keep drains near your home clear.' : 'No major risk expected right now.'}
        </Alert>
      )}
      <Card title="Recent reports" className="mt-5" bodyClass="p-0">
        {mine.length === 0 ? <EmptyState icon={Droplets} title="No reports yet">Seen waterlogging or a blocked drain? Report it and track the response here.</EmptyState> : (
          <ul className="divide-y divide-slate-100">
            {mine.map((m) => (
              <li key={m.id}><Link to={`/incidents/${m.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-slate-50">
                <div className="min-w-0"><p className="truncate font-medium text-slate-800">{m.title}</p><p className="text-xs text-slate-500">{m.reference_code} · {timeAgo(m.created_at)}</p></div>
                <StatusBadge status={m.status} />
              </Link></li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function FieldDashboard() {
  const { profile } = useAuth()
  const [tasks, setTasks] = useState(null)
  const load = useCallback(async () => {
    const { data } = await supabase.from('tasks').select('id,status').eq('assigned_to', profile.id)
    setTasks(data || [])
  }, [profile.id])
  useEffect(() => { load() }, [load])
  useRealtime('tasks', load, { filter: `assigned_to=eq.${profile.id}` })
  if (!tasks) return <Spinner />
  const c = (s) => tasks.filter((t) => s.includes(t.status)).length
  return (
    <>
      <PageHeader title="Field operations" description={<Greeting />} actions={<Link to="/field"><Button><Smartphone className="h-4 w-4" />Open field portal</Button></Link>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="New assignments" value={c(['assigned'])} icon={ClipboardList} tone="sky" />
        <StatCard label="In progress" value={c(['accepted', 'in_progress'])} icon={Clock} tone="amber" />
        <StatCard label="Completed" value={c(['completed'])} icon={CheckCircle2} tone="green" />
        <StatCard label="Failed" value={c(['failed'])} icon={AlertTriangle} tone="red" />
      </div>
      <Alert className="mt-5" title="Works offline">The field portal caches your tasks on this device. Updates made without signal are queued and synced automatically when you reconnect.</Alert>
    </>
  )
}

// ---------------------------------------------------------------- shared hero banner
function Hero({ icon: Icon, eyebrow, title, subtitle, actions, stats = [], tone = 'from-ink-900 via-brand-900 to-brand-700' }) {
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
      className={`relative mb-6 overflow-hidden rounded-3xl bg-gradient-to-br ${tone} p-6 text-white shadow-lg shadow-brand-900/20 sm:p-7`}>
      <motion.div aria-hidden className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl"
        animate={{ scale: [1, 1.12, 1], opacity: [0.6, 0.9, 0.6] }} transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }} />
      <motion.div aria-hidden className="absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-sky-400/20 blur-3xl"
        animate={{ x: [0, 30, 0] }} transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }} />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-brand-200">{Icon && <Icon className="h-4 w-4" aria-hidden />}{eyebrow}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1 text-sm text-white/70">{subtitle}</p>
        </div>
        {actions}
      </div>
      {stats.length > 0 && (
        <div className="relative mt-5 flex flex-wrap gap-2">
          {stats.map(([label, n]) => (
            <span key={label} className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs ring-1 ring-inset ring-white/15 backdrop-blur">
              <strong className="text-sm tabular-nums">{n}</strong>{label}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  )
}

// ---------------------------------------------------------------- NGO coordinator: humanitarian view
function NgoDashboard() {
  const { profile, org } = useAuth()
  const [needs, setNeeds] = useState(null)
  const [stock, setStock] = useState([])
  const [allocs, setAllocs] = useState([])
  const [wards, setWards] = useState([])
  const load = useCallback(async () => {
    const [n, r, a, w] = await Promise.all([
      supabase.from('community_needs').select('id,need_type,quantity,fulfilled_qty,households,status,created_at,wards(name)').order('created_at', { ascending: false }).limit(300),
      supabase.from('resources').select('id,name,resource_type,quantity_total,quantity_available').eq('organization_id', profile.organization_id),
      supabase.from('allocations').select('id,quantity,status,created_at,resources!inner(name,organization_id),community_needs(wards(name))').eq('resources.organization_id', profile.organization_id).order('created_at', { ascending: false }).limit(6),
      supabase.rpc('ward_risk_summary'),
    ])
    setNeeds(n.data || []); setStock(r.data || []); setAllocs(a.data || []); setWards(w.data || [])
  }, [profile.organization_id])
  useEffect(() => { load() }, [load])
  useRealtime(['community_needs', 'resources', 'allocations'], useDebouncedCallback(load, 600))
  if (!needs) return <Spinner />
  const open = needs.filter((x) => ['open', 'partially_fulfilled'].includes(x.status))
  const households = open.reduce((s, x) => s + x.households, 0)
  const unmet = open.reduce((s, x) => s + x.quantity - x.fulfilled_qty, 0)
  const dups = needs.filter((x) => x.status === 'duplicate').length
  const fulfilled = needs.filter((x) => x.status === 'fulfilled').length
  return (
    <>
      <Hero icon={HandHeart} eyebrow="Humanitarian coordination" title="Relief operations" subtitle={<Greeting />}
        tone="from-ink-900 via-rose-950 to-rose-800"
        actions={<Link to="/ngo"><Button className="!bg-white !from-white !to-white !text-rose-800 hover:!bg-rose-50">Open coordination center<ArrowRight className="h-4 w-4" /></Button></Link>}
        stats={[['open needs', open.length], ['households waiting', households.toLocaleString()], ['duplicate requests blocked', dups]]} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard index={0} label="Open needs" value={open.length} icon={HandHeart} tone="red" />
        <StatCard index={1} label="Households waiting" value={households} icon={Home} tone="amber" />
        <StatCard index={2} label="Unmet units" value={unmet} icon={Package} tone="violet" />
        <StatCard index={3} label="Needs fulfilled" value={fulfilled} icon={CheckCircle2} tone="green" />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card index={1} icon={HandHeart} title="Most urgent open needs" subtitle="Sorted by households waiting" className="xl:col-span-2" bodyClass="p-0">
          {open.length === 0 ? <EmptyState icon={CheckCircle2} title="No open needs">Every registered need has been served.</EmptyState> : (
            <ul className="divide-y divide-slate-100">
              {open.slice().sort((a, b) => b.households - a.households).slice(0, 6).map((x) => {
                const pct = Math.round((100 * x.fulfilled_qty) / x.quantity)
                return (
                  <li key={x.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-800">{x.quantity} × {RESOURCE_LABEL[x.need_type]} · {x.wards?.name}</p>
                      <p className="text-xs text-slate-500">{x.households} households · {timeAgo(x.created_at)}</p>
                    </div>
                    <div>
                      <div className="h-2 rounded-full bg-slate-100"><motion.div className="h-2 rounded-full bg-gradient-to-r from-rose-500 to-amber-400" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8 }} /></div>
                      <p className="mt-0.5 text-right text-xs text-slate-500">{x.fulfilled_qty}/{x.quantity} delivered</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
        <Card index={2} icon={Boxes} title={`${org?.name || 'Our'} stock`} subtitle="Only your organisation can allocate this">
          {stock.length === 0 ? <p className="text-sm text-slate-500">No inventory registered.</p> : (
            <ul className="space-y-3">
              {stock.map((r) => {
                const pct = r.quantity_total ? (100 * r.quantity_available) / r.quantity_total : 0
                return (
                  <li key={r.id}>
                    <div className="flex justify-between gap-2 text-sm"><span className="truncate text-slate-700">{r.name}</span><span className="shrink-0 tabular-nums text-slate-500">{r.quantity_available}/{r.quantity_total}</span></div>
                    <div className="mt-1 h-2 rounded-full bg-slate-100"><motion.div className={`h-2 rounded-full ${pct < 20 ? 'bg-rose-500' : pct < 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8 }} /></div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
        <Card index={3} icon={Package} title="Recent allocations" className="xl:col-span-2" bodyClass="p-0">
          {allocs.length === 0 ? <p className="p-5 text-sm text-slate-500">No allocations yet.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {allocs.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className="min-w-0 truncate">{a.quantity} × {a.resources?.name}{a.community_needs?.wards?.name ? ` → ${a.community_needs.wards.name}` : ''}</span>
                  <span className="shrink-0 text-xs text-slate-500">{a.status} · {timeAgo(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card index={4} icon={AlertTriangle} title="Wards likely to need relief" subtitle="Highest AI flood risk now">
          <ul className="space-y-2">{wards.slice(0, 5).map((w) => <li key={w.ward_id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{w.name}</span><RiskBadge level={w.risk_level} score={w.risk_score} /></li>)}</ul>
        </Card>
      </div>
    </>
  )
}

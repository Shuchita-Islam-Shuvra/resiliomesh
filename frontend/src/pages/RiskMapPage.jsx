import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CloudRain, Droplets, MapPin, Search, Wrench, X } from 'lucide-react'
import MapView, { ASSET_COLOR, UNASSESSED_COLOR } from '../components/MapView'
import { Alert, Card, PageHeader, RiskBadge } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { api } from '../lib/api'
import { supabase } from '../lib/supabase'
import { areaLabel } from '../lib/areas'
import { RISK_COLOR, fmtDateTime, humanize } from '../lib/format'

const ACTIVE = ['reported', 'verified', 'assessed', 'approved', 'in_progress']
const RISK_LEVELS = ['low', 'moderate', 'high', 'critical']

/** Type-ahead ward search: pick a ward to zoom the map to it, clear it to see the whole area. */
function WardSearch({ wards, focus, onSelect, onClear }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const box = useRef(null)
  useEffect(() => { setQ(focus ? focus.name : '') }, [focus])
  useEffect(() => {
    const close = (e) => { if (!box.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const term = q.trim().toLowerCase()
  const matches = useMemo(() => wards.filter((w) => !term || (focus && q === focus.name)
    || w.name.toLowerCase().includes(term) || w.ward_id.toLowerCase().includes(term)).slice(0, 8), [wards, term, q, focus])
  const choose = (w) => { onSelect(w); setOpen(false) }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && matches[hi]) { e.preventDefault(); choose(matches[hi]) }
    else if (e.key === 'Escape') setOpen(false)
  }
  return (
    <div ref={box} className="relative w-full sm:max-w-sm">
      <label htmlFor="ward-search" className="sr-only">Search a ward</label>
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
      <input id="ward-search" role="combobox" aria-expanded={open} aria-controls="ward-search-list" autoComplete="off"
        className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-9 text-sm shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
        placeholder="Search a ward, e.g. Motijheel" value={q} onKeyDown={onKey} onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setHi(0); setOpen(true); if (!e.target.value.trim()) onClear() }} />
      {q && (
        <button type="button" onClick={() => { setQ(''); onClear() }} className="absolute right-2 top-1.5 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Clear search and show the whole area">
          <X className="h-4 w-4" />
        </button>
      )}
      {open && matches.length > 0 && (
        <ul id="ward-search-list" role="listbox" className="absolute z-[1000] mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((w, i) => (
            <li key={w.ward_id} role="option" aria-selected={i === hi}>
              <button type="button" onMouseEnter={() => setHi(i)} onClick={() => choose(w)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${i === hi ? 'bg-brand-50' : ''}`}>
                <span><MapPin className="mr-1.5 inline h-3.5 w-3.5 text-slate-400" aria-hidden />{w.name} <span className="text-xs text-slate-400">{w.ward_id}</span></span>
                <RiskBadge level={w.risk_level} score={w.risk_score} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && term && matches.length === 0 && (
        <p className="absolute z-[1000] mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-lg">No ward matches “{q}”</p>
      )}
    </div>
  )
}

const Dot = ({ color, square, size = 12 }) => (
  <span aria-hidden className="inline-block shrink-0 border-2 border-white shadow-[0_0_0_1px_rgba(15,23,42,.3)]"
    style={{ width: size, height: size, background: color, borderRadius: square ? 2 : 999 }} />
)
const Ring = ({ color }) => (
  <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-dashed" style={{ borderColor: color, background: `${color}26` }} />
)

function Legend({ showAssets }) {
  return (
    <div className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 sm:grid-cols-3">
      <div>
        <p className="mb-1.5 font-semibold text-slate-800">Circles = wards</p>
        <p className="mb-2 text-slate-500">Colour is the AI flood-risk level of the whole ward.</p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">{RISK_LEVELS.map((k) => <li key={k} className="inline-flex items-center gap-1.5"><Ring color={RISK_COLOR[k]} />{humanize(k)}</li>)}</ul>
      </div>
      <div>
        <p className="mb-1.5 font-semibold text-slate-800">Dots = citizen reports</p>
        <p className="mb-2 text-slate-500">Open waterlogging reports. Colour is the report's AI risk; bigger = critical.</p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {RISK_LEVELS.map((k) => <li key={k} className="inline-flex items-center gap-1.5"><Dot color={RISK_COLOR[k]} />{humanize(k)}</li>)}
          <li className="inline-flex items-center gap-1.5"><Dot color={UNASSESSED_COLOR} />Not yet assessed</li>
        </ul>
      </div>
      {showAssets && (
        <div>
          <p className="mb-1.5 font-semibold text-slate-800">Squares = drains & pump stations</p>
          <p className="mb-2 text-slate-500">Drainage assets and their condition.</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">{Object.entries(ASSET_COLOR).map(([k, c]) => <li key={k} className="inline-flex items-center gap-1.5"><Dot color={c} square size={11} />{humanize(k)}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

export default function RiskMapPage() {
  const { isStaff, area, hasRole, profile } = useAuth()
  const isNgo = hasRole('ngo_coordinator')
  const [myWardIds, setMyWardIds] = useState(() => new Set())
  const nav = useNavigate()
  const [wards, setWards] = useState([])
  const [incidents, setIncidents] = useState([])
  const [assets, setAssets] = useState([])
  const [layers, setLayers] = useState({ wards: true, incidents: true, assets: isStaff })
  const [focusId, setFocusId] = useState('')
  const [weather, setWeather] = useState(null)
  const [wxErr, setWxErr] = useState('')

  const load = useCallback(async () => {
    const [w, i, a, sizes] = await Promise.all([
      supabase.rpc('ward_risk_summary'),
      supabase.from('incidents').select('id,reference_code,title,status,ward_id,lat,lng,risk_level,risk_score,water_depth_cm')
        .in('status', ACTIVE).limit(500),
      supabase.from('drainage_assets').select('id,code,name,asset_type,status,condition_score,ward_id,lat,lng'),
      supabase.from('wards').select('id,area_km2'),
    ])
    const areaMap = Object.fromEntries((sizes.data || []).map((x) => [x.id, x.area_km2]))
    setWards((w.data || []).map((x) => ({ ...x, area_km2: areaMap[x.ward_id] })))
    setIncidents(i.data || [])
    setAssets(a.data || [])
    // NGO coordinators: wards where their own organisation has live allocations (to needs or incidents)
    if (isNgo && profile?.organization_id) {
      const { data: al } = await supabase.from('allocations')
        .select('status, resources!inner(organization_id), community_needs(ward_id), incidents(ward_id)')
        .eq('resources.organization_id', profile.organization_id).in('status', ['reserved', 'dispatched', 'consumed'])
      setMyWardIds(new Set((al || []).flatMap((x) => [x.community_needs?.ward_id, x.incidents?.ward_id]).filter(Boolean)))
    }
  }, [isNgo, profile?.organization_id])
  useEffect(() => { load() }, [load])
  useRealtime(['incidents', 'wards', 'allocations'], useDebouncedCallback(load, 800))

  const markedWards = useMemo(() => isNgo ? wards.map((w) => ({ ...w, mine: myWardIds.has(w.ward_id) })) : wards, [wards, isNgo, myWardIds])
  const selected = useMemo(() => wards.find((w) => w.ward_id === focusId) || null, [wards, focusId])
  useEffect(() => {
    if (!focusId) { setWeather(null); return }
    setWxErr('')
    api(`/api/weather/wards/${focusId}`).then(setWeather).catch((e) => setWxErr(e.message))
  }, [focusId])

  // with a ward in focus, the map shows only that ward's reports and drains
  const shownIncidents = focusId ? incidents.filter((i) => i.ward_id === focusId) : incidents
  const shownAssets = focusId ? assets.filter((a) => a.ward_id === focusId) : assets
  const place = area ? areaLabel(area) : 'Dhaka'
  const stats = [
    { label: 'Wards', value: wards.length, icon: MapPin },
    { label: 'Open reports', value: incidents.length, icon: Droplets },
    { label: 'High / critical reports', value: incidents.filter((i) => ['high', 'critical'].includes(i.risk_level)).length, icon: AlertTriangle, warn: true },
    ...(isNgo ? [{ label: 'Wards your NGO serves', value: myWardIds.size, icon: MapPin }] : []),
    ...(isStaff ? [{ label: 'Blocked drains', value: assets.filter((a) => a.status === 'blocked').length, icon: Wrench, warn: true }] : []),
  ]

  return (
    <>
      <PageHeader title={`Live waterlogging risk map · ${place}`}
        description={`Each circle is a ward of ${place}, coloured by its AI flood risk. Dots are open citizen reports${isStaff ? ' and squares are drains' : ''}. Search or click a ward to zoom in; clear the search to see the whole area again.`} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, warn }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <Icon className={`h-5 w-5 ${warn && value > 0 ? 'text-rose-600' : 'text-brand-700'}`} aria-hidden />
            <div><p className="text-xl font-bold leading-none text-slate-900">{value}</p><p className="mt-1 text-xs text-slate-500">{label}</p></div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <WardSearch wards={wards} focus={selected} onSelect={(w) => setFocusId(w.ward_id)} onClear={() => setFocusId('')} />
            <div className="flex flex-wrap items-center gap-4">
              <fieldset className="flex flex-wrap gap-4 text-sm">
                <legend className="sr-only">Map layers</legend>
                {[['wards', 'Wards'], ['incidents', 'Reports'], ['assets', 'Drains']].map(([k, l]) => (
                  (k !== 'assets' || isStaff) && (
                    <label key={k} className="inline-flex items-center gap-2">
                      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-700" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{l}
                    </label>
                  )
                ))}
              </fieldset>
            </div>
          </div>
          {selected && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-600">Showing <strong className="text-slate-900">{selected.name}</strong>: {shownIncidents.length} open report{shownIncidents.length === 1 ? '' : 's'}{isStaff ? `, ${shownAssets.length} drain${shownAssets.length === 1 ? '' : 's'}` : ''}</span>
              <button type="button" onClick={() => setFocusId('')} className="rounded-full border border-slate-300 px-2.5 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Show all of {place}</button>
            </div>
          )}
          <MapView height="h-[65vh] min-h-[380px]" basemap="satellite" wards={layers.wards ? markedWards : []} incidents={layers.incidents ? shownIncidents : []}
            assets={layers.assets ? shownAssets : []} focusWard={selected} onWardClick={(w) => setFocusId(w.ward_id)}
            onIncidentClick={isStaff ? (i) => nav(`/incidents/${i.id}`) : undefined} />
          <Legend showAssets={isStaff} />
        </div>

        <div className="space-y-4">
          <Card title={selected ? selected.name : 'Ward details'} subtitle={selected ? selected.ward_id : undefined}>
            {!selected ? (
              <p className="text-sm text-slate-500">Search or click a ward on the map to see its risk, rainfall forecast and open reports.</p>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between"><span className="text-slate-500">AI risk</span><RiskBadge level={selected.risk_level} score={selected.risk_score} /></div>
                <div className="flex justify-between"><span className="text-slate-500">Open reports</span><span>{selected.active_incidents}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Critical reports</span><span>{selected.critical_incidents}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Population</span><span>{selected.population?.toLocaleString()}</span></div>
                {wxErr && <Alert tone="warning">Weather unavailable: {wxErr}</Alert>}
                {weather && (
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="mb-1 flex items-center gap-1 font-medium text-slate-700"><CloudRain className="h-4 w-4" aria-hidden />Rainfall</p>
                    <p>Past 24h: <strong>{weather.rain_past_24h_mm} mm</strong></p>
                    <p>Next 24h: <strong>{weather.rain_next_24h_mm} mm</strong> (peak {weather.max_hourly_mm} mm/h)</p>
                    <p className="mt-1 text-xs text-slate-500">Source: {weather.source}{weather.degraded ? ' (degraded — fallback data)' : ''} · {fmtDateTime(weather.fetched_at)}</p>
                  </div>
                )}
                {shownIncidents.length > 0 && (
                  <div className="pt-1">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Open reports here</p>
                    <ul className="divide-y divide-slate-100">
                      {shownIncidents.slice(0, 6).map((i) => (
                        <li key={i.id}>
                          <button type="button" disabled={!isStaff} onClick={() => nav(`/incidents/${i.id}`)} className="flex w-full items-center justify-between gap-2 py-1.5 text-left hover:text-brand-700 disabled:cursor-default">
                            <span className="truncate">{i.title}</span>
                            {i.risk_level ? <RiskBadge level={i.risk_level} score={i.risk_score} /> : <span className="text-xs text-slate-400">{humanize(i.status)}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>
          <Card title="Ward ranking" subtitle="Highest AI risk first" bodyClass="p-0">
            <ol className="max-h-[45vh] divide-y divide-slate-100 overflow-y-auto">
              {wards.map((w, idx) => (
                <li key={w.ward_id}>
                  <button onClick={() => setFocusId(focusId === w.ward_id ? '' : w.ward_id)} aria-pressed={focusId === w.ward_id}
                    className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50 ${focusId === w.ward_id ? 'bg-brand-50' : ''}`}>
                    <span><span className="mr-2 text-xs text-slate-400">{idx + 1}</span>{w.name}</span>
                    <RiskBadge level={w.risk_level} score={w.risk_score} />
                  </button>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  )
}

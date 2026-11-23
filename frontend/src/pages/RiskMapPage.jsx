import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CloudRain } from 'lucide-react'
import MapView from '../components/MapView'
import { Alert, Card, PageHeader, RiskBadge, Select } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useDebouncedCallback, useRealtime } from '../hooks/useRealtime'
import { api } from '../lib/api'
import { supabase } from '../lib/supabase'
import { RISK_COLOR, fmtDateTime } from '../lib/format'

export default function RiskMapPage() {
  const { isStaff } = useAuth()
  const nav = useNavigate()
  const [wards, setWards] = useState([])
  const [incidents, setIncidents] = useState([])
  const [assets, setAssets] = useState([])
  const [layers, setLayers] = useState({ wards: true, incidents: true, assets: isStaff })
  const [focus, setFocus] = useState('')
  const [weather, setWeather] = useState(null)
  const [wxErr, setWxErr] = useState('')

  const load = useCallback(async () => {
    const [w, i, a] = await Promise.all([
      supabase.rpc('ward_risk_summary'),
      supabase.from('incidents').select('id,reference_code,title,status,lat,lng,risk_level,risk_score,water_depth_cm')
        .in('status', ['reported', 'verified', 'assessed', 'approved', 'in_progress']).limit(500),
      supabase.from('drainage_assets').select('id,code,name,asset_type,status,condition_score,lat,lng'),
    ])
    const areas = await supabase.from('wards').select('id,area_km2')
    const areaMap = Object.fromEntries((areas.data || []).map((x) => [x.id, x.area_km2]))
    setWards((w.data || []).map((x) => ({ ...x, area_km2: areaMap[x.ward_id] })))
    setIncidents(i.data || [])
    setAssets(a.data || [])
  }, [])
  useEffect(() => { load() }, [load])
  useRealtime(['incidents', 'wards'], useDebouncedCallback(load, 800))

  const selected = useMemo(() => wards.find((w) => w.ward_id === focus), [wards, focus])
  useEffect(() => {
    if (!focus) { setWeather(null); return }
    setWxErr('')
    api(`/api/weather/wards/${focus}`).then(setWeather).catch((e) => setWxErr(e.message))
  }, [focus])

  return (
    <>
      <PageHeader title="Live waterlogging risk map" description="Ward risk is recomputed by the AI model from live rainfall forecasts, drainage condition and history. Updates stream in real time." />
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div>
          <fieldset className="mb-3 flex flex-wrap gap-4 text-sm">
            <legend className="sr-only">Map layers</legend>
            {[['wards', 'Ward risk'], ['incidents', 'Active reports'], ['assets', 'Drainage assets']].map(([k, l]) => (
              (k !== 'assets' || isStaff) && (
                <label key={k} className="inline-flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-700" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{l}
                </label>
              )
            ))}
          </fieldset>
          <MapView height="h-[65vh] min-h-[380px]" wards={layers.wards ? wards : []} incidents={layers.incidents ? incidents : []}
            assets={layers.assets ? assets : []} flyTo={selected ? [selected.lat, selected.lng] : null}
            onIncidentClick={isStaff ? (i) => nav(`/incidents/${i.id}`) : undefined} />
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
            {Object.entries(RISK_COLOR).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-full" style={{ background: c }} />{k}</span>)}
          </div>
        </div>
        <div className="space-y-4">
          <Card title="Ward forecast">
            <label className="sr-only" htmlFor="ward-focus">Select ward</label>
            <Select id="ward-focus" value={focus} onChange={(e) => setFocus(e.target.value)}>
              <option value="">Select a ward…</option>
              {wards.map((w) => <option key={w.ward_id} value={w.ward_id}>{w.name}</option>)}
            </Select>
            {selected && (
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between"><span className="text-slate-500">Risk</span><RiskBadge level={selected.risk_level} score={selected.risk_score} /></div>
                <div className="flex justify-between"><span className="text-slate-500">Active reports</span><span>{selected.active_incidents}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Population</span><span>{selected.population.toLocaleString()}</span></div>
                {wxErr && <Alert tone="warning">Weather unavailable: {wxErr}</Alert>}
                {weather && (
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="mb-1 flex items-center gap-1 font-medium text-slate-700"><CloudRain className="h-4 w-4" aria-hidden />Rainfall</p>
                    <p>Past 24h: <strong>{weather.rain_past_24h_mm} mm</strong></p>
                    <p>Next 24h: <strong>{weather.rain_next_24h_mm} mm</strong> (peak {weather.max_hourly_mm} mm/h)</p>
                    <p className="mt-1 text-xs text-slate-500">Source: {weather.source}{weather.degraded ? ' (degraded — fallback data)' : ''} · {fmtDateTime(weather.fetched_at)}</p>
                  </div>
                )}
              </div>
            )}
          </Card>
          <Card title="Ward ranking" bodyClass="p-0">
            <ol className="max-h-[45vh] divide-y divide-slate-100 overflow-y-auto">
              {wards.map((w, idx) => (
                <li key={w.ward_id}>
                  <button onClick={() => setFocus(w.ward_id)} className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50 ${focus === w.ward_id ? 'bg-brand-50' : ''}`}>
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

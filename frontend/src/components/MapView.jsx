import { useEffect } from 'react'
import { Circle, CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { RISK_COLOR } from '../lib/format'

export const DHAKA_CENTER = [23.775, 90.395]

function ClickPicker({ onPick }) {
  useMapEvents({ click: (e) => onPick?.({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }) })
  return null
}

function FlyTo({ center }) {
  const map = useMap()
  useEffect(() => { if (center) map.flyTo(center, Math.max(map.getZoom(), 14), { duration: 0.6 }) }, [center, map])
  return null
}

/**
 * Generic map: wards (risk circles), incidents (markers), assets, resources, picker.
 */
export default function MapView({
  wards = [], incidents = [], assets = [], resources = [], pick, onPick, flyTo,
  height = 'h-[60vh]', onIncidentClick, showWardRadius = true,
}) {
  return (
    <div className={`${height} w-full overflow-hidden rounded-xl border border-slate-200`} role="region" aria-label="Map of Dhaka">
      <MapContainer center={DHAKA_CENTER} zoom={12} scrollWheelZoom className="h-full w-full">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {showWardRadius && wards.map((w) => (
          <Circle key={w.ward_id || w.id} center={[w.lat, w.lng]} radius={Math.sqrt((w.area_km2 || 2.5) * 1e6 / Math.PI) * 0.85}
            pathOptions={{ color: RISK_COLOR[w.risk_level || w.current_risk_level] || '#64748b', fillOpacity: 0.18, weight: 1.5 }}>
            <Tooltip direction="top">
              <strong>{w.name}</strong><br />
              Risk: {w.risk_level || w.current_risk_level || 'n/a'} ({Number(w.risk_score ?? w.current_risk_score ?? 0).toFixed(0)})
              {w.active_incidents !== undefined && <><br />Active reports: {w.active_incidents}</>}
            </Tooltip>
          </Circle>
        ))}
        {assets.map((a) => (
          <CircleMarker key={a.id} center={[a.lat, a.lng]} radius={5}
            pathOptions={{ color: a.status === 'blocked' ? '#b91c1c' : a.status === 'degraded' ? '#d97706' : '#0369a1', fillOpacity: 0.9, weight: 1 }}>
            <Popup><strong>{a.name}</strong><br />{a.code} · {a.asset_type?.replace('_', ' ')}<br />Condition {a.condition_score}/100 · {a.status}</Popup>
          </CircleMarker>
        ))}
        {resources.map((r) => (
          <CircleMarker key={r.id} center={[r.lat, r.lng]} radius={6} pathOptions={{ color: '#0f766e', fillColor: '#5eead4', fillOpacity: 0.9 }}>
            <Popup><strong>{r.name}</strong><br />{r.quantity_available}/{r.quantity_total} available</Popup>
          </CircleMarker>
        ))}
        {incidents.map((i) => (
          <CircleMarker key={i.id} center={[i.lat, i.lng]} radius={i.risk_level === 'critical' ? 10 : 8}
            eventHandlers={{ click: () => onIncidentClick?.(i) }}
            pathOptions={{ color: '#fff', weight: 2, fillColor: RISK_COLOR[i.risk_level] || '#475569', fillOpacity: 0.95 }}>
            <Popup>
              <strong>{i.reference_code}</strong> — {i.title}<br />
              Status: {i.status?.replace('_', ' ')}{i.risk_level ? ` · Risk ${i.risk_level} (${Number(i.risk_score).toFixed(0)})` : ''}
              {i.water_depth_cm ? <><br />Water depth: {i.water_depth_cm} cm</> : null}
            </Popup>
          </CircleMarker>
        ))}
        {pick && <CircleMarker center={[pick.lat, pick.lng]} radius={9} pathOptions={{ color: '#1d4ed8', fillColor: '#60a5fa', fillOpacity: 0.9 }} />}
        {onPick && <ClickPicker onPick={onPick} />}
        <FlyTo center={flyTo} />
      </MapContainer>
    </div>
  )
}

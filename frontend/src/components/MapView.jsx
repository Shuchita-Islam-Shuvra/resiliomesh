import { useEffect, useMemo } from 'react'
import L from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Polygon, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useAuth } from '../context/AuthContext'
import { useWardAreas } from '../hooks/useWardAreas'
import { AREA_BOUNDS, AREA_LABEL, DHAKA_BOUNDS, areaLabel, wardCells } from '../lib/areas'
import { RISK_COLOR } from '../lib/format'

export const DHAKA_CENTER = [23.775, 90.395]
export const UNASSESSED_COLOR = '#64748b'
export const ASSET_COLOR = { operational: '#0369a1', degraded: '#d97706', blocked: '#b91c1c' }

export const wardRadius = (w) => Math.sqrt((w.area_km2 || 2.5) * 1e6 / Math.PI) * 0.85

const BASEMAPS = {
  map: [{ url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }],
  satellite: [
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', attribution: '' },
  ],
}

const assetIcon = (status) => L.divIcon({
  className: '',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
  html: `<span style="display:block;width:12px;height:12px;border-radius:2px;border:2px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.35);background:${ASSET_COLOR[status] || ASSET_COLOR.operational}"></span>`,
})

function ClickPicker({ onPick }) {
  useMapEvents({ click: (e) => onPick?.({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }) })
  return null
}

function FlyTo({ center }) {
  const map = useMap()
  useEffect(() => { if (center) map.flyTo(center, Math.max(map.getZoom(), 14), { duration: 0.6 }) }, [center, map])
  return null
}

function FocusController({ focus, home }) {
  const map = useMap()
  useEffect(() => {
    const target = focus ? L.latLng(focus.lat, focus.lng).toBounds(wardRadius(focus) * 2.6) : L.latLngBounds(home)
    map.flyToBounds(target, { duration: 0.9, padding: [24, 24], easeLinearity: 0.2 })
  }, [focus, home, map])
  return null
}

export default function MapView({
  wards = [], incidents = [], assets = [], resources = [], pick, onPick, flyTo,
  height = 'h-[60vh]', onIncidentClick, onWardClick, focusWard, showWardRadius = true, lockToArea = true, basemap = 'satellite',
  area: areaProp,
}) {
  const { area: authArea } = useAuth() || {}
  const area = areaProp !== undefined ? areaProp : authArea
  const bounds = lockToArea ? AREA_BOUNDS[area] : null
  const wardAreas = useWardAreas()
  const otherCells = useMemo(() => (bounds && wardAreas.length
    ? wardCells(wardAreas, [[bounds[0][0] - 0.2, bounds[0][1] - 0.2], [bounds[1][0] + 0.2, bounds[1][1] + 0.2]])
      .filter((c) => c.city_corporation !== area && c.ring.length > 2).map((c) => [c.ring])
    : []), [bounds, wardAreas, area])
  const otherArea = Object.keys(AREA_LABEL).find((k) => k !== area)
  const home = useMemo(() => bounds || DHAKA_BOUNDS, [bounds])
  const frame = bounds
    ? { bounds, maxBounds: [[bounds[0][0] - 0.02, bounds[0][1] - 0.02], [bounds[1][0] + 0.02, bounds[1][1] + 0.02]], maxBoundsViscosity: 1, minZoom: 12 }
    : { center: DHAKA_CENTER, zoom: 12 }
  const focusId = focusWard?.ward_id || focusWard?.id
  return (
    <div className={`${height} relative w-full overflow-hidden rounded-xl border border-slate-200`} role="region" aria-label={bounds ? `Map of ${areaLabel(area)}` : 'Map of Dhaka'}>
      <MapContainer key={bounds ? area : 'dhaka'} {...frame} scrollWheelZoom zoomSnap={0.25} zoomDelta={0.5} wheelPxPerZoomLevel={90}
        className="h-full w-full">
        {(BASEMAPS[basemap] || BASEMAPS.map).map((t) => (
          <TileLayer key={t.url} url={t.url} subdomains={t.subdomains || 'abc'} attribution={t.attribution} maxZoom={19} />
        ))}
        {otherCells.length > 0 && (
          <Polygon positions={otherCells} interactive={false}
            pathOptions={{ stroke: false, fillColor: '#0f172a', fillOpacity: 0.55 }} />
        )}
        {showWardRadius && wards.map((w) => {
          const id = w.ward_id || w.id
          const level = w.risk_level || w.current_risk_level
          const isFocus = focusId === id
          const dimmed = focusId && !isFocus
          return (
            <Circle key={id} center={[w.lat, w.lng]} radius={wardRadius(w)}
              eventHandlers={onWardClick ? { click: () => onWardClick(w) } : undefined}
              pathOptions={{
                color: RISK_COLOR[level] || UNASSESSED_COLOR,
                weight: isFocus ? 3 : w.mine ? 3.5 : 1.5,
                opacity: dimmed ? 0.35 : 1,
                fillOpacity: isFocus ? 0.28 : dimmed ? 0.05 : w.mine ? 0.3 : 0.16,
                dashArray: isFocus || w.mine ? null : '4 4',
              }}>
              <Tooltip direction="top" sticky>
                <strong>{w.name}</strong>{w.mine && <> · <em>your NGO is serving here</em></>}<br />
                AI risk: {level || 'not scored'} ({Number(w.risk_score ?? w.current_risk_score ?? 0).toFixed(0)}/100)
                {w.active_incidents !== undefined && <><br />Active reports: {w.active_incidents}</>}
                {onWardClick && <><br /><em>Click to zoom in</em></>}
              </Tooltip>
            </Circle>
          )
        })}
        {assets.map((a) => (
          <Marker key={a.id} position={[a.lat, a.lng]} icon={assetIcon(a.status)}>
            <Popup><strong>{a.name}</strong><br />{a.code} · {a.asset_type?.replace('_', ' ')}<br />Condition {a.condition_score}/100 · {a.status}</Popup>
          </Marker>
        ))}
        {resources.map((r) => (
          <CircleMarker key={r.id} center={[r.lat, r.lng]} radius={6} pathOptions={{ color: '#0f766e', fillColor: '#5eead4', fillOpacity: 0.9 }}>
            <Popup><strong>{r.name}</strong><br />{r.quantity_available}/{r.quantity_total} available</Popup>
          </CircleMarker>
        ))}
        {incidents.map((i) => (
          <CircleMarker key={i.id} center={[i.lat, i.lng]} radius={i.risk_level === 'critical' ? 10 : 8}
            eventHandlers={{ click: () => onIncidentClick?.(i) }}
            pathOptions={{ color: '#fff', weight: 2, fillColor: RISK_COLOR[i.risk_level] || UNASSESSED_COLOR, fillOpacity: 0.95 }}>
            <Popup>
              <strong>{i.reference_code}</strong> — {i.title}<br />
              Status: {i.status?.replace('_', ' ')}{i.risk_level ? ` · Risk ${i.risk_level} (${Number(i.risk_score).toFixed(0)})` : ' · not yet AI-assessed'}
              {i.water_depth_cm ? <><br />Water depth: {i.water_depth_cm} cm</> : null}
            </Popup>
          </CircleMarker>
        ))}
        {pick && <CircleMarker center={[pick.lat, pick.lng]} radius={9} pathOptions={{ color: '#1d4ed8', fillColor: '#60a5fa', fillOpacity: 0.9 }} />}
        {onPick && <ClickPicker onPick={onPick} />}
        <FlyTo center={flyTo} />
        {focusWard !== undefined && <FocusController focus={focusWard} home={home} />}
      </MapContainer>
      {otherCells.length > 0 && (
        <p className="pointer-events-none absolute bottom-1 left-1 z-[1000] rounded bg-slate-900/80 px-2 py-0.5 text-[11px] font-medium text-white">
          Shaded: {areaLabel(otherArea)}, outside your area ({areaLabel(area)})
        </p>
      )}
    </div>
  )
}

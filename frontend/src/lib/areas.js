// Dhaka's two city corporations: Dhaka North (DNCC) and Dhaka South (DSCC).
// Water Resilience Officers and the field crews of a city corporation are bound to its
// area; NGO staff, admins and citizens are city-wide. The database is the real
// guard (migrations 009 / 011 / 012); this only shapes the UI.
export const AREA_LABEL = { DNCC: 'Dhaka North', DSCC: 'Dhaka South' }

export const areaLabel = (area) => AREA_LABEL[area] || 'No area'

// Roles whose organisation's area limits what they see (mirrors rm_view_area()).
export const AREA_BOUND_ROLES = ['city_officer', 'field_worker']

// Map frame of each city corporation, [[south, west], [north, east]].
// An area-bound user's maps open on, and stay inside, their own area.
export const AREA_BOUNDS = {
  DNCC: [[23.735, 90.33], [23.905, 90.455]],
  DSCC: [[23.68, 90.34], [23.765, 90.47]],
}
export const DHAKA_BOUNDS = [[23.68, 90.33], [23.905, 90.47]]

// planar coordinates where 1 unit ≈ the same distance north-south and east-west
const K = Math.cos((23.78 * Math.PI) / 180)
const xy = (lat, lng) => [lng * K, lat]

/**
 * Area of a point: the area of the nearest ward centre. Same rule the database
 * uses to file a report under a ward (008) and to guard area-bound staff (012).
 * @param wardAreas rows of ward_areas(): { ward_id, city_corporation, lat, lng }
 */
export function areaAt(wardAreas, lat, lng) {
  let best = null, bestD = Infinity
  const [px, py] = xy(lat, lng)
  for (const w of wardAreas || []) {
    const [x, y] = xy(w.lat, w.lng)
    const d = (x - px) ** 2 + (y - py) ** 2
    if (d < bestD) { bestD = d; best = w }
  }
  return best?.city_corporation || null
}

/**
 * The region that belongs to each ward under the nearest-centre rule (a Voronoi
 * cell), clipped to `box` [[south, west], [north, east]]. Returns
 * [{ ward_id, city_corporation, ring: [[lat, lng], ...] }].
 */
export function wardCells(wardAreas, box) {
  const pts = (wardAreas || []).map((w) => ({ ...w, p: xy(w.lat, w.lng) }))
  const [[s, wst], [n, e]] = box
  const start = [xy(s, wst), xy(s, e), xy(n, e), xy(n, wst)]
  return pts.map((a) => {
    let poly = start
    for (const b of pts) {
      if (b === a || poly.length === 0) continue
      // keep points closer to a than to b:  (b - a) · p <= (|b|² - |a|²) / 2
      const nx = b.p[0] - a.p[0], ny = b.p[1] - a.p[1]
      const c = (b.p[0] ** 2 + b.p[1] ** 2 - a.p[0] ** 2 - a.p[1] ** 2) / 2
      const inside = (q) => nx * q[0] + ny * q[1] <= c
      const cut = (q, r) => {
        const t = (c - nx * q[0] - ny * q[1]) / (nx * (r[0] - q[0]) + ny * (r[1] - q[1]))
        return [q[0] + t * (r[0] - q[0]), q[1] + t * (r[1] - q[1])]
      }
      const out = []
      poly.forEach((cur, i) => {
        const prev = poly[(i + poly.length - 1) % poly.length]
        if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur) }
        else if (inside(prev)) out.push(cut(prev, cur))
      })
      poly = out
    }
    return { ward_id: a.ward_id, city_corporation: a.city_corporation, ring: poly.map(([x, y]) => [y, x / K]) }
  })
}

/**
 * May this user change things in a ward of `wardArea`?
 * @param role       effective role of the signed-in user
 * @param myArea     officer's area (their authority's city_corporation)
 * @param wardArea   'DNCC' | 'DSCC' of the ward in question
 */
export function canManageArea(role, myArea, wardArea) {
  if (role === 'admin') return true
  if (role === 'city_officer') return Boolean(myArea) && myArea === wardArea
  return false
}

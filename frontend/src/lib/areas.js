// Drainage Officer areas: Dhaka's two city corporations.
// Mirrors rm_can_manage_ward() in supabase/migrations/009_officer_areas.sql;
// the database is the real guard, this only hides buttons that would fail.
export const AREA_LABEL = { DNCC: 'Dhaka North', DSCC: 'Dhaka South' }

export const areaLabel = (area) => AREA_LABEL[area] || 'No area'

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

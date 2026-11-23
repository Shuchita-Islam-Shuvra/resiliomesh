// Client-side validation (mirrors DB CHECK constraints so users get instant feedback).
export const DHAKA_BOUNDS = { minLat: 23.6, maxLat: 23.95, minLng: 90.25, maxLng: 90.55 }
const PHONE = /^\+?[0-9]{10,14}$/

export function validateReport(v) {
  const e = {}
  if (!v.title || v.title.trim().length < 5) e.title = 'Title must be at least 5 characters'
  else if (v.title.length > 120) e.title = 'Title must be at most 120 characters'
  if (!v.description || v.description.trim().length < 10) e.description = 'Describe the situation (at least 10 characters)'
  else if (v.description.length > 2000) e.description = 'Description is too long (max 2000)'
  if (!v.category) e.category = 'Choose a category'
  if (!v.ward_id) e.ward_id = 'Choose your area / ward'
  const sev = Number(v.severity_reported)
  if (!Number.isInteger(sev) || sev < 1 || sev > 5) e.severity_reported = 'Severity must be 1–5'
  if (v.water_depth_cm !== '' && v.water_depth_cm !== null && v.water_depth_cm !== undefined) {
    const d = Number(v.water_depth_cm)
    if (!Number.isFinite(d) || d < 0 || d > 300) e.water_depth_cm = 'Water depth must be between 0 and 300 cm'
  }
  const p = Number(v.people_affected || 0)
  if (!Number.isInteger(p) || p < 0 || p > 100000) e.people_affected = 'People affected must be a whole number 0–100000'
  const lat = Number(v.lat), lng = Number(v.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) e.location = 'Pick the location on the map or use GPS'
  else if (lat < DHAKA_BOUNDS.minLat || lat > DHAKA_BOUNDS.maxLat || lng < DHAKA_BOUNDS.minLng || lng > DHAKA_BOUNDS.maxLng)
    e.location = 'Location must be inside the Dhaka service area'
  return e
}

export function validateNeed(v) {
  const e = {}
  if (!v.ward_id) e.ward_id = 'Choose a ward'
  if (!v.need_type) e.need_type = 'Choose what is needed'
  const q = Number(v.quantity)
  if (!Number.isInteger(q) || q < 1 || q > 100000) e.quantity = 'Quantity must be a whole number 1–100000'
  const h = Number(v.households)
  if (!Number.isInteger(h) || h < 1 || h > 50000) e.households = 'Households must be 1–50000'
  if (v.contact_phone && !PHONE.test(v.contact_phone.replace(/[\s-]/g, ''))) e.contact_phone = 'Enter a valid phone, e.g. +8801712345678'
  return e
}

export function validateResource(v) {
  const e = {}
  if (!v.name || v.name.trim().length < 3) e.name = 'Name must be at least 3 characters'
  if (!v.resource_type) e.resource_type = 'Choose a type'
  const t = Number(v.quantity_total), a = Number(v.quantity_available)
  if (!Number.isInteger(t) || t < 0) e.quantity_total = 'Total must be a whole number ≥ 0'
  if (!Number.isInteger(a) || a < 0) e.quantity_available = 'Available must be a whole number ≥ 0'
  else if (Number.isInteger(t) && a > t) e.quantity_available = 'Available cannot exceed total'
  return e
}

export function validateRegister(v) {
  const e = {}
  if (!v.full_name || v.full_name.trim().length < 2) e.full_name = 'Enter your full name'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email || '')) e.email = 'Enter a valid email'
  if (!v.password || v.password.length < 8) e.password = 'Password must be at least 8 characters'
  else if (!/[0-9]/.test(v.password) || !/[A-Za-z]/.test(v.password)) e.password = 'Use letters and numbers'
  if (v.phone && !PHONE.test(v.phone.replace(/[\s-]/g, ''))) e.phone = 'Enter a valid phone, e.g. +8801712345678'
  return e
}

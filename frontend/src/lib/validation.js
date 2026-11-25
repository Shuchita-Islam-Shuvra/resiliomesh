import { emailPolicyError, normalizeBdPhone } from './identity'

export const DHAKA_BOUNDS = { minLat: 23.6, maxLat: 23.95, minLng: 90.25, maxLng: 90.55 }
const BD_PHONE_MSG = 'Enter a Bangladeshi mobile number, e.g. 01712345678'

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
  if (v.contact_phone && !normalizeBdPhone(v.contact_phone)) e.contact_phone = BD_PHONE_MSG
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const NAME = /^[\p{L}][\p{L}\p{M} .'-]{1,99}$/u
const EMPLOYEE_ID = /^[A-Za-z0-9/-]{3,30}$/

export const normalizePhone = (p = '') => normalizeBdPhone(p) || p.replace(/[\s-]/g, '')

export function validateEmail(email) {
  const s = (email || '').trim()
  if (!s) return 'Enter your email address'
  if (!EMAIL.test(s) || s.length > 254) return 'Enter a valid email address'
  return null
}

export function passwordStrength(pw = '') {
  if (!pw) return { score: 0, label: '' }
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++
  if (pw.length < 8) s = Math.min(s, 1)
  return { score: s, label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][s] }
}

export function validatePassword(pw, { email, staff } = {}) {
  if (!pw) return 'Choose a password'
  if (pw.length < 8) return 'Password must be at least 8 characters'
  if (pw.length > 72) return 'Password must be at most 72 characters'
  if (!/[0-9]/.test(pw) || !/[A-Za-z]/.test(pw)) return 'Use letters and numbers'
  if (/\s/.test(pw)) return 'Password cannot contain spaces'
  const local = (email || '').split('@')[0].toLowerCase()
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'Password must not contain your email name'
  if (staff && (pw.length < 10 || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[^A-Za-z0-9]/.test(pw)))
    return 'Staff passwords need 10+ characters with upper & lower case, a number and a symbol'
  return null
}

export function validateRegister(v, role = 'citizen', ctx = {}) {
  const e = {}
  const staff = role !== 'citizen'
  const name = (v.full_name || '').trim()
  if (name.length < 2) e.full_name = 'Enter your full name'
  else if (!NAME.test(name)) e.full_name = 'Use letters only (spaces, dot, hyphen and apostrophe allowed)'

  const em = validateEmail(v.email)
  if (em) e.email = em
  else if (staff && ctx.orgs) {
    const policy = emailPolicyError(v.email, role, ctx.org || null, ctx.orgs || [])
    if (policy) e.email = policy
  }

  const pw = validatePassword(v.password, { email: v.email, staff })
  if (pw) e.password = pw
  if ('confirm_password' in v && v.confirm_password !== v.password) e.confirm_password = 'Passwords do not match'

  if ('phone' in v || staff) {
    if (!(v.phone || '').trim()) e.phone = staff ? 'Mobile number is required for staff accounts' : 'Mobile number is required'
    else if (!normalizeBdPhone(v.phone)) e.phone = BD_PHONE_MSG
  }

  if (role === 'city_officer') {
    if (!v.organization_id) e.organization_id = 'Choose your city authority'
    if (!EMPLOYEE_ID.test((v.employee_id || '').trim())) e.employee_id = 'Employee ID: 3–30 letters, numbers, / or -'
    if ((v.designation || '').trim().length < 2) e.designation = 'Enter your designation'
  }
  if (role === 'ngo_coordinator') {
    if (!v.organization_id) e.organization_id = 'Choose your NGO'
    if (v.organization_id === 'other') {
      const n = (v.organization_name || '').trim()
      if (n.length < 3 || n.length > 120) e.organization_name = 'Enter the NGO name (3–120 characters)'
      if (!/^[A-Za-z0-9/-]{3,40}$/.test((v.registration_no || '').trim())) e.registration_no = 'Enter the NGO Affairs Bureau registration no.'
    }
    if ((v.designation || '').trim().length < 2) e.designation = 'Enter your designation'
    if (!v.ward_id) e.ward_id = 'Choose the main area you operate in'
  }
  if (role === 'field_worker') {
    if (!v.organization_id) e.organization_id = 'Choose the organisation you work for'
    if (!EMPLOYEE_ID.test((v.employee_id || '').trim())) e.employee_id = 'Staff ID: 3–30 letters, numbers, / or -'
    if (!v.team) e.team = 'Choose your team'
    if (!v.ward_id) e.ward_id = 'Choose your assigned area'
  }
  if ('accept_terms' in v && !v.accept_terms) e.accept_terms = 'You must accept the terms to continue'
  return e
}

export const SIGNIN_ID_LABEL = { city_officer: 'Employee ID', field_worker: 'Staff ID', admin: 'Admin ID' }

export function validateSignIn({ email, password, employee_id, organization_id }, role = 'citizen') {
  const e = {}
  const em = validateEmail(email)
  if (em) e.email = em
  if (!password) e.password = 'Enter your password'
  const idLabel = SIGNIN_ID_LABEL[role]
  if (idLabel) {
    if (!(employee_id || '').trim()) e.employee_id = `Enter your ${idLabel}`
    else if (!EMPLOYEE_ID.test(employee_id.trim())) e.employee_id = `${idLabel}: 3–30 letters, numbers, / or -`
  }
  if (role === 'ngo_coordinator' && !organization_id) e.organization_id = 'Choose your NGO'
  return e
}

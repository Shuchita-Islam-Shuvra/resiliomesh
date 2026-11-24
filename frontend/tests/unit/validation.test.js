// M06 / M07 — input validation mirrors DB constraints
import { describe, expect, it } from 'vitest'
import { validateNeed, validateRegister, validateReport, validateResource, validateSignIn } from '../../src/lib/validation'
import { errorMessage } from '../../src/lib/errors'

const good = { title: 'Knee-deep water', description: 'Water entering shops on main road', category: 'waterlogging', ward_id: 'DSCC-02', severity_reported: 4, water_depth_cm: 45, people_affected: 120, lat: 23.739, lng: 90.414 }

describe('validateReport', () => {
  it('accepts a valid report', () => expect(validateReport(good)).toEqual({}))
  it('rejects short title / description', () => {
    const e = validateReport({ ...good, title: 'abc', description: 'short' })
    expect(e.title).toBeTruthy(); expect(e.description).toBeTruthy()
  })
  it('rejects out-of-range depth and negative people', () => {
    const e = validateReport({ ...good, water_depth_cm: 500, people_affected: -3 })
    expect(e.water_depth_cm).toBeTruthy(); expect(e.people_affected).toBeTruthy()
  })
  it('rejects locations outside Dhaka', () => {
    expect(validateReport({ ...good, lat: 22.3, lng: 91.8 }).location).toMatch(/Dhaka/)
    expect(validateReport({ ...good, lat: '', lng: '' }).location).toBeTruthy()
  })
})

describe('other validators', () => {
  it('need quantity and phone', () => {
    const e = validateNeed({ ward_id: 'X', need_type: 'relief_kit', quantity: 0, households: 5, contact_phone: '12ab' })
    expect(e.quantity).toBeTruthy(); expect(e.contact_phone).toBeTruthy()
  })
  it('resource available cannot exceed total', () => {
    expect(validateResource({ name: 'Pumps', resource_type: 'pump', quantity_total: 3, quantity_available: 5 }).quantity_available).toMatch(/exceed/)
  })
  it('weak passwords rejected', () => {
    expect(validateRegister({ full_name: 'A B', email: 'a@b.co', password: 'password' }).password).toBeTruthy()
    expect(validateRegister({ full_name: 'A B', email: 'a@b.co', password: 'monsoon2026' })).toEqual({})
  })
})

describe('errorMessage', () => {
  it('maps database business errors to readable text', () => {
    expect(errorMessage({ message: 'INSUFFICIENT_STOCK: 1 requested, 0 available for Pump' })).toBe('1 requested, 0 available for Pump')
    expect(errorMessage({ code: '23505', message: 'duplicate key' })).toMatch(/duplicate/i)
    expect(errorMessage({ message: 'new row violates row-level security policy' })).toMatch(/permission/)
  })
})

describe('validateRegister by role', () => {
  const base = { full_name: 'Rahim Uddin', email: 'rahim@dncc.gov.bd', password: 'Monsoon#2026x', confirm_password: 'Monsoon#2026x', phone: '+8801712345678', accept_terms: true }
  it('citizen: confirm password + terms are enforced', () => {
    const e = validateRegister({ ...base, confirm_password: 'nope', accept_terms: false })
    expect(e.confirm_password).toBeTruthy(); expect(e.accept_terms).toBeTruthy()
  })
  it('staff need a strong password and a mobile', () => {
    const e = validateRegister({ ...base, password: 'monsoon2026', confirm_password: 'monsoon2026', phone: '' }, 'field_worker')
    expect(e.password).toMatch(/10\+/); expect(e.phone).toBeTruthy()
  })
  it('city officer needs authority, employee id and designation', () => {
    const e = validateRegister(base, 'city_officer')
    expect(Object.keys(e).sort()).toEqual(['designation', 'employee_id', 'organization_id'])
    expect(validateRegister({ ...base, organization_id: 'x', employee_id: 'DNCC-2024-118', designation: 'Assistant Engineer' }, 'city_officer')).toEqual({})
  })
  it('NGO "other" needs name + registration number', () => {
    const e = validateRegister({ ...base, organization_id: 'other', designation: 'Coordinator', ward_id: 'DSCC-02' }, 'ngo_coordinator')
    expect(e.organization_name).toBeTruthy(); expect(e.registration_no).toBeTruthy()
  })
})

describe('validateSignIn by role', () => {
  const base = { email: 'a@b.co', password: 'x' }
  it('citizen needs only email + password', () => expect(validateSignIn(base, 'citizen')).toEqual({}))
  it('officer / field / admin need their ID', () => {
    expect(validateSignIn(base, 'city_officer').employee_id).toMatch(/Employee ID/)
    expect(validateSignIn(base, 'field_worker').employee_id).toMatch(/Staff ID/)
    expect(validateSignIn({ ...base, employee_id: 'ADM-001' }, 'admin')).toEqual({})
  })
  it('NGO needs the organisation', () => expect(validateSignIn(base, 'ngo_coordinator').organization_id).toBeTruthy())
})

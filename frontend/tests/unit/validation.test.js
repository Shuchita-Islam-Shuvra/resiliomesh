// M06 / M07 — input validation mirrors DB constraints
import { describe, expect, it } from 'vitest'
import { validateNeed, validateRegister, validateReport, validateResource } from '../../src/lib/validation'
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

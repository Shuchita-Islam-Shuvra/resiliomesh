import { describe, expect, it } from 'vitest'
import { emailPolicyError, normalizeBdPhone } from '../../src/lib/identity'
import { parseCsv } from '../../src/lib/csv'
import { validateNeed, validateRegister } from '../../src/lib/validation'
import { sessionGate } from '../../src/context/AuthContext'

const DSCC = { id: 's', type: 'city_authority', email_domains: ['dscc.gov.bd'] }
const DNCC = { id: 'n', type: 'city_authority', email_domains: ['dncc.gov.bd'] }
const NGO = { id: 'g', type: 'ngo', email_domains: ['shobarjonno.org.bd'] }
const NGO_NO_DOMAIN = { id: 'h', type: 'ngo', email_domains: [] }
const ORGS = [DSCC, DNCC, NGO, NGO_NO_DOMAIN]

describe('Bangladeshi mobile numbers only', () => {
  it('normalises local, international and formatted numbers to +8801XXXXXXXXX', () => {
    expect(normalizeBdPhone('01712345678')).toBe('+8801712345678')
    expect(normalizeBdPhone('+880 1712-345678')).toBe('+8801712345678')
    expect(normalizeBdPhone('8801912345678')).toBe('+8801912345678')
  })
  it('rejects foreign, landline and invalid operator numbers', () => {
    for (const p of ['+14155550100', '+447700900123', '029876543', '01212345678', '0171234', '']) expect(normalizeBdPhone(p)).toBeNull()
  })
  it('sign-up requires a BD mobile for citizens too', () => {
    const base = { full_name: 'Rahim Uddin', email: 'rahim@example.com', password: 'monsoon2026' }
    expect(validateRegister({ ...base, phone: '' }).phone).toMatch(/required/)
    expect(validateRegister({ ...base, phone: '+14155550100' }).phone).toMatch(/Bangladeshi/)
    expect(validateRegister({ ...base, phone: '01712345678' })).toEqual({})
  })
  it('community-need contact phones must be Bangladeshi', () => {
    const v = { ward_id: 'X', need_type: 'relief_kit', quantity: 1, households: 1 }
    expect(validateNeed({ ...v, contact_phone: '+14155550100' }).contact_phone).toBeTruthy()
    expect(validateNeed({ ...v, contact_phone: '01711-000001' })).toEqual({})
  })
})

describe('official e-mail domains', () => {
  it('city officers need their own corporation domain (sub-domains allowed)', () => {
    expect(emailPolicyError('a@gmail.com', 'city_officer', DSCC, ORGS)).toMatch(/@dscc\.gov\.bd/)
    expect(emailPolicyError('a@dncc.gov.bd', 'city_officer', DSCC, ORGS)).toMatch(/@dscc\.gov\.bd/)
    expect(emailPolicyError('a@dscc.gov.bd', 'city_officer', DSCC, ORGS)).toBeNull()
    expect(emailPolicyError('a@eng.dscc.gov.bd', 'city_officer', DSCC, ORGS)).toBeNull()
    expect(emailPolicyError('a@notdscc.gov.bd', 'city_officer', DSCC, ORGS)).toBeTruthy()
  })
  it('NGO coordinators cannot use public mail; listed domains are enforced', () => {
    expect(emailPolicyError('a@yahoo.com', 'ngo_coordinator', null, ORGS)).toMatch(/public mail/)
    expect(emailPolicyError('a@newngo.org', 'ngo_coordinator', null, ORGS)).toBeNull()
    expect(emailPolicyError('a@other.org', 'ngo_coordinator', NGO, ORGS)).toMatch(/shobarjonno/)
    expect(emailPolicyError('a@anything.org', 'ngo_coordinator', NGO_NO_DOMAIN, ORGS)).toBeNull()
  })
  it('field workers are not blocked by domain (admins see it as a flag)', () => {
    expect(emailPolicyError('a@gmail.com', 'field_worker', DSCC, ORGS)).toBeNull()
  })
  it('validateRegister applies the domain rule when organisations are known', () => {
    const v = { full_name: 'Rahim Uddin', email: 'rahim@gmail.com', password: 'Monsoon#2026x', phone: '01712345678', organization_id: 's', employee_id: 'DSCC-1', designation: 'Engineer' }
    expect(validateRegister(v, 'city_officer', { org: DSCC, orgs: ORGS }).email).toMatch(/dscc/)
    expect(validateRegister({ ...v, email: 'rahim@dscc.gov.bd' }, 'city_officer', { org: DSCC, orgs: ORGS })).toEqual({})
  })
})

describe('roster / registry CSV upload', () => {
  it('parses headers, quotes, escaped quotes, CRLF and BOM', () => {
    const rows = parseCsv('﻿Employee ID,Official Email,Full Name\r\nDSCC-1,a@dscc.gov.bd,"Uddin, Rahim"\r\n\r\nDSCC-2,,"Said ""Hi"""\n')
    expect(rows).toEqual([
      { employee_id: 'DSCC-1', official_email: 'a@dscc.gov.bd', full_name: 'Uddin, Rahim' },
      { employee_id: 'DSCC-2', official_email: '', full_name: 'Said "Hi"' },
    ])
    expect(parseCsv('')).toEqual([])
  })
})

describe('session gate (which verification step a staff session still owes)', () => {
  const st = { account_role: 'city_officer', is_active: true, staff_verified: true, mfa_required: false, aal: 'aal1' }
  it('citizens never see a gate', () => expect(sessionGate({ ...st, account_role: 'citizen', staff_verified: false })).toBeNull())
  it('password-only staff session must confirm the staff ID', () => expect(sessionGate({ ...st, staff_verified: false })).toBe('staff_id'))
  it('then the authenticator code when MFA applies', () => {
    expect(sessionGate({ ...st, mfa_required: true })).toBe('mfa')
    expect(sessionGate({ ...st, mfa_required: true, aal: 'aal2' })).toBeNull()
  })
  it('no status (migration not applied) means no gate', () => expect(sessionGate(null)).toBeNull())
})

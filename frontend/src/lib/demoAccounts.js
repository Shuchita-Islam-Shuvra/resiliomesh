export const DEMO_DOMAIN = '@resiliomesh.demo'

export const DEMO_STAFF_IDS = {
  'officer@resiliomesh.demo': 'DSCC-OFF-01',
  'officer2@resiliomesh.demo': 'DNCC-OFF-02',
  'admin@resiliomesh.demo': 'ADM-001',
  'admin2@resiliomesh.demo': 'ADM-002',
  'field1@resiliomesh.demo': 'FW-001',
  'field2@resiliomesh.demo': 'FW-002',
  'field3@resiliomesh.demo': 'FW-003',
  'field4@resiliomesh.demo': 'FW-004',
  'field5@resiliomesh.demo': 'FW-005',
  'field6@resiliomesh.demo': 'FW-006',
  'field7@resiliomesh.demo': 'FW-007',
}

export const DEMO_NGO_ORGS = {
  'ngo@resiliomesh.demo': '11111111-1111-1111-1111-111111111103',
  'ngo2@resiliomesh.demo': '11111111-1111-1111-1111-111111111104',
}

export const isDemoEmail = (email) => String(email || '').toLowerCase().endsWith(DEMO_DOMAIN)

export function demoSignInFor(email) {
  const e = String(email || '').toLowerCase()
  if (!isDemoEmail(e)) return null
  return { staffId: DEMO_STAFF_IDS[e] || null, orgId: DEMO_NGO_ORGS[e] || null }
}

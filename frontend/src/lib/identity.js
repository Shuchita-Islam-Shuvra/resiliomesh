export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru',
  'zoho.com', 'zohomail.com', 'tutanota.com', 'tuta.io', 'rediffmail.com', 'mail.ru', 'qq.com', '163.com',
  'hey.com', 'fastmail.com', 'inbox.com', 'hushmail.com', 'mailinator.com', 'guerrillamail.com',
  'temp-mail.org', '10minutemail.com', 'yopmail.com', 'sharklasers.com',
])

export const emailDomain = (email = '') => (email.trim().toLowerCase().split('@')[1] || '')
export const domainMatches = (domain, allowed = []) =>
  Boolean(domain) && allowed.some((a) => domain === a.toLowerCase() || domain.endsWith(`.${a.toLowerCase()}`))

export function emailPolicyError(email, role, org, allOrgs = []) {
  const d = emailDomain(email)
  if (!d) return null
  const domains = org?.email_domains || []
  if (role === 'city_officer') {
    const ok = org ? domainMatches(d, domains)
      : allOrgs.some((o) => o.type === 'city_authority' && domainMatches(d, o.email_domains || []))
    if (!ok) {
      if (!org) return 'Use your official city corporation e-mail address'
      return domains.length
        ? `Use your official ${domains.map((x) => `@${x}`).join(' or ')} e-mail address`
        : 'This city authority has no official e-mail domain on record yet — ask a system administrator'
    }
  }
  if (role === 'ngo_coordinator') {
    if (FREEMAIL.has(d)) return 'Use your organisation e-mail address, not a public mail provider'
    if (org && domains.length && !domainMatches(d, domains)) return `Use your ${domains.map((x) => `@${x}`).join(' or ')} e-mail address`
  }
  return null
}

export function normalizeBdPhone(p = '') {
  const d = String(p).replace(/[^0-9]/g, '')
  if (/^8801[3-9][0-9]{8}$/.test(d)) return `+${d}`
  if (/^01[3-9][0-9]{8}$/.test(d)) return `+88${d}`
  if (/^1[3-9][0-9]{8}$/.test(d)) return `+880${d}`
  return null
}

export const CHECK_LABEL = {
  roster: {
    verified: ['ok', 'On staff roster'], id_only: ['warn', 'ID on roster (no e-mail on file)'],
    email_mismatch: ['bad', 'Roster e-mail differs'], other_org: ['bad', 'ID belongs to another organisation'],
    inactive: ['bad', 'Inactive on roster'], role_mismatch: ['bad', 'Different role on roster'],
    not_found: ['bad', 'Not on staff roster'], 'n/a': null,
  },
  email_domain: { official: ['ok', 'Official e-mail domain'], unlisted: ['bad', 'E-mail not on org domain'], freemail: ['bad', 'Public mail provider'] },
  ngoab: {
    verified: ['ok', 'NGOAB registration verified'], not_found: ['bad', 'NGOAB number not in registry'],
    inactive: ['bad', 'NGOAB registration expired / cancelled'], missing: ['bad', 'No NGOAB number'], 'n/a': null,
  },
}

export const BLOCKER_LABEL = {
  organisation_missing: 'Choose the organisation',
  organisation_type: 'Organisation type does not fit the role',
  staff_id_missing: 'No staff ID',
  staff_id_taken: 'Staff ID already used by another account',
  email_domain: 'E-mail domain not allowed for this role',
  email_unconfirmed: 'E-mail address not confirmed',
  phone_unverified: 'Mobile number not verified (OTP)',
  phone_missing: 'No mobile number on the account (needed to make sure one person holds one NGO post)',
  ngo_seat_taken: 'This person already holds an NGO Coordinator post on another account (same mobile number)',
  documents_missing: 'No ID card / appointment letter uploaded',
  account_inactive: 'Account is deactivated',
}

export const FLAG_LABEL = {
  email_domain: 'e-mail domain', roster: 'staff roster', ngoab: 'NGOAB registration',
  roster_uploaded_by_reviewer: 'you uploaded the matching roster entry',
  ngoab_uploaded_by_reviewer: 'you uploaded the matching NGOAB entry',
  ngo_transfer: 'moves an NGO Coordinator from another NGO; the old post ends',
}

export const TRUST_FLAG_LABEL = {
  phone_unverified: 'Phone not verified',
  new_account: 'New account (< 24 h)',
  outside_home_area: 'Far from reporter\'s home area',
  far_from_ward_centre: 'Pin far from ward centre',
  foreign_network: 'Sent from a foreign network',
  tor_network: 'Sent via Tor',
}

export const DOC_KINDS = [
  ['id_card', 'Office ID card'],
  ['appointment_letter', 'Appointment / posting letter'],
  ['ngo_certificate', 'NGOAB registration certificate'],
  ['other', 'Other supporting document'],
]

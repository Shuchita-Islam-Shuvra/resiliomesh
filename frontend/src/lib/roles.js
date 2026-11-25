import { HardHat, HeartHandshake, Landmark, ShieldCheck, UserRound } from 'lucide-react'

export const ROLES = [
  {
    key: 'admin', short: 'Admin', label: 'Admin', icon: ShieldCheck, selfRegister: false,
    tagline: 'Platform administration, access approval and audit.',
    signInSubtitle: 'Restricted to platform administrators.',
    points: ['Approve staff access requests', 'Role & organisation management', 'Append-only audit trail and system health'],
  },
  {
    key: 'city_officer', short: 'Officer', label: 'Water Resilience Officer', icon: Landmark, selfRegister: 'request',
    tagline: 'Verify reports, run AI risk scoring and dispatch pumps and crews in your area: Dhaka North or Dhaka South.',
    signInSubtitle: 'Drainage staff of Dhaka North (DNCC) or Dhaka South (DSCC) City Corporation.',
    points: ['Verify and triage reports in your area', 'Ward-level XGBoost risk scoring', 'Optimised pump & crew dispatch'],
  },
  {
    key: 'ngo_coordinator', short: 'NGO', label: 'NGO Coordinator', icon: HeartHandshake, selfRegister: 'request',
    tagline: 'Log community needs, manage relief stock and coordinate deliveries anywhere in Dhaka, North or South.',
    signInSubtitle: 'Relief organisations coordinating aid across all of Dhaka. One coordinator, one NGO.',
    points: ['Log household needs per ward', 'Manage relief stock with duplicate-aid blocking', 'Coordinate deliveries with other NGOs'],
  },
  {
    key: 'field_worker', short: 'Field', label: 'Field Worker', icon: HardHat, selfRegister: 'request',
    tagline: 'Receive tasks on your phone and update them even without signal.',
    signInSubtitle: 'Drainage crews and pump operators of Dhaka North or South City Corporation (their own area), and NGO relief teams anywhere in Dhaka.',
    points: ['Crew tasks matched to your team, on your phone', 'Works offline, syncs on reconnect', 'On/off duty, decline before accepting, GPS proof of work'],
  },
  {
    key: 'citizen', short: 'Citizen', label: 'Citizen', icon: UserRound, selfRegister: true,
    tagline: 'Report waterlogging and blocked drains in your area and track the response.',
    signInSubtitle: 'Sign in to report flooding and follow your reports.',
    points: ['Report waterlogging with photo, depth and GPS', 'Track every report from verification to resolution', 'Live risk map of your own city corporation (Dhaka North or South)'],
  },
]

export const ROLE_BY_KEY = Object.fromEntries(ROLES.map((r) => [r.key, r]))
export const roleOrDefault = (k, fallback = 'citizen') => (ROLE_BY_KEY[k] ? k : fallback)

export const ROLE_ORG_TYPES = {
  city_officer: ['city_authority'],
  ngo_coordinator: ['ngo'],
  field_worker: ['city_authority', 'ngo'],
}

export const FIELD_TEAMS = ['Drainage crew', 'Pump operator', 'Relief distribution', 'Damage survey', 'Medical / first aid']

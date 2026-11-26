const FRIENDLY = {
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'The record no longer exists.',
  INSUFFICIENT_STOCK: 'Not enough stock left — someone else may have just reserved it.',
  INVALID_TRANSITION: 'That status change is not allowed from the current state.',
  INVALID_STATE: 'The record changed state; refresh and try again.',
  STALE_PLAN: 'This plan is too old. Re-run the optimiser.',
  INFEASIBLE: 'This plan cannot be executed.',
  VALIDATION: 'Please check the input.',
  RATE_LIMITED: 'Too many requests — please wait a moment.',
  PHONE_NOT_VERIFIED: 'Verify your mobile number under Account & security first.',
  CONFLICT: 'Someone else already changed this — refresh and try again.',
  UNAUTHENTICATED: 'Please sign in again.',
  NETWORK: 'Network problem — check your connection.',
  TIMEOUT: 'The server took too long to respond.',
}

export function errorCode(err) {
  if (!err) return null
  if (err.code && FRIENDLY[err.code]) return err.code
  const msg = String(err.message || err.error || err)
  const prefix = msg.split(':')[0].trim()
  if (FRIENDLY[prefix]) return prefix
  if (err.code === '23505') return 'DUPLICATE'
  if (err.code === '42501') return 'FORBIDDEN'
  return null
}

export function errorMessage(err) {
  if (!err) return ''
  const msg = String(err.message || err.error || err)
  const code = errorCode(err)
  if (code === 'DUPLICATE') return 'This record already exists (duplicate prevented).'
  if (code && msg.includes(':')) return msg.split(':').slice(1).join(':').trim() || FRIENDLY[code]
  if (code) return FRIENDLY[code]
  if (/row-level security/i.test(msg)) return FRIENDLY.FORBIDDEN
  if (/Failed to fetch|NetworkError/i.test(msg)) return FRIENDLY.NETWORK
  return msg
}

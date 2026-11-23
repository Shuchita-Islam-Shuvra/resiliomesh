import { supabase } from './supabase'

const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function token() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token
}

/** fetch wrapper: auth header, timeout, JSON errors, optional idempotency key */
export async function api(path, { method = 'GET', body, timeoutMs = 20000, idempotencyKey, form } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const headers = { Authorization: `Bearer ${await token()}` }
  if (body && !form) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method, headers, signal: ctrl.signal,
      body: form || (body ? JSON.stringify(body) : undefined),
    })
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. The backend may be waking up — try again in a few seconds.')
    throw new ApiError(0, 'NETWORK', 'Cannot reach the ResilioMesh API.')
  }
  clearTimeout(timer)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const details = Array.isArray(data.details) ? data.details.map((d) => `${d.field}: ${d.message}`).join('; ') : ''
    throw new ApiError(res.status, data.error || `HTTP_${res.status}`, `${data.message || data.detail || 'Request failed'}${details ? ` (${details})` : ''}`, data.details)
  }
  return data
}

/** Supabase RPC returning {ok:false, conflict:true, current} on version mismatch */
export async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data
}

export const apiBase = BASE

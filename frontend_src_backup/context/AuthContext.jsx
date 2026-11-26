import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { AREA_BOUND_ROLES, canManageArea as canManageAreaFor } from '../lib/areas'
import { normalizeBdPhone } from '../lib/identity'
import { supabase } from '../lib/supabase'

const AuthCtx = createContext(null)

const isMissingFn = (e) => e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|does not exist/i.test(e.message || ''))

export function sessionGate(status) {
  if (!status || status.account_role === 'citizen' || !status.is_active) return null
  if (!status.staff_verified) return 'staff_id'
  if (status.mfa_required && status.aal !== 'aal2') return 'mfa'
  return null
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [org, setOrg] = useState(null)
  const [security, setSecurity] = useState(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const loadProfile = useCallback(async (s) => {
    const my = ++seq.current
    if (!s?.user) { setProfile(null); setOrg(null); setSecurity(null); return }
    const [{ data, error }, st] = await Promise.all([
      supabase.from('profiles').select('*, organizations(*)').eq('id', s.user.id).maybeSingle(),
      supabase.rpc('rm_session_status'),
    ])
    if (my !== seq.current) return
    if (error || !data) { setProfile(null); setSecurity(null); return }
    if (!data.is_active) {
      await supabase.auth.signOut()
      setProfile(null); setSecurity(null)
      return
    }
    const status = st.error ? null : st.data
    if (st.error && !isMissingFn(st.error)) console.warn('session status unavailable', st.error.message)
    setProfile({ ...data, account_role: data.role, role: status ? (status.effective_role || 'citizen') : data.role })
    setOrg(data.organizations || null)
    setSecurity(status ? { ...status, gate: sessionGate(status) } : null)
  }, [])

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      await loadProfile(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      setTimeout(() => loadProfile(s), 0)
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  useEffect(() => {
    if (!supabase || !session?.user) return
    const ch = supabase.channel(`me:${session.user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${session.user.id}` },
        () => loadProfile(session))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [session, loadProfile])

  useEffect(() => {
    const until = security?.staff_expires_at && new Date(security.staff_expires_at).getTime()
    if (!until || !session) return
    const t = setTimeout(() => loadProfile(session), Math.max(1000, Math.min(until - Date.now() + 1000, 2 ** 31 - 1)))
    return () => clearTimeout(t)
  }, [security?.staff_expires_at, session, loadProfile])

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    setSession(data.session)
    await loadProfile(data.session)
  }, [loadProfile])

  const value = useMemo(() => {
    const signOut = async () => {
      try { await supabase.rpc('rm_end_staff_session') } catch { }
      await supabase.auth.signOut()
      setProfile(null); setSecurity(null)
    }
    const fail = async (code, message, extra = {}) => {
      await signOut()
      throw Object.assign(new Error(message), { code, ...extra })
    }

    const verifyStaff = async (role, extra = {}) => {
      const { data: r, error } = await supabase.rpc('rm_verify_staff_login', {
        p_role: role, p_staff_id: (extra.employee_id || '').trim() || null, p_org_id: extra.organization_id || null,
      })
      if (error) throw error
      return r
    }

    const legacyCheck = async (uid, expectedRole, extra) => {
      const { data: p } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
      if (!p) return fail('NO_PROFILE', 'Your profile could not be loaded. Please try again.')
      if (p.role !== expectedRole) return { code: 'ROLE_MISMATCH', actual_role: p.role }
      if (['city_officer', 'field_worker', 'admin'].includes(expectedRole) && 'employee_id' in p &&
          (p.employee_id || '').trim().toUpperCase() !== (extra.employee_id || '').trim().toUpperCase())
        return { code: 'ID_MISMATCH' }
      if (expectedRole === 'ngo_coordinator' && p.organization_id !== extra.organization_id) return { code: 'ORG_MISMATCH' }
      return { ok: true }
    }

    const explainFailure = async (r, uid, expectedRole) => {
      switch (r.code) {
        case 'ROLE_MISMATCH': {
          const { data: req } = await supabase.from('role_requests')
            .select('requested_role, status, review_note, created_at').eq('user_id', uid)
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (req && req.requested_role === expectedRole && req.status === 'pending')
            return fail('ROLE_PENDING', 'Your access request is waiting for administrator approval.', { request: req })
          if (req && req.requested_role === expectedRole && req.status === 'rejected')
            return fail('ROLE_REJECTED', 'Your access request was not approved.', { request: req })
          return fail('ROLE_MISMATCH', 'This account is registered with a different role.', { actualRole: r.actual_role })
        }
        case 'ID_MISMATCH': case 'ORG_MISMATCH':
          return fail('ID_MISMATCH', 'The ID does not match this account.', { attemptsLeft: r.attempts_left })
        case 'LOCKED':
          return fail('LOCKED', `Too many wrong IDs for this account. Try again in ${Math.ceil((r.retry_after_s || 60) / 60)} min.`, { retryAfter: r.retry_after_s })
        case 'ID_MISSING':
          return fail('ID_MISSING', 'No staff ID is on record for this account yet. Ask a system administrator to add it.')
        case 'INACTIVE':
          return fail('INACTIVE', 'This account has been deactivated. Contact a system administrator.')
        default:
          return fail(r.code || 'NO_PROFILE', 'Your sign-in could not be verified. Please try again.')
      }
    }

    async function finishRoleSignIn(data, expectedRole, extra = {}) {
      const uid = data.user.id
      let r
      if (expectedRole === 'citizen') {
        const { data: p, error: pErr } = await supabase.from('profiles').select('role, is_active').eq('id', uid).maybeSingle()
        if (pErr || !p) return fail('NO_PROFILE', 'Your profile could not be loaded. Please try again.')
        if (!p.is_active) return fail('INACTIVE', 'This account has been deactivated. Contact a system administrator.')
        r = p.role === 'citizen' ? { ok: true } : { code: 'ROLE_MISMATCH', actual_role: p.role }
      } else {
        try { r = await verifyStaff(expectedRole, extra) } catch (e) {
          if (!isMissingFn(e)) { await signOut(); throw e }
          r = await legacyCheck(uid, expectedRole, extra)
        }
      }
      if (!r?.ok) return explainFailure(r || {}, uid, expectedRole)
      await loadProfile(data.session)
      return { ...data, mfa: Boolean(r.mfa_required && r.aal !== 'aal2') }
    }

    return {
      session, profile, org, loading, security,
      role: profile?.role,
      hasRole: (...roles) => Boolean(profile && roles.includes(profile.role)),
      isStaff: Boolean(profile && profile.role !== 'citizen'),
      adminScope: profile?.role === 'admin' ? (profile.admin_scope || 'owner') : null,
      isSystemOwner: profile?.role === 'admin' && (profile.admin_scope || 'owner') === 'owner',
      area: AREA_BOUND_ROLES.includes(profile?.role) ? (org?.city_corporation || null) : null,
      canManageArea: (wardArea) => canManageAreaFor(profile?.role, org?.city_corporation, wardArea),
      refreshProfile: refresh,
      signOut,
      signIn: async (email, password) => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        return data
      },
      signInAs: async (email, password, expectedRole, extra = {}) => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        return finishRoleSignIn(data, expectedRole, extra)
      },
      signInDemo: async (profileKey, code) => {
        const r = await api('/api/demo/session', { method: 'POST', body: { profile: profileKey, code }, timeoutMs: 90000 })
        const { data, error } = await supabase.auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token })
        if (error) throw error
        return finishRoleSignIn(data, r.role, r.extra || {})
      },
      verifyStaffSession: async (extra = {}) => {
        const r = await verifyStaff(profile?.account_role, extra)
        if (!r?.ok) throw Object.assign(new Error(r?.code === 'LOCKED'
          ? `Too many wrong IDs. Try again in ${Math.ceil((r.retry_after_s || 60) / 60)} min.`
          : r?.code === 'ID_MISSING' ? 'No staff ID is on record for this account. Ask a system administrator.'
          : `That ${profile?.account_role === 'ngo_coordinator' ? 'NGO' : 'ID'} does not match this account.${r?.attempts_left != null ? ` ${r.attempts_left} attempt${r.attempts_left === 1 ? '' : 's'} left.` : ''}`),
        { code: r?.code })
        await refresh()
        return r
      },
      signUp: async ({ email, password, full_name, phone, ward_id, ...extra }) => {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name, phone, ward_id, ...extra }, emailRedirectTo: `${window.location.origin}/login` },
        })
        if (error) throw error
        return data
      },
      sendPasswordReset: async (email) => {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
        if (error) throw error
      },
      updatePassword: async (password) => {
        const { error } = await supabase.auth.updateUser({ password })
        if (error) throw error
      },
      startPhoneVerification: async (phone) => {
        const e164 = normalizeBdPhone(phone)
        if (!e164) throw new Error('Enter a Bangladeshi mobile number, e.g. 01712345678')
        const { error } = await supabase.auth.updateUser({ phone: e164 })
        if (error) throw error
        return e164
      },
      confirmPhone: async (phone, token) => {
        const { error } = await supabase.auth.verifyOtp({ phone: normalizeBdPhone(phone), token: token.trim(), type: 'phone_change' })
        if (error) throw error
        await refresh()
      },
      mfa: {
        list: async () => {
          const { data, error } = await supabase.auth.mfa.listFactors()
          if (error) throw error
          return data?.totp || []
        },
        enroll: async () => {
          const { data: f } = await supabase.auth.mfa.listFactors()
          for (const x of (f?.all || []).filter((x) => x.factor_type === 'totp' && x.status !== 'verified'))
            await supabase.auth.mfa.unenroll({ factorId: x.id })
          const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `ResilioMesh ${new Date().toISOString().slice(0, 16)}` })
          if (error) throw error
          return data
        },
        verify: async (factorId, code) => {
          const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
          if (error) throw error
          await refresh()
        },
        unenroll: async (factorId) => {
          const { error } = await supabase.auth.mfa.unenroll({ factorId })
          if (error) throw error
          await refresh()
        },
      },
    }
  }, [session, profile, org, loading, security, loadProfile, refresh])

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export const useAuth = () => useContext(AuthCtx)

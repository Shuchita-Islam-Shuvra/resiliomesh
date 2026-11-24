import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [org, setOrg] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadProfile = useCallback(async (s) => {
    if (!s?.user) { setProfile(null); setOrg(null); return }
    const { data, error } = await supabase.from('profiles')
      .select('id, full_name, email, phone, role, organization_id, ward_id, is_active, organizations(name, type)')
      .eq('id', s.user.id).maybeSingle()
    if (error || !data) { setProfile(null); return }
    if (!data.is_active) {          // deactivated accounts are signed out immediately
      await supabase.auth.signOut()
      setProfile(null)
      return
    }
    setProfile(data)
    setOrg(data.organizations || null)
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
      // defer DB call out of the auth callback (supabase-js recommendation)
      setTimeout(() => loadProfile(s), 0)
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  // react instantly if an admin changes my role / deactivates me
  useEffect(() => {
    if (!supabase || !session?.user) return
    const ch = supabase.channel(`me:${session.user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${session.user.id}` },
        () => loadProfile(session))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [session, loadProfile])

  const value = useMemo(() => ({
    session, profile, org, loading,
    role: profile?.role,
    hasRole: (...roles) => Boolean(profile && roles.includes(profile.role)),
    isStaff: Boolean(profile && profile.role !== 'citizen'),
    signIn: async (email, password) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      return data
    },
    /**
     * Sign in and check the account matches the role picked in the capsule.
     * On a mismatch the session is closed again and an error with `.code` is thrown:
     *   ROLE_MISMATCH (err.actualRole), ROLE_PENDING / ROLE_REJECTED (err.request), INACTIVE.
     */
    signInAs: async (email, password, expectedRole, extra = {}) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      const uid = data.user.id
      // '*' so sign-in still works if migration 007 (employee_id) has not been applied yet
      const { data: p, error: pErr } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
      const fail = async (code, message, extra = {}) => {
        await supabase.auth.signOut()
        setProfile(null)
        throw Object.assign(new Error(message), { code, ...extra })
      }
      if (pErr || !p) return fail('NO_PROFILE', 'Your profile could not be loaded. Please try again.')
      if (!p.is_active) return fail('INACTIVE', 'This account has been deactivated. Contact a system administrator.')
      if (p.role === expectedRole) {
        // role-specific second identifier (Employee / Staff / Admin ID, or the NGO)
        if (['city_officer', 'field_worker', 'admin'].includes(expectedRole) && 'employee_id' in p) {
          if (!p.employee_id) return fail('ID_MISSING', 'No staff ID is on record for this account yet. Ask a system administrator to add it.')
          if (p.employee_id.trim().toUpperCase() !== (extra.employee_id || '').trim().toUpperCase())
            return fail('ID_MISMATCH', 'The ID does not match this account.')
        }
        if (expectedRole === 'ngo_coordinator' && p.organization_id !== extra.organization_id)
          return fail('ID_MISMATCH', 'This account is not registered with the selected NGO.')
        return data
      }
      // the account may have asked for this staff role at sign-up and still be waiting
      const { data: req } = await supabase.from('role_requests')
        .select('requested_role, status, review_note, created_at').eq('user_id', uid)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (req && req.requested_role === expectedRole && req.status === 'pending')
        return fail('ROLE_PENDING', 'Your access request is waiting for administrator approval.', { request: req })
      if (req && req.requested_role === expectedRole && req.status === 'rejected')
        return fail('ROLE_REJECTED', 'Your access request was not approved.', { request: req })
      return fail('ROLE_MISMATCH', 'This account is registered with a different role.', { actualRole: p.role })
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
    signOut: async () => { await supabase.auth.signOut(); setProfile(null) },
    refreshProfile: () => loadProfile(session),
  }), [session, profile, org, loading, loadProfile])

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export const useAuth = () => useContext(AuthCtx)

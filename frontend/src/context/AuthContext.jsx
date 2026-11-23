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
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    },
    signUp: async ({ email, password, full_name, phone, ward_id }) => {
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { data: { full_name, phone, ward_id } },
      })
      if (error) throw error
      return data
    },
    signOut: async () => { await supabase.auth.signOut(); setProfile(null) },
    refreshProfile: () => loadProfile(session),
  }), [session, profile, org, loading, loadProfile])

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export const useAuth = () => useContext(AuthCtx)

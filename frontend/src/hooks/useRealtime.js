import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

/** Subscribe to postgres_changes on one or more tables; calls onChange(payload). */
export function useRealtime(tables, onChange, { filter } = {}) {
  const cb = useRef(onChange)
  cb.current = onChange
  const key = Array.isArray(tables) ? tables.join(',') : tables
  useEffect(() => {
    if (!supabase) return
    const ch = supabase.channel(`rt:${key}:${filter || 'all'}:${Math.random().toString(36).slice(2, 8)}`)
    for (const t of key.split(',')) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t, ...(filter ? { filter } : {}) },
        (payload) => cb.current?.(payload))
    }
    ch.subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [key, filter])
}

/** Presence: who else is looking at this record right now (A01). */
export function usePresence(room, me) {
  const [peers, setPeers] = useState([])
  useEffect(() => {
    if (!supabase || !me?.id) return
    const ch = supabase.channel(`presence:${room}`, { config: { presence: { key: me.id } } })
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState()
      setPeers(Object.entries(state).filter(([k]) => k !== me.id).map(([, v]) => v[0]))
    })
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await ch.track({ id: me.id, name: me.full_name, role: me.role, at: Date.now() })
    })
    return () => { supabase.removeChannel(ch) }
  }, [room, me?.id, me?.full_name, me?.role])
  return peers
}

/** Debounced refetch helper for realtime-driven lists. */
export function useDebouncedCallback(fn, ms = 400) {
  const t = useRef()
  const f = useRef(fn)
  f.current = fn
  return (...args) => {
    clearTimeout(t.current)
    t.current = setTimeout(() => f.current(...args), ms)
  }
}

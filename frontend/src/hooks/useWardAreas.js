import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Ward centres + city corporation of ALL wards (public ward_areas() RPC, migration 012).
// Loaded once per page load; used to tell which area a place is in and to shade
// the other city corporation on area-bound users' maps.
let cache = null

export function loadWardAreas() {
  if (!cache) {
    cache = supabase.rpc('ward_areas').then(({ data, error }) => {
      if (error) { cache = null; return [] }      // migration 012 not applied / offline: try again later
      return data || []
    })
  }
  return cache
}

export function useWardAreas() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    let live = true
    loadWardAreas().then((r) => live && setRows(r))
    return () => { live = false }
  }, [])
  return rows
}

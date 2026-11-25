import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

let cache = null

export function loadWardAreas() {
  if (!cache) {
    cache = supabase.rpc('ward_areas').then(({ data, error }) => {
      if (error) { cache = null; return [] }
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

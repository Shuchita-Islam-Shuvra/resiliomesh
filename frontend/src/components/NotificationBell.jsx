import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useRealtime } from '../hooks/useRealtime'
import { supabase } from '../lib/supabase'
import { timeAgo } from '../lib/format'

const DOT = { critical: 'bg-red-500', high: 'bg-amber-500', normal: 'bg-sky-500' }
const COLS = 'id,kind,severity,title,body,link,read_at,created_at'

export default function NotificationBell() {
  const { profile } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const [items, setItems] = useState([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const box = useRef(null)

  const load = useCallback(async () => {
    if (!supabase || !profile?.id) return
    const [list, count] = await Promise.all([
      supabase.from('notifications').select(COLS).order('created_at', { ascending: false }).limit(30),
      supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    ])
    if (!list.error) setItems(list.data || [])
    if (!count.error) setUnread(count.count || 0)
  }, [profile?.id])
  useEffect(() => { load() }, [load])

  useRealtime('notifications', (p) => {
    if (p.eventType === 'INSERT' && p.new) {
      const n = p.new
      setItems((xs) => [n, ...xs.filter((x) => x.id !== n.id)].slice(0, 30))
      setUnread((u) => u + 1)
      const show = n.severity === 'critical' ? toast.error : n.severity === 'high' ? toast.warning : toast.info
      show(n.body, n.title)
    } else {
      load()
    }
  }, { filter: profile?.id ? `recipient_id=eq.${profile.id}` : undefined })

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const markRead = async (ids) => {
    const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids })
    if (error) return
    const now = new Date().toISOString()
    setItems((xs) => xs.map((x) => (!ids || ids.includes(x.id) ? { ...x, read_at: x.read_at || now } : x)))
    setUnread((u) => (ids ? Math.max(0, u - ids.length) : 0))
  }

  const openItem = (n) => {
    if (!n.read_at) markRead([n.id])
    setOpen(false)
    if (n.link) nav(n.link)
  }

  if (!profile) return null
  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative rounded-full p-2 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900">
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications"
          className="fixed left-4 right-4 top-14 z-[600] mt-1 overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-[380px]">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            {unread > 0 && (
              <button onClick={() => markRead(null)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
                <CheckCheck className="h-3.5 w-3.5" aria-hidden />Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No notifications yet.</p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button onClick={() => openItem(n)}
                    className={`flex w-full gap-3 px-4 py-3 text-left transition hover:bg-slate-50 ${n.read_at ? '' : 'bg-sky-50/50'}`}>
                    <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? 'bg-slate-300' : DOT[n.severity] || DOT.normal}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${n.read_at ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>{n.title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-slate-600">{n.body}</span>
                      <span className="mt-1 block text-[11px] text-slate-400">{timeAgo(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

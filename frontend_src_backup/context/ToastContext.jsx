import { createContext, useCallback, useContext, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

const ToastCtx = createContext(null)
const ICON = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }
const STYLE = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-rose-200 bg-rose-50 text-rose-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-sky-200 bg-sky-50 text-sky-900',
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback((type, message, title) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t.slice(-4), { id, type, message, title }])
    setTimeout(() => dismiss(id), type === 'error' ? 8000 : 4500)
  }, [dismiss])
  const api = {
    success: (m, t) => push('success', m, t), error: (m, t) => push('error', m, t),
    warning: (m, t) => push('warning', m, t), info: (m, t) => push('info', m, t),
  }
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="fixed bottom-4 right-4 z-[1000] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
        {toasts.map((t) => {
          const Icon = ICON[t.type]
          return (
            <div key={t.id} className={`flex items-start gap-3 rounded-lg border p-3 shadow-lg ${STYLE[t.type]}`}>
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                {t.title && <p className="font-semibold">{t.title}</p>}
                <p className="break-words">{t.message}</p>
              </div>
              <button onClick={() => dismiss(t.id)} className="rounded p-0.5 opacity-60 hover:opacity-100" aria-label="Dismiss notification">
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

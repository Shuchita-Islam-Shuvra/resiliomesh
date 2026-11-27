import { Link } from 'react-router-dom'
import { ArrowLeft, LayoutDashboard, MapPinOff } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function NotFoundPage() {
  const { session } = useAuth()
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto bg-gradient-to-b from-surface to-brand-50/40 px-4 py-16 text-center">
      <span className="rounded-2xl bg-brand-50 p-4 text-brand-700 ring-1 ring-inset ring-brand-100"><MapPinOff className="h-8 w-8" aria-hidden /></span>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">Error 404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-slate-600">The link may be old or mistyped. Nothing was changed.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        {session ? (
          <Link to="/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
            <LayoutDashboard className="h-4 w-4" aria-hidden />Go to dashboard
          </Link>
        ) : (
          <Link to="/login" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
            Sign in
          </Link>
        )}
        <Link to="/" className="inline-flex items-center gap-2 rounded-lg bg-surface px-5 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50">
          <ArrowLeft className="h-4 w-4" aria-hidden />Home
        </Link>
      </div>
    </div>
  )
}

import { CloudRain, Network, ShieldCheck } from 'lucide-react'

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-ink-900 p-10 text-white lg:flex">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-700/30 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-sky-600/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <div><p className="text-xl font-bold">ResilioMesh</p><p className="text-sm text-slate-400">Predict risk · Optimise resources · Coordinate response</p></div>
        </div>
        <div className="relative space-y-6">
          <h2 className="max-w-md text-3xl font-bold leading-tight">Flood resilience intelligence for Dhaka's city teams, NGOs and citizens.</h2>
          <ul className="space-y-4 text-sm text-slate-300">
            <li className="flex gap-3"><CloudRain className="h-5 w-5 shrink-0 text-brand-500" aria-hidden />Live rainfall forecasts + XGBoost risk scoring for every ward and drainage report.</li>
            <li className="flex gap-3"><Network className="h-5 w-5 shrink-0 text-brand-500" aria-hidden />Constraint-optimised allocation of pumps, crews and relief kits with one-click dispatch.</li>
            <li className="flex gap-3"><ShieldCheck className="h-5 w-5 shrink-0 text-brand-500" aria-hidden />Role-isolated access, full audit trail and offline-capable field operations.</li>
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">Hack the Vibe 2026 · World Problem Solver Track · SDG 6, 11, 13, 17</p>
      </div>
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden"><img src="/icon.svg" alt="" className="h-8 w-8" /><span className="text-lg font-bold">ResilioMesh</span></div>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  )
}

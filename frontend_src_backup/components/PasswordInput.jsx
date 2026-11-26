import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from './ui'
import { passwordStrength } from '../lib/validation'

export function PasswordInput({ onKeyUp, ...props }) {
  const [show, setShow] = useState(false)
  const [caps, setCaps] = useState(false)
  const track = (e) => setCaps(Boolean(e.getModifierState?.('CapsLock')))
  return (
    <div>
      <div className="relative">
        <Input {...props} type={show ? 'text' : 'password'} className="pr-10"
          onKeyUp={(e) => { track(e); onKeyUp?.(e) }} onKeyDown={track} onBlur={(e) => { setCaps(false); props.onBlur?.(e) }} />
        <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
          title={show ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-slate-400 hover:text-slate-700">
          {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          <span className="sr-only">{show ? 'Hide' : 'Show'}</span>
        </button>
      </div>
      {caps && <p className="mt-1 text-xs font-medium text-amber-600">Caps Lock is on</p>}
    </div>
  )
}

const BAR = ['bg-rose-500', 'bg-rose-500', 'bg-amber-500', 'bg-lime-500', 'bg-emerald-500']
export function StrengthMeter({ password }) {
  const { score, label } = passwordStrength(password)
  if (!password) return null
  return (
    <div className="mt-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => <span key={i} className={`h-1 flex-1 rounded-full ${i < Math.max(score, 1) ? BAR[score] : 'bg-slate-200'}`} />)}
      </div>
      <p className="mt-1 text-xs text-slate-500">Strength: <span className="font-medium text-slate-700">{label}</span></p>
    </div>
  )
}

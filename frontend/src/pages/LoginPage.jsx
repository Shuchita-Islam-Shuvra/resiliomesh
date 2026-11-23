import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Alert, Button, Field, Input } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import AuthLayout from './AuthLayout'

const DEMO = [
  ['admin@resiliomesh.demo', 'System Admin'],
  ['officer@resiliomesh.demo', 'City Officer'],
  ['ngo@resiliomesh.demo', 'NGO Coordinator'],
  ['field1@resiliomesh.demo', 'Field Worker'],
  ['citizen@resiliomesh.demo', 'Citizen'],
]

export default function LoginPage() {
  const { signIn, session } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)

  if (session) return <Navigate to={loc.state?.from || '/dashboard'} replace />

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Enter a valid email address'
    if (!password) errs.password = 'Enter your password'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setFormError('')
    try {
      await signIn(email.trim(), password)
      nav(loc.state?.from || '/dashboard', { replace: true })
    } catch (err) {
      setFormError(/invalid/i.test(err.message) ? 'Incorrect email or password.' : err.message)
    } finally { setBusy(false) }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Access the ResilioMesh operations console.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="error">{formError}</Alert>}
        <Field label="Email" error={errors.email} required>
          {(a) => <Input {...a} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />}
        </Field>
        <Field label="Password" error={errors.password} required>
          {(a) => <Input {...a} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={busy}>Sign in</Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">New citizen reporter? <Link className="font-medium text-brand-700 hover:underline" to="/register">Create an account</Link></p>
      <details className="mt-6 rounded-lg border border-slate-200 bg-white p-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Demo accounts (judges)</summary>
        <p className="mt-2 text-xs text-slate-500">Password for all demo accounts is shared privately with the judging panel.</p>
        <ul className="mt-2 space-y-1">
          {DEMO.map(([e, r]) => (
            <li key={e}><button type="button" className="text-left text-brand-700 hover:underline" onClick={() => setEmail(e)}>{e}</button> <span className="text-xs text-slate-500">— {r}</span></li>
          ))}
        </ul>
      </details>
    </AuthLayout>
  )
}

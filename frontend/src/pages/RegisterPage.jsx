import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Field, Input, Select } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { validateRegister } from '../lib/validation'
import AuthLayout from './AuthLayout'

export default function RegisterPage() {
  const { signUp } = useAuth()
  const nav = useNavigate()
  const [v, setV] = useState({ full_name: '', email: '', password: '', phone: '', ward_id: '' })
  const [wards, setWards] = useState([])
  const [errors, setErrors] = useState({})
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { supabase.from('wards').select('id,name').order('name').then(({ data }) => setWards(data || [])) }, [])
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    const errs = validateRegister(v)
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setMsg(null)
    try {
      const data = await signUp({ ...v, email: v.email.trim(), phone: v.phone.replace(/[\s-]/g, '') })
      if (data.session) nav('/dashboard')
      else setMsg({ tone: 'success', text: 'Account created. Check your email to confirm, then sign in.' })
    } catch (err) {
      setMsg({ tone: 'error', text: /registered/i.test(err.message) ? 'An account with this email already exists.' : err.message })
    } finally { setBusy(false) }
  }

  return (
    <AuthLayout title="Create citizen account" subtitle="Report waterlogging and blocked drains in your area and track the response.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field label="Full name" error={errors.full_name} required>{(a) => <Input {...a} value={v.full_name} onChange={set('full_name')} autoComplete="name" />}</Field>
        <Field label="Email" error={errors.email} required>{(a) => <Input {...a} type="email" value={v.email} onChange={set('email')} autoComplete="email" />}</Field>
        <Field label="Password" error={errors.password} hint="At least 8 characters with letters and numbers" required>
          {(a) => <Input {...a} type="password" value={v.password} onChange={set('password')} autoComplete="new-password" />}
        </Field>
        <Field label="Mobile (optional)" error={errors.phone}>{(a) => <Input {...a} type="tel" value={v.phone} onChange={set('phone')} placeholder="+8801XXXXXXXXX" />}</Field>
        <Field label="Home area (optional)">
          {(a) => <Select {...a} value={v.ward_id} onChange={set('ward_id')}><option value="">Select area</option>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={busy}>Create account</Button>
        <p className="text-xs text-slate-500">New accounts get the Citizen role. Staff roles are granted by an administrator.</p>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">Already registered? <Link className="font-medium text-brand-700 hover:underline" to="/login">Sign in</Link></p>
    </AuthLayout>
  )
}

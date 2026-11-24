import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Field, Spinner } from '../components/ui'
import { PasswordInput, StrengthMeter } from '../components/PasswordInput'
import { useAuth } from '../context/AuthContext'
import { validatePassword } from '../lib/validation'
import PortalLayout from '../components/PortalLayout'

// Target of the e-mailed reset link: supabase-js turns the link into a short-lived recovery session.
export default function ResetPasswordPage() {
  const { session, profile, loading, updatePassword } = useAuth()
  const nav = useNavigate()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [errors, setErrors] = useState({})
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <Spinner label="Checking reset link…" />
  if (!session) {
    return (
      <PortalLayout eyebrow="Account recovery" heading="Reset your password" title="Reset link expired" subtitle="This password reset link is invalid or has already been used.">
        <Link to="/login" className="inline-flex rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">Back to sign in</Link>
      </PortalLayout>
    )
  }

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    const p = validatePassword(pw, { email: session.user.email, staff: profile && profile.role !== 'citizen' })
    if (p) errs.password = p
    if (pw2 !== pw) errs.confirm = 'Passwords do not match'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setMsg(null)
    try {
      await updatePassword(pw)
      setMsg({ tone: 'success', text: 'Password updated. Taking you to your dashboard…' })
      setTimeout(() => nav('/dashboard', { replace: true }), 1200)
    } catch (err) {
      setMsg({ tone: 'error', text: /different from the old/i.test(err.message) ? 'New password must be different from your old one.' : err.message })
    } finally { setBusy(false) }
  }

  return (
    <PortalLayout role={profile?.role} eyebrow="Account recovery" heading="Reset your password" title="Choose a new password" subtitle={`For ${session.user.email}`}>
      <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        {msg && <Alert tone={msg.tone} className="sm:col-span-2">{msg.text}</Alert>}
        <Field label="New password" error={errors.password} required>
          {(a) => <><PasswordInput {...a} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" maxLength={72} /><StrengthMeter password={pw} /></>}
        </Field>
        <Field label="Confirm new password" error={errors.confirm} required>
          {(a) => <PasswordInput {...a} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" maxLength={72} />}
        </Field>
        <div className="flex justify-end border-t border-slate-100 pt-5 sm:col-span-2"><Button type="submit" size="lg" loading={busy} className="!rounded-full">Update password</Button></div>
      </form>
    </PortalLayout>
  )
}

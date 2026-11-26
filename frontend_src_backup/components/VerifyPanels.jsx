import { useEffect, useState } from 'react'
import { KeyRound, MessageSquareText, ShieldCheck, Smartphone } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { normalizeBdPhone } from '../lib/identity'
import { Alert, Button, Field, Input } from './ui'

const codeProps = { inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 6, pattern: '[0-9]*', placeholder: '123456', className: 'font-mono tracking-[0.3em]' }
const friendly = (err) => {
  const m = err?.message || String(err)
  if (/invalid|expired|incorrect/i.test(m)) return 'That code is wrong or has expired. Try the newest code.'
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a minute and try again.'
  if (/phone provider|sms|unsupported phone|phone.*disabled/i.test(m)) return 'SMS sending is not configured on this server yet. Ask a system administrator.'
  if (/already.*registered|already been registered|phone_exists/i.test(m)) return 'This mobile number is already used by another account.'
  if (/fetch|network/i.test(m)) return 'Cannot reach the server. Check your connection.'
  return m
}

export function TotpChallenge({ onDone }) {
  const { mfa } = useAuth()
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code.trim())) { setErr('Enter the 6-digit code from your authenticator app'); return }
    setBusy(true); setErr('')
    try {
      const [factor] = await mfa.list()
      if (!factor) throw new Error('No authenticator app is set up for this account.')
      await mfa.verify(factor.id, code)
      onDone?.()
    } catch (x) { setErr(friendly(x)) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Authenticator code" error={err} required hint="From Google Authenticator, Microsoft Authenticator, 1Password…">
        {(a) => <Input {...a} {...codeProps} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />}
      </Field>
      <Button type="submit" loading={busy} className="!rounded-full"><KeyRound className="h-4 w-4" aria-hidden />Verify</Button>
    </form>
  )
}

export function TotpEnroll({ onDone, required }) {
  const { mfa } = useAuth()
  const [factor, setFactor] = useState(null)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true); setErr('')
    try { setFactor(await mfa.enroll()) } catch (x) { setErr(friendly(x)) } finally { setBusy(false) }
  }
  const confirm = async (e) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code.trim())) { setErr('Enter the 6-digit code shown in the app'); return }
    setBusy(true); setErr('')
    try { await mfa.verify(factor.id, code); onDone?.() } catch (x) { setErr(friendly(x)) } finally { setBusy(false) }
  }
  if (!factor) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {required ? 'Your role requires a second sign-in factor.' : 'Add a second factor so a stolen password is not enough to use your account.'}
          {' '}You need an authenticator app on your phone.
        </p>
        {err && <Alert tone="error">{err}</Alert>}
        <Button onClick={start} loading={busy} className="!rounded-full"><Smartphone className="h-4 w-4" aria-hidden />Set up authenticator app</Button>
      </div>
    )
  }
  return (
    <form onSubmit={confirm} noValidate className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>Open your authenticator app and scan this QR code.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <img src={factor.totp.qr_code} alt="QR code for your authenticator app" className="h-40 w-40 rounded-lg border border-slate-200 bg-white p-2" />
        <p className="text-xs text-slate-500">Can't scan? Enter this key manually:<br /><code className="mt-1 inline-block break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">{factor.totp.secret}</code></p>
      </div>
      <Field label="Code from the app" error={err} required>
        {(a) => <Input {...a} {...codeProps} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
      </Field>
      <Button type="submit" loading={busy} className="!rounded-full"><ShieldCheck className="h-4 w-4" aria-hidden />Turn on</Button>
    </form>
  )
}

export function PhoneVerify({ initialPhone = '', onDone }) {
  const { startPhoneVerification, confirmPhone } = useAuth()
  const [phone, setPhone] = useState(initialPhone || '')
  const [sentTo, setSentTo] = useState(null)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState(0)
  useEffect(() => {
    if (!wait) return
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000)
    return () => clearTimeout(t)
  }, [wait])

  const send = async (e) => {
    e?.preventDefault()
    if (!normalizeBdPhone(phone)) { setErr('Enter a Bangladeshi mobile number, e.g. 01712345678'); return }
    setBusy(true); setErr('')
    try { setSentTo(await startPhoneVerification(phone)); setWait(60) } catch (x) { setErr(friendly(x)) } finally { setBusy(false) }
  }
  const confirm = async (e) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code.trim())) { setErr('Enter the 6-digit code from the SMS'); return }
    setBusy(true); setErr('')
    try { await confirmPhone(sentTo, code); onDone?.() } catch (x) { setErr(friendly(x)) } finally { setBusy(false) }
  }

  if (!sentTo) {
    return (
      <form onSubmit={send} noValidate className="space-y-4">
        <Field label="Bangladeshi mobile number" error={err} required hint="Only +880 numbers — getting a Bangladeshi SIM requires an NID">
          {(a) => <Input {...a} type="tel" inputMode="tel" autoComplete="tel" maxLength={16} placeholder="01712345678" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} className="!rounded-full"><MessageSquareText className="h-4 w-4" aria-hidden />Send code by SMS</Button>
      </form>
    )
  }
  return (
    <form onSubmit={confirm} noValidate className="space-y-4">
      <p className="text-sm text-slate-600">We sent a 6-digit code to <b>{sentTo}</b>.</p>
      <Field label="SMS code" error={err} required>
        {(a) => <Input {...a} {...codeProps} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} className="!rounded-full"><ShieldCheck className="h-4 w-4" aria-hidden />Verify number</Button>
        <button type="button" disabled={wait > 0 || busy} onClick={send} className="text-sm font-medium text-brand-700 hover:underline disabled:text-slate-400 disabled:no-underline">
          {wait > 0 ? `Resend in ${wait}s` : 'Resend code'}
        </button>
        <button type="button" onClick={() => { setSentTo(null); setCode(''); setErr('') }} className="text-sm text-slate-500 hover:underline">Change number</button>
      </div>
    </form>
  )
}

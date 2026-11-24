import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, BrainCircuit, CheckCircle2, CloudRain, HandHeart, LayoutDashboard, LogIn, ShieldCheck, Smartphone, UserPlus, Workflow } from 'lucide-react'
import RoleCapsule from '../components/RoleCapsule'
import { useAuth } from '../context/AuthContext'
import { ROLE_BY_KEY } from '../lib/roles'

const MODULES = [
  {
    img: '/images/hero-ops.webp', icon: BrainCircuit, title: 'Predict drainage risk',
    text: 'Live rainfall, drainage condition and past floods feed an explainable AI model that scores every ward and report.',
  },
  {
    img: '/images/hero-relief.webp', icon: HandHeart, title: 'Coordinate relief',
    text: 'Pumps, crews and relief kits are allocated by an optimiser under real stock limits, with duplicate aid blocked.',
  },
  {
    img: '/images/hero-field.webp', icon: Smartphone, title: 'Work in the field, even offline',
    text: 'Field teams get tasks on their phone, update them without signal, and everything syncs when they reconnect.',
  },
]

const HIGHLIGHTS = [
  { icon: CloudRain, label: 'Live weather + AI risk' },
  { icon: Workflow, label: 'Automated dispatch' },
  { icon: ShieldCheck, label: 'Role-based access & audit' },
]

const fadeUp = { hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }

// Video-style showcase: slides cross-fade while slowly zooming/panning (Ken Burns).
// Captions sit BELOW the frame, never on top of the picture.
const SLIDES = [
  { img: '/images/hero-city.webp', caption: 'City-wide view: AI links rainfall, flooded wards, pumps and relief teams', pan: ['0%', '-3%'] },
  { img: '/images/hero-ops.webp', caption: 'Live risk map: ward risk, drainage assets and crews on the move', pan: ['-2%', '2%'] },
  { img: '/images/hero-relief.webp', caption: 'Relief coordination: stock, needs and deliveries across NGOs', pan: ['2%', '-2%'] },
  { img: '/images/hero-field.webp', caption: 'Field work: tasks on a tablet, saved offline, synced on reconnect', pan: ['0%', '3%'] },
]
const SLIDE_MS = 3000
const FADE_S = 0.7

// Slides advance continuously, one after another (no hover pause, no indicators).
function Showcase({ reduce }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (reduce) return
    const t = setTimeout(() => setI((n) => (n + 1) % SLIDES.length), SLIDE_MS)
    return () => clearTimeout(t)
  }, [i, reduce])
  const s = SLIDES[i]

  return (
    <motion.div className="relative" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, ease: 'easeOut' }}>
      <div aria-hidden className="absolute -inset-4 rounded-[2rem] bg-gradient-to-tr from-brand-200/60 via-sky-200/40 to-transparent blur-2xl" />
      <div className="relative aspect-[16/9] overflow-hidden rounded-3xl bg-ink-900 shadow-2xl shadow-slate-900/25 ring-1 ring-slate-900/5">
        <AnimatePresence initial={false}>
          <motion.img key={s.img} src={s.img} alt={s.caption}
            className="absolute inset-0 h-full w-full object-cover"
            initial={{ opacity: 0, scale: 1.04, x: s.pan[0] }}
            animate={reduce ? { opacity: 1, scale: 1.04 } : { opacity: 1, scale: 1.16, x: s.pan[1] }}
            exit={{ opacity: 0 }}
            transition={{ opacity: { duration: FADE_S, ease: 'easeInOut' }, default: { duration: SLIDE_MS / 1000 + FADE_S, ease: 'linear' } }} />
        </AnimatePresence>
      </div>
      <AnimatePresence mode="wait">
        <motion.p key={s.caption} className="relative mt-4 text-center text-sm text-slate-600"
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3 }}>
          {s.caption}
        </motion.p>
      </AnimatePresence>
    </motion.div>
  )
}

// Capsule role picker in the middle of the home page: pick a user type, then sign in / sign up as it.
function RolePicker() {
  const [role, setRole] = useState('citizen')
  const r = ROLE_BY_KEY[role]
  const Icon = r.icon
  return (
    <section aria-labelledby="role-heading" className="relative overflow-hidden border-t border-slate-200/70 bg-gradient-to-b from-white to-brand-50/40">
      <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-14 sm:px-6 lg:py-20">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">Choose your portal</p>
        <h2 id="role-heading" className="mt-2 scroll-mt-28 text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Who are you signing in as?</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-slate-600">Every user type gets its own sign-in, sign-up form and workspace.</p>
        <RoleCapsule value={role} onChange={setRole} className="mt-8 bg-white shadow-lg shadow-slate-200/70" />
        <AnimatePresence mode="wait">
          <motion.div key={role} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }}
            className="mt-6 w-full max-w-2xl rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
            <div className="flex items-start gap-4">
              <span className="rounded-2xl bg-brand-50 p-3 text-brand-700 ring-1 ring-inset ring-brand-100"><Icon className="h-6 w-6" aria-hidden /></span>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900">{r.label}</h3>
                <p className="mt-1 text-sm text-slate-600">{r.tagline}</p>
              </div>
            </div>
            <ul className="mt-5 grid gap-2 sm:grid-cols-3">
              {r.points.map((p) => <li key={p} className="flex gap-2 text-sm text-slate-600"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />{p}</li>)}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to={`/login?role=${role}`} className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
                <LogIn className="h-4 w-4" aria-hidden />Sign in as {r.label}
              </Link>
              {r.selfRegister ? (
                <Link to={`/register?role=${role}`} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50">
                  <UserPlus className="h-4 w-4" aria-hidden />{r.selfRegister === 'request' ? 'Request access' : 'Create account'}
                </Link>
              ) : (
                <span className="self-center text-xs text-slate-500">Admin accounts are created by an existing administrator.</span>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}

export default function HomePage() {
  const { session } = useAuth()
  const reduce = useReducedMotion()

  return (
    <div className="h-full overflow-y-auto">
      {/* ------------------------------------------------ top bar */}
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
          <span className="text-lg font-bold tracking-tight text-slate-900">ResilioMesh</span>
          <nav className="ml-auto flex items-center gap-2" aria-label="Account">
            {session ? (
              <Link to="/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
                <LayoutDashboard className="h-4 w-4" aria-hidden />Go to dashboard
              </Link>
            ) : (
              <>
                <a href="#role-heading" className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">Sign in</a>
                <Link to="/register" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">Sign up</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        {/* ------------------------------------------------ hero: text left, picture right (no text on the picture) */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:py-20">
          <motion.div initial="hidden" animate="show" transition={{ staggerChildren: 0.1 }}>
            <motion.p variants={fadeUp} className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />Dhaka flood resilience platform
            </motion.p>
            <motion.h1 variants={fadeUp} className="mt-4 text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
              Predict risk. <span className="text-brand-600">Optimise resources.</span> Coordinate response.
            </motion.h1>
            <motion.p variants={fadeUp} className="mt-4 max-w-xl text-base text-slate-600">
              One place for city drainage teams, NGOs, field workers and citizens to report waterlogging, see where the risk is,
              and send the right help to the right ward first.
            </motion.p>
            <motion.div variants={fadeUp} className="mt-7 flex flex-wrap gap-3">
              <Link to={session ? '/dashboard' : '/register'} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-900/15 transition hover:bg-brand-700">
                {session ? 'Open dashboard' : 'Create an account'}<ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              {!session && (
                <a href="#role-heading" className="inline-flex items-center rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50">
                  Sign in
                </a>
              )}
            </motion.div>
            <motion.ul variants={fadeUp} className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-slate-600">
              {HIGHLIGHTS.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-2"><Icon className="h-4 w-4 text-brand-600" aria-hidden />{label}</li>
              ))}
            </motion.ul>
          </motion.div>

          <Showcase reduce={reduce} />
        </section>

        {/* ------------------------------------------------ role capsule: pick a user type */}
        {!session && <RolePicker />}

        {/* ------------------------------------------------ three modules: picture on top, text below */}
        <section className="border-t border-slate-200/70 bg-white/60">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
            <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Three connected modules</h2>
            <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-slate-600">From a citizen's report to a pump on the street, every step is tracked in one system.</p>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {MODULES.map(({ img, icon: Icon, title, text }, i) => (
                <motion.article key={title} className="group overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 transition-shadow hover:shadow-lg"
                  initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }}
                  transition={{ duration: 0.5, delay: i * 0.12 }}>
                  <div className="aspect-[16/9] overflow-hidden">
                    <img src={img} alt="" loading="lazy" decoding="async"
                      className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105" />
                  </div>
                  <div className="p-5">
                    <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Icon className="h-5 w-5 text-brand-600" aria-hidden />{title}</h3>
                    <p className="mt-2 text-sm text-slate-600">{text}</p>
                  </div>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ closing call to action */}
        {!session && (
          <section className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-6">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Ready to report or respond?</h2>
            <p className="mt-2 text-sm text-slate-600">Citizens can sign up in a minute. Staff accounts are created by an administrator.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link to="/register" className="rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">Sign up</Link>
              <Link to="/login" className="rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50">Sign in</Link>
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-slate-200/70 py-6 text-center text-xs text-slate-500">
        ResilioMesh · Hack the Vibe 2026 · World Problem Solver Track
      </footer>
    </div>
  )
}

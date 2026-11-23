import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, BrainCircuit, CloudRain, HandHeart, LayoutDashboard, ShieldCheck, Smartphone, Workflow } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

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
const SLIDE_MS = 5500

function Showcase({ reduce }) {
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (reduce || paused) return
    const t = setTimeout(() => setI((n) => (n + 1) % SLIDES.length), SLIDE_MS)
    return () => clearTimeout(t)
  }, [i, reduce, paused])
  const s = SLIDES[i]

  return (
    <motion.div className="relative" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, ease: 'easeOut' }}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div aria-hidden className="absolute -inset-4 rounded-[2rem] bg-gradient-to-tr from-brand-200/60 via-sky-200/40 to-transparent blur-2xl" />
      <div className="relative aspect-[16/9] overflow-hidden rounded-3xl bg-ink-900 shadow-2xl shadow-slate-900/25 ring-1 ring-slate-900/5">
        <AnimatePresence initial={false}>
          <motion.img key={s.img} src={s.img} alt={s.caption}
            className="absolute inset-0 h-full w-full object-cover"
            initial={{ opacity: 0, scale: 1.04, x: s.pan[0] }}
            animate={reduce ? { opacity: 1, scale: 1.04 } : { opacity: 1, scale: 1.16, x: s.pan[1] }}
            exit={{ opacity: 0 }}
            transition={{ opacity: { duration: 1.1, ease: 'easeInOut' }, default: { duration: (SLIDE_MS + 1500) / 1000, ease: 'linear' } }} />
        </AnimatePresence>
        {/* story-style progress bars (no text on the picture) */}
        <div className="absolute inset-x-4 bottom-3 flex gap-1.5">
          {SLIDES.map((sl, n) => (
            <button key={sl.img} type="button" onClick={() => setI(n)} aria-label={`Show slide ${n + 1}`}
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/30 backdrop-blur">
              {n < i && <span className="block h-full w-full bg-white" />}
              {n === i && (
                <motion.span key={`${i}-${paused}`} className="block h-full bg-white"
                  initial={{ width: paused ? '100%' : '0%' }} animate={{ width: '100%' }}
                  transition={{ duration: paused || reduce ? 0 : SLIDE_MS / 1000, ease: 'linear' }} />
              )}
            </button>
          ))}
        </div>
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
                <Link to="/login" className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">Sign in</Link>
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
                <Link to="/login" className="inline-flex items-center rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50">
                  Sign in
                </Link>
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

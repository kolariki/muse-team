import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { countTo, gsap, heroIntro, sceneIn, scrollReveal, useGSAP } from '../lib/anim'
import { useLang, useT } from '../lib/i18n'
import LangSwitch from './LangSwitch'
import ThemeSwitch from './ThemeSwitch'
import { HACKATHON_MODE } from '../lib/flags'
import AgentAvatar from './AgentAvatar'
import TeamBackdrop from './TeamBackdrop'
import ProviderLogo, { LogoWatermark } from './ProviderLogo'
import { brandTheme } from '../lib/brand'

/* ------------------------------------------------------------------ the looping demo
 * One clock (ms since loop start) drives every scene. Everything is derived from `t`,
 * so the animation is deterministic and loops cleanly.
 */
/* ------------------------------------------------------------------ demo data: a weather app, from the idea to the built product */
const PROVIDERS_ALL: [string, string][] = [['meta', 'Meta · Muse']]
const IDEA = 'Una app del clima para Argentina que me diga si llevo paraguas, con alertas oficiales y pronóstico por horas.'
const IDEA_EN = 'A weather app for Argentina that tells me whether to take an umbrella, with official alerts and an hourly forecast.'
const QUESTIONS: [string, string][] = [
  ['¿Solo web (PWA) o también apps nativas?', 'Web only (PWA) or native apps too?'],
  ['¿Qué fuente de alertas oficiales usamos?', 'Which official alert source do we use?'],
]
const BRIEF_LINES: [string, string][] = [
  ['# App de Clima · ¿llevo paraguas?', '# Weather app · umbrella or not?'],
  ['## Objetivo: responder en 3 s si llueve hoy', '## Goal: answer in 3 s whether it rains today'],
  ['## MVP: ciudad, hoy por horas, 7 días, alertas', '## MVP: city, hourly today, 7 days, alerts'],
  ['## Fuera: radar, cuentas, widgets', '## Out: radar, accounts, widgets'],
  ['## Criterios de aceptación: 12 historias', '## Acceptance criteria: 12 stories'],
]
type Member = { id: string; name: string; name_en: string; role: string; role_en: string; provider: string; model: string; color: string; persona: string; persona_en: string; skills: string[] }
const TEAM: Member[] = [
  { id: 'ceo', name: 'CEO', name_en: 'CEO', role: 'Dirección', role_en: 'Leadership', provider: 'meta', model: 'muse-wonder-1.0', color: '#C0603F', persona: 'visionario pero concreto', persona_en: 'visionary but concrete' , skills: ['pitch', 'alcance MVP'] },
  { id: 'cto', name: 'CTO', name_en: 'CTO', role: 'Dirección', role_en: 'Leadership', provider: 'meta', model: 'muse-spark-1.3', color: '#17896A', persona: 'escéptico del hype', persona_en: 'hype sceptic' , skills: ['stack review', 'costos'] },
  { id: 'eng', name: 'Head of Eng', name_en: 'Head of Eng', role: 'Ingeniería', role_en: 'Engineering', provider: 'meta', model: 'muse-wonder-1.0', color: '#3D5CC4', persona: 'veinte años de cicatrices', persona_en: 'twenty years of scars' , skills: ['arquitectura', 'CI/CD'] },
  { id: 'product', name: 'Product', name_en: 'Product', role: 'Producto', role_en: 'Product', provider: 'meta', model: 'muse-spark-1.3', color: '#AD7D1A', persona: 'historias claras, prioriza', persona_en: 'clear stories, prioritises' , skills: ['user stories', 'priorización'] },
  { id: 'design', name: 'Diseño', name_en: 'Design', role: 'Diseño', role_en: 'Design', provider: 'meta', model: 'muse-spark-1.3', color: '#9A57B8', persona: 'flujos simples, pantallas precisas', persona_en: 'simple flows, precise screens' , skills: ['frontend-design', 'UX audit'] },
  { id: 'qa', name: 'QA', name_en: 'QA', role: 'Calidad', role_en: 'Quality', provider: 'meta', model: 'muse-spark-1.3', color: '#6E8226', persona: 'busca cómo se rompe todo', persona_en: 'finds how everything breaks' , skills: ['test plan', 'e2e'] },
]
const ARENA = TEAM.slice(0, 4)
const MEMBER = Object.fromEntries(TEAM.map((m) => [m.id, m])) as Record<string, Member>
const REFS = ['apple.com/weather', 'windy.com', 'accuweather.com']
const TURNS = [
  { from: 'ceo', to: 'cto', text: 'Una sola pregunta: ¿llevo paraguas? CTO, ¿qué fuente nos sirve sin cuentas?', text_en: 'One question: umbrella or not? CTO, which source works without accounts?', stance: '💡 propone', stance_en: '💡 proposes', reason: 'que elija el stack', reason_en: 'let him pick the stack' },
  { from: 'cto', to: 'eng', text: 'Open-Meteo, gratis y sin key. PWA, nada nativo en el MVP.', text_en: 'Open-Meteo, free and keyless. PWA, nothing native in the MVP.', stance: '🤝 acuerdo', stance_en: '🤝 agrees', reason: 'que baje la arquitectura', reason_en: 'let him lay out the architecture' },
  { from: 'eng', to: 'product', text: 'Vite + TypeScript, caché offline de 2 h. Product, ¿qué entra en v1?', text_en: 'Vite + TypeScript, 2 h offline cache. Product, what makes v1?', stance: '💡 propone', stance_en: '💡 proposes', reason: 'que cierre el alcance', reason_en: 'let her close the scope' },
  { from: 'product', to: 'ceo', text: 'Ciudad, hoy por horas, 7 días y alertas. Radar y widgets, etapa 2.', text_en: 'City, hourly today, 7 days and alerts. Radar and widgets, phase 2.', stance: '⚔️ discrepa', stance_en: '⚔️ disagrees', reason: 'que confirme el nombre', reason_en: 'let him confirm the name' },
]
const BUILD_STEPS: { key: string; label: string; label_en: string; detail: string; detail_en: string }[] = [
  { key: 'research', label: 'Benchmark de referentes', label_en: 'Reference benchmark', detail: '3 apps visitadas · capturas segmentadas con SAM 3.1 · qué emular', detail_en: '3 apps visited · screenshots segmented with SAM 3.1 · what to emulate' },
  { key: 'deep', label: 'Ingeniería inversa (REA)', label_en: 'Reverse engineering (REA)', detail: 'bundles, rutas y API de los referentes', detail_en: 'the references’ bundles, routes and API' },
  { key: 'design', label: 'Diseño UX/UI', label_en: 'UX/UI design', detail: 'sistema · 3 pantallas · mockup con Muse Image, aprobado por vos', detail_en: 'system · 3 screens · Muse Image mockup, approved by you' },
  { key: 'build', label: 'Construcción · Muse Code', label_en: 'Build · Muse Code', detail: 'app/page.tsx · lib/weather.ts · Umbrella.tsx…', detail_en: 'app/page.tsx · lib/weather.ts · Umbrella.tsx…' },
  { key: 'polish', label: 'Pulido visual', label_en: 'Visual polish', detail: 'la UI iguala el mockup', detail_en: 'the UI matches the mockup' },
  { key: 'review', label: 'Revisión del consejo', label_en: 'Council review', detail: 'v1 · 100 % listo para producción', detail_en: 'v1 · 100 % production-ready' },
]
const SCENES = [
  { key: 'idea', label: 'Contás tu idea', label_en: 'You tell your idea', desc: 'Escribís qué querés construir con tus palabras y adjuntás documentos, una carpeta o un proyecto existente.', desc_en: 'You write what you want to build in your own words and attach documents, a folder or an existing project.', dur: 7200 },
  { key: 'prompt', label: 'Prompt engineering', label_en: 'Prompt engineering', desc: 'Una IA lee lo que adjuntaste, te hace las preguntas que faltan y convierte tu texto en un brief completo para el equipo.', desc_en: 'An AI reads what you attached, asks the missing questions and turns your text into a complete brief for the team.', dur: 8800 },
  { key: 'team', label: 'Elegís el equipo y las IAs', label_en: 'You pick the team and the AIs', desc: 'Un rol por tarjeta: CEO, CTO, ingeniería, producto, diseño y QA, cada uno con la IA, el prompt y las skills que quieras.', desc_en: 'One role per card: CEO, CTO, engineering, product, design and QA, each with the AI, prompt and skills you want.', dur: 7000 },
  { key: 'refs', label: 'Referentes e ingeniería inversa', label_en: 'References and reverse engineering', desc: 'Cargás apps parecidas para que el equipo las estudie y, si querés, activás la ingeniería inversa para entender cómo están hechas.', desc_en: 'You add similar apps for the team to study and, if you want, turn on reverse engineering to understand how they are built.', dur: 7600 },
  { key: 'arena', label: 'El equipo debate', label_en: 'The team debates', desc: 'Los roles discuten en vivo producto, stack y alcance, se pasan la palabra y cierran decisiones con un responsable por cada paso.', desc_en: 'The roles debate product, stack and scope live, hand the floor to each other and close decisions with an owner for every step.', dur: TURNS.length * 2600 + 600 },
  { key: 'build', label: 'Diseñan, construyen y revisan', label_en: 'They design, build and review', desc: 'Benchmark de referentes, diseño que aprobás, código con Claude Code, pulido visual y revisión del consejo hasta que la app está lista.', desc_en: 'Reference benchmark, a design you approve, code with Claude Code, visual polish and council review until the app is ready.', dur: 12600 },
  { key: 'deploy', label: 'La publicás con un clic', label_en: 'You publish it in one click', desc: 'Terminada la construcción, la publicás desde Tably Cloud: base de datos, HTTPS y dominio incluidos, con una URL pública que abre desde cualquier lugar.', desc_en: 'Once the build is done, you publish it from Tably Cloud: database, HTTPS and domain included, with a public URL that opens from anywhere.', dur: 10500 },
  { key: 'analytics', label: 'Medís quién la usa', label_en: 'You measure who uses it', desc: 'Cada app publicada trae Tably Analytics: visitas, páginas, eventos y errores reales, sin cookies ni datos personales.', desc_en: 'Every published app comes with Tably Analytics: real visits, pages, events and errors, with no cookies or personal data.', dur: 9000 },
  { key: 'ads', label: 'Creás los anuncios', label_en: 'You create the ads', desc: 'Muse mira tu app, resume qué hace y propone 5 plantillas; cinco agentes arman el video con los colores de la app y queda listo para Meta Ads.', desc_en: 'Muse looks at your app, sums up what it does and suggests 5 templates; five agents make the video in the app’s colours, ready for Meta Ads.', dur: 10000 },
  { key: 'metaads', label: 'Conectás tu Meta Ads', label_en: 'You connect your Meta Ads', desc: 'La IA lee tu cuenta y te muestra los números que importan, qué funciona y qué cambiar. Con un botón pausás, eliminás o movés presupuesto.', desc_en: 'The AI reads your account and shows you the numbers that matter, what works and what to change. One button pauses, deletes or moves budget.', dur: 11000 },
  { key: 'market', label: 'La vendés en el marketplace', label_en: 'You sell it on the marketplace', desc: 'Publicás la app con su nivel, sus visitas reales y un precio; el comprador te escribe y se la transferís desde el constructor.', desc_en: 'You list the app with its level, real visits and a price; the buyer writes to you and you transfer it from the builder.', dur: 9500 },
  { key: 'audit', label: 'Auditan un proyecto que ya tenés', label_en: 'They audit a project you already have', desc: 'Subís un proyecto existente, elegís qué roles lo revisan y el equipo lo audita desde cada área: hallazgos con archivo y línea, qué está listo y qué falta para producción.', desc_en: 'You upload an existing project, pick which roles review it and the team audits it from every area: findings with file and line, what is ready and what is missing for production.', dur: 11000 },
] as const
const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0)

const SCENE_START = SCENES.map((_, i) => SCENES.slice(0, i).reduce((a, s) => a + s.dur, 0))

/** The demo clock loops through the scenes; ‹ › jump to the previous / next scene (the loop keeps playing from there). */
function useClock() {
  const [t, setT] = useState(0)
  const [paused, setPaused] = useState(false)
  const start = useRef(performance.now())
  const frozen = useRef(0)  // where the clock stopped, so resuming continues from the same frame
  useEffect(() => {
    if (paused) return
    start.current = performance.now() - frozen.current
    const id = window.setInterval(() => {
      const now = (performance.now() - start.current) % TOTAL
      frozen.current = now
      setT(now)
    }, 40)
    return () => window.clearInterval(id)
  }, [paused])
  let scene = 0
  for (let i = 0; i < SCENES.length; i++) if (t >= SCENE_START[i]) scene = i
  const jump = (i: number) => {
    const target = ((i % SCENES.length) + SCENES.length) % SCENES.length
    frozen.current = SCENE_START[target]
    start.current = performance.now() - SCENE_START[target]
    setT(SCENE_START[target])
  }
  return { scene, local: t - SCENE_START[scene], key: SCENES[scene].key, jump, paused, toggle: () => setPaused((p) => !p) }
}

const ease = (x: number) => Math.min(1, Math.max(0, x))

export default function Landing({ onLogin, onSignup }: { onLogin: () => void; onSignup: () => void }) {
  const T = useT()
  const lang = useLang()
  const prefix = lang === 'en' ? '/en' : ''  // the public pages (blog, FAQ) have an English edition under /en
  const page = useRef<HTMLDivElement>(null)
  // the title is split into letters for the intro; when the language changes it remounts (key) and the intro runs again on the new text
  useGSAP(() => {
    if (!page.current) return
    heroIntro(page.current)
    return scrollReveal(page.current)
  }, { scope: page, dependencies: [lang] })
  return (
    <div ref={page} className="relative h-full overflow-y-auto overflow-x-hidden scroll-thin arena-bg">
      {/* the team building, blurred, behind everything */}
      <div className="hidden md:block"><TeamBackdrop fixed blur={8} opacity={0.45} /></div>
      {/* everything else sits above the backdrop (positioned, so the fixed scene never paints over cards or buttons) */}
      <div className="relative z-10">
      {/* header */}
      <header className="sticky top-0 z-20 flex items-center gap-2 px-3 h-14 border-b border-line bg-paper/80 backdrop-blur sm:gap-3 sm:px-6">
        <img data-brand-icon src="/icon.svg?v=2" alt="" aria-hidden className="h-7 w-7 shrink-0 rounded-lg shadow-sm" draggable={false} />
        <span className="serif hidden whitespace-nowrap text-lg min-[480px]:inline"><span data-brand-text>Tably</span> <em data-brand-text className="text-accent">Team</em></span>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <ThemeSwitch className="h-8" auto={false} />
          <LangSwitch className="sm:mr-1" />
          {!HACKATHON_MODE && <a href={`${prefix}/blog`} className="hidden rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:text-ink sm:inline">{T('Blog', 'Blog')}</a>}
          {!HACKATHON_MODE && <a href={`${prefix}/faq`} className="hidden rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:text-ink sm:inline">{T('Preguntas frecuentes', 'FAQ')}</a>}
          <button onClick={onLogin} className="whitespace-nowrap rounded-lg px-1.5 py-1.5 text-sm text-ink-2 hover:text-ink sm:px-3"><span className="sm:hidden">{T('Entrar', 'Sign in')}</span><span className="hidden sm:inline">{T('Iniciar sesión', 'Sign in')}</span></button>
          <button onClick={onSignup} className="whitespace-nowrap rounded-lg bg-accent text-white px-3 py-1.5 text-sm font-medium hover:brightness-110 sm:px-3.5">{T('Crear cuenta', 'Create account')}</button>
        </div>
      </header>

      {/* hero */}
      <section className="relative max-w-[1400px] mx-auto px-6 pt-16 pb-10 grid lg:grid-cols-[minmax(min(100%,520px),1fr)_1.3fr] gap-10 items-center">
        {/* the logos that fly in and fuse into "Tably" (positioned by lib/anim.ts) */}
        <div data-fuse-layer className="pointer-events-none absolute inset-0 z-20" aria-hidden>
          {PROVIDERS_ALL.map(([id]) => (
            <span key={id} data-fuse-logo className="absolute left-0 top-0 flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface opacity-0 shadow-[0_14px_30px_-10px_rgba(30,38,34,.5)]"><ProviderLogo provider={id} size={28} /></span>
          ))}
          <span data-fuse-orb className="absolute left-0 top-0 h-20 w-20 rounded-full opacity-0" style={{ background: 'radial-gradient(circle, #FFFFFF 0%, #7FD1B9 30%, #2F6B5D 55%, rgba(47,107,93,0) 72%)', boxShadow: '0 0 80px 26px rgba(47,107,93,.45)' }} />
          <span data-fuse-spark className="absolute left-0 top-0 h-3.5 w-3.5 rounded-full bg-accent opacity-0" style={{ boxShadow: '0 0 20px 8px rgba(47,107,93,.65)' }} />
        </div>
        <div>
          <div data-hero-kicker className="text-xs uppercase tracking-[0.5em] text-accent">{T('tu equipo que diseña y construye', 'your team that designs and builds')}</div>
          <h1 key={lang} data-hero-title className="mt-3 text-[44px] leading-[0.98] min-[420px]:text-5xl sm:text-6xl md:text-7xl md:leading-[0.95] tracking-tight opacity-0">
            {T('Escribí tu idea.', 'Write your idea.')} <em data-hero-word className="text-accent">Tably</em> {T('la construye.', 'builds it.')}
          </h1>
          <p data-hero-copy className="mt-5 text-lg text-ink-2 leading-relaxed max-w-lg">
            {T('Describís la app que querés y Muse, el modelo de Meta, ocupa cada rol: CEO, CTO, ingeniería, producto, diseño y QA. El equipo debate tu idea, estudia apps de referencia, diseña las pantallas, escribe el código con Muse Code y lo revisa antes de entregarte un producto listo para correr. Vos aprobás cada paso.', 'Describe the app you want and Muse, Meta\'s model, takes every role: CEO, CTO, engineering, product, design and QA. The team debates your idea, studies reference apps, designs the screens, writes the code with Muse Code and reviews it before handing you a product ready to run. You approve every step.')}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button data-hero-cta onClick={onSignup} className="flex items-center gap-2 rounded-2xl bg-accent text-white px-6 py-3.5 font-semibold text-lg hover:brightness-110 transition">
              {T('Empezar gratis', 'Start for free')} <ArrowRight size={18} />
            </button>
            <a data-hero-cta href="#demo" className="flex items-center gap-2 rounded-2xl border border-line bg-surface px-6 py-3.5 font-medium text-lg text-ink-2 hover:text-ink transition">
              <Play size={16} /> {T('Ver cómo funciona', 'See how it works')}
            </a>
          </div>
          <div data-hero-row className="mt-8"><MuseBadge big /></div>
        </div>

        <div id="demo" data-hero-demo>
          <DemoBlock />
        </div>
      </section>

      {/* features */}
      {!HACKATHON_MODE && <section className="max-w-[1400px] mx-auto px-6 pb-20 grid md:grid-cols-3 gap-5">
        {[
          { title: T('Un equipo completo, con Muse', 'A full team, on Muse'), text: T('CEO, CTO, Head of Engineering, Product, Diseño y QA, cada uno con Muse Spark o Muse Wonder, su rol, su prompt y sus skills. Debaten tu idea, se contradicen, votan y cierran decisiones con un responsable por cada paso.', 'CEO, CTO, Head of Engineering, Product, Design and QA, each on Muse Spark or Muse Wonder, with their role, prompt and skills. They debate your idea, disagree, vote and close decisions with an owner for every step.') },
          { title: T('Diseñan y construyen', 'They design and build'), text: T('El equipo estudia apps de referencia (SAM 3.1 segmenta cada pantalla en componentes), el diseñador entrega sistema, pantallas y un mockup hecho con Muse Image, y recién cuando lo aprobás Muse Code escribe el código, al nivel de un producto profesional.', 'The team studies reference apps (SAM 3.1 segments every screen into components), the designer delivers system, screens and a Muse Image mockup, and only once you approve does Muse Code write the code, at the level of a professional product.') },
          { title: T('Vos decidís, ellos iteran', 'You decide, they iterate'), text: T('Pedís cambios en el diseño o en el código, el consejo revisa cada versión antes de producción y vuelve a debatir si hace falta. Publicás con un clic y el equipo te lleva nivel por nivel: analítica, buscadores, cobros, y la app lista para venderse.', 'Ask for changes in the design or the code, the council reviews every version before production and debates again if needed. Publish in one click and the team takes you level by level: analytics, search engines, payments, and an app ready to sell.') },
        ].map((f) => (
          <div key={f.title} data-scroll-reveal className="panel rounded-2xl p-6">
            <h3 className="text-2xl">{f.title}</h3>
            <p className="mt-2 text-[14.5px] text-ink-2 leading-relaxed">{f.text}</p>
          </div>
        ))}
      </section>}

      {!HACKATHON_MODE && <Resources />}
      </div>
      <nav aria-label={T('Legales', 'Legal')} className="flex justify-center gap-5 px-6 pb-6 pt-2 text-[12.5px] text-ink-3">
        <a href="/privacidad" className="hover:text-ink hover:underline">{T('Privacidad', 'Privacy')}</a>
        <a href="/terminos" className="hover:text-ink hover:underline">{T('Términos', 'Terms')}</a>
      </nav>
      <MadeWith />
    </div>
  )
}

/** The "powered by Muse" seal: Meta's model behind every role. Click opens a two-line note right under it. */
export function MuseBadge({ className = '', big = false }: { className?: string; big?: boolean }) {
  const [open, setOpen] = useState(false)
  const T = useT()
  const pill = big
    ? 'inline-flex items-center gap-2.5 rounded-full border border-[#BBD5FA] bg-[#EEF5FF] py-2 pl-2 pr-4 text-[14px] font-medium text-[#0B2E66] shadow-sm transition hover:border-[#0082FB] hover:shadow-md'
    : 'items-center gap-1.5 rounded-full border border-[#BBD5FA] bg-[#EEF5FF] py-1 pl-1.5 pr-2.5 text-[11px] font-semibold text-[#0B2E66] transition hover:border-[#0082FB]'
  return (
    <span className={`relative ${big ? 'block' : 'inline-flex'} ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`muse-ring ${pill} ${open ? 'border-[#0082FB]' : ''}`}>
        <img src="/logos/meta.png" alt="" aria-hidden className={big ? 'h-7 w-7' : 'h-4 w-4'} draggable={false} />
        powered by <span className="font-bold">Muse</span>{big && <span className="text-[#0B2E66]/60">· Meta</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (big ? (
          /* big seal (hero, login): the note opens in the flow and pushes what follows down */
          <motion.div key="note" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }} className="overflow-hidden">
            <div className="mt-2 max-w-[460px] rounded-xl border border-[#BBD5FA] bg-surface px-3.5 py-2.5 text-left shadow-sm">
              <div className="text-[13px] font-semibold text-[#0B2E66]">{T('Muse son los modelos de IA de Meta.', "Muse is Meta's family of AI models.")}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink-2">Muse Wonder · Muse Spark · Muse Code · Muse Image · SAM 3.1 · Muse Voice Transcribe</div>
            </div>
          </motion.div>
        ) : (
          /* small seal (app header): a popover, so the bar keeps its height */
          <motion.div key="pop" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className="absolute left-0 top-full z-[300] mt-2 w-max max-w-[min(92vw,460px)] rounded-xl border border-[#BBD5FA] bg-surface px-3.5 py-2.5 text-left shadow-lg">
            <div className="text-[13px] font-semibold text-[#0B2E66]">{T('Muse son los modelos de IA de Meta.', "Muse is Meta's family of AI models.")}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-ink-2">Muse Wonder · Muse Spark · Muse Code · Muse Image · SAM 3.1 · Muse Voice Transcribe</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </span>
  )
}

/* ------------------------------------------------------------------ resources: the latest guides and the FAQ (server-rendered pages exist for crawlers; here they are a teaser) */

type PostMeta = { slug: string; title: string; description: string; date: string; reading_min: number; provider: string | null; tags: string[] }
type FaqItem = { question: string; html: string; slug: string }

function Resources() {
  const T = useT()
  const lang = useLang()
  const prefix = lang === 'en' ? '/en' : ''
  const [posts, setPosts] = useState<PostMeta[]>([])
  const [faq, setFaq] = useState<FaqItem[]>([])
  useEffect(() => {
    fetch(`/api/content/blog?lang=${lang}`).then((r) => (r.ok ? r.json() : [])).then(setPosts).catch(() => {})
    fetch(`/api/content/faq?lang=${lang}`).then((r) => (r.ok ? r.json() : [])).then(setFaq).catch(() => {})
  }, [lang])
  if (!posts.length && !faq.length) return null
  return (
    <section className="max-w-[1400px] mx-auto px-6 pt-24 pb-24">
      {posts.length > 0 && (
        <div data-scroll-reveal>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="serif text-[34px] leading-tight">{T('Qué IA elegir, cuánto cuesta y cómo funciona por dentro', 'Which AI to pick, what it costs and how it works inside')}</h2>
            </div>
            <a href={`${prefix}/blog`} className="rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink-2 transition hover:border-accent hover:text-accent">{T('Ver todos los artículos', 'See all articles')} →</a>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {posts.slice(0, 6).map((p) => (
              <a key={p.slug} href={`${prefix}/blog/${p.slug}`} className="panel group flex flex-col gap-2 rounded-2xl p-5 transition hover:border-accent">
                <div className="flex items-center gap-2 text-[12px] text-ink-3">
                  {p.provider && <ProviderLogo provider={p.provider} size={18} />}
                  <span>{p.reading_min} {T('min de lectura', 'min read')}</span>
                </div>
                <h3 className="serif text-[22px] leading-tight group-hover:text-accent">{p.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-ink-2">{p.description}</p>
              </a>
            ))}
          </div>
        </div>
      )}
      {faq.length > 0 && (
        <div data-scroll-reveal className="mt-16 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          <div className="lg:order-2 lg:pl-6">
            <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Preguntas frecuentes', 'FAQ')}</div>
            <h2 className="serif mt-1 text-[34px] leading-tight">{T('Lo que te preguntás antes de empezar', 'What you ask before you start')}</h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">{T('Precio, modelos, privacidad, publicación. Respuestas directas.', 'Pricing, models, privacy, publishing. Straight answers.')}</p>
            <a href={`${prefix}/faq`} className="mt-4 inline-block rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink-2 transition hover:border-accent hover:text-accent">{T('Todas las preguntas', 'All questions')} →</a>
          </div>
          <div className="flex flex-col gap-2 lg:order-1">
            {faq.slice(0, 7).map((f) => (
              <details key={f.slug} className="panel group rounded-2xl px-5 py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
                  {f.question}
                  <span className="shrink-0 text-xl font-normal text-accent transition group-open:rotate-45">+</span>
                </summary>
                <div className="md md-compact pb-4 text-[14px] leading-relaxed text-ink-2" dangerouslySetInnerHTML={{ __html: f.html }} />
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** The "made with" seal: the TT mark and the name, bottom-right, linking to the site. */
export function MadeWith() {  // on a phone it would sit on top of the content (inputs, buttons): desktop only
  return (
    <a href="https://tablyteam.com" target="_blank" rel="noreferrer" className="fixed bottom-4 right-4 z-30 hidden items-center gap-2 rounded-full border border-line bg-surface/90 py-1.5 pl-1.5 pr-3.5 text-[12px] text-ink-2 shadow-md backdrop-blur transition hover:border-accent hover:text-ink sm:flex">
      <img src="/icon.svg?v=2" alt="" aria-hidden className="h-5 w-5 rounded-md" draggable={false} />
      <span>Made with <b className="font-semibold text-ink">Tably Team</b></span>
    </a>
  )
}

/* ------------------------------------------------------------------ demo stage */

function DemoBlock() {
  const clock = useClock()
  return <Demo clock={clock} />
}

function Demo({ clock }: { clock: ReturnType<typeof useClock> }) {
  const T = useT()
  const s = SCENES[clock.scene]
  const stage = useRef<HTMLDivElement>(null)
  // every scene change: the new scene's pieces cascade in and its SVG lines draw themselves (after framer's slide)
  useGSAP(() => {
    const el = stage.current
    if (!el) return
    const t = setTimeout(() => sceneIn(el), 60)
    return () => clearTimeout(t)
  }, { dependencies: [clock.key], scope: stage })
  const btn = 'flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-ink-2 transition hover:border-accent hover:text-accent'
  return (
    <div className="panel overflow-hidden rounded-3xl shadow-xl">
      <div className="flex items-center gap-2 px-4 h-10 border-b border-line bg-surface-2">
        <span className="w-2.5 h-2.5 rounded-full bg-[#E6A19A]" /><span className="w-2.5 h-2.5 rounded-full bg-[#E9C97A]" /><span className="w-2.5 h-2.5 rounded-full bg-[#9FCDA8]" />
        <span className="ml-3 text-[11px] font-mono text-ink-3">tablyteam · {T('app del clima', 'weather app')}</span>
        <span className={`ml-auto flex items-center gap-1.5 text-[11px] font-bold ${clock.paused ? 'text-ink-3' : 'text-danger'}`}><span className={`w-1.5 h-1.5 rounded-full ${clock.paused ? 'bg-ink-3' : 'bg-danger animate-pulse'}`} /> {clock.paused ? T('EN PAUSA', 'PAUSED') : T('EN VIVO', 'LIVE')}</span>
      </div>
      {/* what is happening on screen, with ‹ › to go back or skip ahead */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-accent-soft px-4 py-2.5">
        <button type="button" onClick={() => clock.jump(clock.scene - 1)} className={`${btn} max-sm:order-last max-sm:ml-auto`} aria-label={T('Paso anterior', 'Previous step')}><ChevronLeft size={15} /></button>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-white max-sm:self-start">{clock.scene + 1}</span>
        <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-2.5rem)]">
          <div className="flex items-baseline gap-2">
            <span className="text-[13.5px] font-semibold text-ink">{T(s.label, s.label_en)}</span>
            <span className="font-mono text-[10.5px] text-ink-3">{clock.scene + 1}/{SCENES.length}</span>
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={s.key} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[12.5px] leading-snug text-ink-2">{T(s.desc, s.desc_en)}</motion.div>
          </AnimatePresence>
          <div className="mt-1.5 flex gap-1">
            {SCENES.map((x, i) => (
              <button key={x.key} type="button" onClick={() => clock.jump(i)} className="h-1 flex-1 overflow-hidden rounded-full bg-black/10" aria-label={T(x.label, x.label_en)}>
                <div className="h-full bg-accent transition-[width]" style={{ width: clock.scene === i ? `${(clock.local / x.dur) * 100}%` : clock.scene > i ? '100%' : '0%' }} />
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={clock.toggle} className="flex h-7 w-7 items-center justify-center rounded-full border border-accent bg-accent text-white shadow-sm transition hover:brightness-110 max-sm:order-last" aria-label={clock.paused ? T('Reanudar', 'Resume') : T('Pausar', 'Pause')} title={clock.paused ? T('Reanudar', 'Resume') : T('Pausar para leer', 'Pause to read')}>
          {clock.paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button type="button" onClick={() => clock.jump(clock.scene + 1)} className={`${btn} max-sm:order-last`} aria-label={T('Paso siguiente', 'Next step')}><ChevronRight size={15} /></button>
      </div>
      <FitStage>
      <div ref={stage} className="relative h-[470px] bg-surface">
        <AnimatePresence mode="wait">
          {clock.key === 'idea' && <SceneIdea key="idea" t={clock.local} />}
          {clock.key === 'prompt' && <ScenePrompt key="prompt" t={clock.local} />}
          {clock.key === 'team' && <SceneTeam key="team" t={clock.local} />}
          {clock.key === 'refs' && <SceneRefs key="refs" t={clock.local} />}
          {clock.key === 'arena' && <SceneArena key="arena" t={clock.local} />}
          {clock.key === 'build' && <SceneBuild key="build" t={clock.local} />}
          {clock.key === 'deploy' && <SceneDeploy key="deploy" t={clock.local} />}
          {clock.key === 'analytics' && <SceneAnalytics key="analytics" t={clock.local} />}
          {clock.key === 'ads' && <SceneAds key="ads" t={clock.local} />}
          {clock.key === 'metaads' && <SceneMetaAds key="metaads" t={clock.local} />}
          {clock.key === 'market' && <SceneMarket key="market" t={clock.local} />}
          {clock.key === 'audit' && <SceneAudit key="audit" t={clock.local} />}
        </AnimatePresence>
      </div>
      </FitStage>
    </div>
  )
}

const STAGE_W = 600
/** The scenes are drawn for a 600 px stage (the cursor, the debate graph and the columns are placed in pixels): on a
 *  narrower screen the whole stage is scaled down, like a video of the app, instead of squeezing its pieces together. */
function FitStage({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = w && w < STAGE_W ? w / STAGE_W : 1
  return (
    <div ref={box} className="relative w-full min-w-0 overflow-hidden" style={{ height: scale < 1 ? 470 * scale : undefined }}>
      {/* absolute: a 600 px box scaled down still lays out 600 px wide and would push the whole page sideways */}
      <div style={scale < 1 ? { position: 'absolute', left: 0, top: 0, width: STAGE_W, transform: `scale(${scale})`, transformOrigin: 'top left' } : undefined}>{children}</div>
    </div>
  )
}

const sceneProps = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24, transition: { duration: 0.25 } },
  className: 'absolute inset-0 p-6',
}

function Cursor({ x, y, click }: { x: number; y: number; click?: boolean }) {
  return (
    <motion.div className="absolute z-20 pointer-events-none" animate={{ left: x, top: y, scale: click ? 0.85 : 1 }} transition={{ type: 'spring', stiffness: 120, damping: 18 }}>
      <svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1l15 9-7 1.5L13 19l-3 1-3-7.5L2 17z" fill="#1E2622" stroke="#fff" strokeWidth="1.5" /></svg>
    </motion.div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <div data-r className="text-[11px] uppercase tracking-widest text-ink-3">{children}</div>
}

function Check({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <div data-r className="flex items-center gap-2.5 text-[13px]">
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-[1.5px] text-[12px] font-bold transition-all ${on ? 'border-accent bg-accent text-white shadow-[0_0_0_4px_rgba(47,107,93,.15)]' : 'border-line bg-surface'}`}>{on ? '✓' : ''}</span>
      <span>{children}</span>
    </div>
  )
}

/* 1 · the user types the idea and attaches a document */
function SceneIdea({ t: raw }: { t: number }) {
  const t = raw * 0.78
  const T = useT()
  const idea = T(IDEA, IDEA_EN)
  const typed = Math.floor(ease((t - 300) / 2300) * idea.length)
  const clickDocs = t > 2700 && t < 2950
  const picker = t > 2950 && t < 4650
  const fileChosen = t > 3700
  const clickFile = t > 3550 && t < 3750
  const clickOpen = t > 4400 && t < 4650
  const attach = t > 4650
  const files = [['brief-clima.pdf', '14 págs · 1,2 MB'], ['logo-paraguas.png', '512×512'], ['notas-entrevistas.md', '6 KB'], ['competencia.xlsx', '3 hojas']]
  const cursor = t < 2500 ? { x: 330, y: 150 } : t < 2950 ? { x: 150, y: 262 } : t < 3750 ? { x: 250, y: 150 } : t < 4650 ? { x: 470, y: 300 } : { x: 420, y: 262 }
  return (
    <motion.div {...sceneProps}>
      <Label>{T('Nombre de la app', 'App name')}</Label>
      <div data-r className="mt-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-[14px]">{t > 200 ? T('Paraguas', 'Umbrella') : ''}</div>
      <div className="mt-4"><Label>{T('Qué querés construir', 'What you want to build')}</Label></div>
      <div data-r className="mt-1.5 min-h-[88px] rounded-xl border border-accent bg-surface px-4 py-3 text-[15px] leading-snug">
        {idea.slice(0, typed)}{t > 300 && typed < idea.length && <span className="caret" />}
      </div>
      <div data-r className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-3">
        <span>{T('Adjuntá lo que ayude:', 'Attach what helps:')}</span>
        {[T('documentos', 'documents'), T('carpeta', 'folder'), T('proyecto local', 'local project')].map((c, i) => (
          <motion.span key={c} animate={{ scale: i === 0 && clickDocs ? 0.94 : 1 }} className={`rounded-lg border px-2.5 py-1 transition-colors ${i === 0 && (picker || attach) ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2'}`}>{c}</motion.span>
        ))}
        <AnimatePresence>{attach && <motion.span initial={{ opacity: 0, scale: 0.8, x: -8 }} animate={{ opacity: 1, scale: 1, x: 0 }} className="rounded-lg bg-accent-soft px-2.5 py-1 text-accent">📎 brief-clima.pdf ✓</motion.span>}</AnimatePresence>
      </div>
      {/* the file picker, like the system dialog */}
      <AnimatePresence>
        {picker && (
          <motion.div key="picker" initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8, transition: { duration: 0.18 } }} transition={{ type: 'spring', stiffness: 260, damping: 24 }} className="absolute left-1/2 top-1/2 z-10 w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_-20px_rgba(30,38,34,.45)]">
            <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#E6A19A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#E9C97A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#9FCDA8]" />
              <span className="ml-2 text-[12px] font-semibold text-ink-2">{T('Elegí los documentos', 'Choose the documents')}</span>
              <span className="ml-auto rounded-md border border-line bg-surface px-2 py-0.5 text-[10.5px] text-ink-3">📁 {T('Documentos', 'Documents')}</span>
            </div>
            <div className="grid grid-cols-[120px_1fr]">
              <div className="border-r border-line bg-surface-2/40 p-2 text-[11.5px] text-ink-2">
                {[T('Recientes', 'Recent'), T('Escritorio', 'Desktop'), T('Documentos', 'Documents'), T('Descargas', 'Downloads')].map((f, i) => <div key={f} className={`rounded-md px-2 py-1 ${i === 2 ? 'bg-accent-soft font-medium text-accent' : ''}`}>{f}</div>)}
              </div>
              <div className="p-2">
                {files.map(([name, meta], i) => (
                  <div key={name} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors ${i === 0 && fileChosen ? 'bg-accent text-white' : 'text-ink'}`}>
                    <span className="text-[15px]">{name.endsWith('.pdf') ? '📄' : name.endsWith('.png') ? '🖼️' : name.endsWith('.md') ? '📝' : '📊'}</span>
                    <span className="flex-1 truncate font-medium">{name}</span>
                    <span className={`text-[10.5px] ${i === 0 && fileChosen ? 'text-white/80' : 'text-ink-3'}`}>{meta}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
              <span className="rounded-lg border border-line px-3 py-1 text-[12px] text-ink-2">{T('Cancelar', 'Cancel')}</span>
              <motion.span animate={{ scale: clickOpen ? 0.94 : 1 }} className={`rounded-lg px-3 py-1 text-[12px] font-semibold text-white ${fileChosen ? 'bg-accent' : 'bg-ink-4'}`}>{T('Abrir', 'Open')}</motion.span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div data-r className="mt-5 grid grid-cols-[1fr_1fr] gap-5">
        <div>
          <Label>{T('Modo', 'Mode')}</Label>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {[T('Handoff libre', 'Free handoff'), T('Debate', 'Debate'), T('Mesa redonda', 'Round table')].map((m, i) => <span key={m} className={`rounded-lg border px-2 py-1.5 text-center text-[12px] ${i === 0 ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-2'}`}>{m}</span>)}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[[T('Turnos máx.', 'Max turns'), '14', 0.35], [T('Tokens por turno', 'Tokens per turn'), '1800', 0.3]].map(([l, v, w]) => (
            <div key={String(l)}>
              <div className="flex justify-between text-[10px] uppercase tracking-widest text-ink-3"><span>{l}</span><span className="font-mono text-ink">{v}</span></div>
              <div className="mt-2 h-1.5 rounded-full bg-black/5"><div className="relative h-full rounded-full bg-accent" style={{ width: `${Number(w) * 100}%` }}><span className="absolute -right-1.5 -top-[5px] h-4 w-4 rounded-full border-2 border-accent bg-surface" /></div></div>
            </div>
          ))}
        </div>
      </div>
      <Cursor x={cursor.x} y={cursor.y} click={clickDocs || clickFile || clickOpen} />
    </motion.div>
  )
}

/* 2 · "Generar prompt engineering": reads the files, asks two questions, replaces the text with a real brief */
function ScenePrompt({ t: raw }: { t: number }) {
  const t = raw * 0.78
  const T = useT()
  const pressed = t > 300 && t < 700
  const reading = t > 700
  const thinking = t > 1500
  const asked = t > 2300
  const a1 = t > 3100
  const a2 = t > 3700
  const generated = t > 4500
  const lines = BRIEF_LINES.filter((_, i) => t > 4700 + i * 380)
  return (
    <motion.div {...sceneProps}>
      <div data-r className="flex items-center gap-3">
        <motion.div animate={{ scale: pressed ? 0.95 : 1 }} className="relative flex items-center gap-2 overflow-hidden rounded-xl px-4 py-2 text-[13.5px] font-semibold text-white shadow-md" style={{ background: 'linear-gradient(100deg,#B85C38,#D97757 60%,#E8956F)' }}>
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90"><ProviderLogo provider="meta" size={13} /></span> {T('Generar prompt engineering a mi texto', 'Prompt-engineer my text')}
        </motion.div>
        <span className="text-[12px] text-ink-3">{T('con', 'with')} Muse · muse-spark-1.3</span>
      </div>
      <div className="mt-4 grid h-[calc(100%-60px)] grid-cols-[1fr_1.1fr] gap-4">
        <div className="space-y-2 text-[12.5px]">
          {reading && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-ink-2"><span className="text-accent">📄</span> {T('Leyendo brief-clima.pdf', 'Reading brief-clima.pdf')} <span className="text-ink-4">· 14 {T('páginas', 'pages')}</span></motion.div>}
          {thinking && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-ink-2"><span className="text-accent">💭</span> {T('Pensando qué falta para construir…', 'Thinking what is missing to build…')}</motion.div>}
          {asked && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-line bg-surface-2 p-3">
              <Label>{T('Dos preguntas antes de seguir', 'Two questions before going on')}</Label>
              <div className="mt-2 space-y-1.5">
                <Check on={a1}><b>{T(QUESTIONS[0][0], QUESTIONS[0][1])}</b> <span className="text-ink-3">{a1 ? T('→ solo PWA', '→ PWA only') : ''}</span></Check>
                <Check on={a2}><b>{T(QUESTIONS[1][0], QUESTIONS[1][1])}</b> <span className="text-ink-3">{a2 ? T('→ SMN oficial', '→ official SMN') : ''}</span></Check>
              </div>
            </motion.div>
          )}
        </div>
        <div className={`rounded-xl border p-3 font-mono text-[11.5px] leading-relaxed transition-colors ${generated ? 'border-accent bg-surface' : 'border-dashed border-line bg-surface-2/60'}`}>
          {!generated && <span className="text-ink-4">{T('el prompt generado reemplaza tu texto…', 'the generated prompt replaces your text…')}</span>}
          {lines.map(([es, en], i) => <motion.div key={es} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} className={i === 0 ? 'font-bold text-ink' : 'text-ink-2'}>{T(es, en)}</motion.div>)}
          {generated && lines.length === BRIEF_LINES.length && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 text-[10.5px] text-accent">✓ {T('Brief generado · 1.240 palabras · reemplazó tu texto', 'Brief generated · 1,240 words · replaced your text')}</motion.div>}
        </div>
      </div>
      <Cursor x={t < 900 ? 120 : a2 ? 70 : 60} y={t < 900 ? 40 : a2 ? 232 : 205} click={pressed || (t > 2900 && t < 3100) || (t > 3500 && t < 3700)} />
    </motion.div>
  )
}

/* 3 · the team: one role per card, each on its own company and model */
function SceneTeam({ t: raw }: { t: number }) {
  const t = raw * 0.78
  const T = useT()
  const on = TEAM.filter((_, i) => t > 500 + i * 650)
  const i = Math.min(5, Math.floor((t - 200) / 650))
  const cx = 60 + (Math.max(0, i) % 3) * 180 + 60
  const cy = 70 + Math.floor(Math.max(0, i) / 3) * 190 + 40
  return (
    <motion.div {...sceneProps} className="absolute inset-0 flex flex-col p-5">
      <div className="flex items-center justify-between">
        <Label>{T('Agentes (6/8) · cada rol con su IA, su prompt y sus skills', 'Agents (6/8) · each role with its AI, prompt and skills')}</Label>
        <span data-r className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px] text-ink-2">{on.length}/6 {T('listos', 'ready')}</span>
      </div>
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-3 grid-rows-2 gap-3">
        {TEAM.map((m) => {
          const picked = on.includes(m)
          const theme = brandTheme(m.provider)
          return (
            <motion.div
              data-r
              key={m.id}
              animate={{ scale: picked ? [1, 1.04, 1] : 1, opacity: picked ? 1 : 0.55 }}
              transition={{ duration: 0.45 }}
              className="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border p-3.5 shadow-[0_14px_30px_-18px_rgba(30,38,34,.45)]"
              style={{ background: picked ? theme.bg : '#F6F7F6', borderColor: picked ? m.color : '#DCE2DE' }}
            >
              {picked && <LogoWatermark provider={m.provider} opacity={0.1} />}
              <div className="relative flex items-center gap-2">
                <span className="rounded-full bg-surface p-[2px] shadow-sm" style={{ boxShadow: `0 0 0 1.5px ${picked ? m.color : '#DCE2DE'}` }}><AgentAvatar agent={{ name: m.name, role: m.id, provider: m.provider }} size={38} ring={false} logo={0.34} chip /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold leading-tight" style={{ color: picked ? m.color : undefined }}>{T(m.name, m.name_en)}</div>
                  <div className="truncate text-[10px] uppercase tracking-widest text-ink-3">{T(m.role, m.role_en)}</div>
                </div>
                <span className={`flex h-6 w-6 items-center justify-center rounded-full border-[1.5px] text-[12px] font-bold transition-all ${picked ? 'border-accent bg-accent text-white shadow-[0_0_0_4px_rgba(47,107,93,.18)]' : 'border-line bg-surface text-transparent'}`}>✓</span>
              </div>
              <div className="relative mt-2 inline-flex w-fit items-center gap-1 rounded-md bg-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-ink-2 ring-1 ring-black/5">{m.model}</div>
              <div className="relative mt-2 line-clamp-2 text-[12px] italic leading-snug text-ink-2">{picked ? `“${T(m.persona, m.persona_en)}”` : '—'}</div>
              <div className="relative mt-auto flex flex-wrap gap-1 pt-2">
                {picked && m.skills.map((sk) => <span key={sk} className="rounded-md border border-black/5 bg-surface/90 px-1.5 py-[2px] text-[10px] text-ink-2">🧩 {sk}</span>)}
                {picked && <span className="rounded-md bg-accent-soft px-1.5 py-[2px] text-[10px] font-semibold text-accent">prompt ✓</span>}
              </div>
            </motion.div>
          )
        })}
      </div>
      <Cursor x={cx} y={cy} click={t % 650 > 250 && t % 650 < 400 && t < 4400} />
    </motion.div>
  )
}

/* 4 · reference apps to study, the research checkbox and the paid reverse-engineering toggle, then launch */
function SceneRefs({ t: raw }: { t: number }) {
  const t = raw * 0.78
  const T = useT()
  const chips = REFS.filter((_, i) => t > 500 + i * 650)
  const research = t > 2700
  const deep = t > 3600
  const launch = t > 4900
  const notes: [string, string][][] = [
    [[T('emular: pronóstico por horas arriba', 'emulate: hourly forecast on top'), T('evitar: 3 pantallas para una ciudad', 'avoid: 3 screens for one city')]],
    [[T('emular: mapa como segunda vista', 'emulate: map as second view'), T('evitar: densidad de datos', 'avoid: data density')]],
    [[T('emular: alertas con color y fuente', 'emulate: alerts with colour and source'), T('evitar: publicidad entre datos', 'avoid: ads between data')]],
  ]
  return (
    <motion.div {...sceneProps} className="absolute inset-0 flex flex-col p-6">
      <Label>{T('Apps de referencia', 'Reference apps')}</Label>
      <div data-r className="mt-1.5 flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-xl border border-accent bg-surface px-3 py-2">
        {chips.map((c) => <motion.span key={c} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12.5px] text-accent">{c} ×</motion.span>)}
        {chips.length < REFS.length && <span className="text-[13px] text-ink-4">{t > 300 ? <span className="caret" /> : T('ej. apple.com/weather, windy.com', 'e.g. apple.com/weather, windy.com')}</span>}
      </div>
      <div className="mt-3 grid grid-cols-[1.1fr_1fr] gap-x-6 gap-y-2">
        <Check on={research}>{T('Investigar apps de referencia', 'Research reference apps')} <span className="text-ink-3">{T('(capturas y notas: qué emular, qué evitar)', '(screenshots and notes: what to emulate, what to avoid)')}</span></Check>
        <Check on={t > 1000}>{T('Diseño UX/UI primero', 'UX/UI design first')} <span className="text-ink-3">{T('(aprobás el mockup)', '(you approve the mockup)')}</span></Check>
        <Check on={deep}>{T('Análisis profundo e ingeniería inversa', 'Deep analysis and reverse engineering')} <span className="text-ink-3">{T('(REA entiende cómo están hechas)', '(REA understands how they are built)')}</span></Check>
        <Check on={t > 1400}>{T('Revisión pre-producción', 'Pre-production review')} <span className="text-ink-3">{T('(hasta 3 rondas)', '(up to 3 rounds)')}</span></Check>
      </div>
      {/* the benchmark: one card per reference, screenshot on top, what the team wrote underneath */}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-3 gap-3">
        {REFS.map((r, i) => {
          const on = research && t > 2900 + i * 450
          return (
            <motion.div key={r} data-r animate={{ opacity: on ? 1 : 0.35, y: on ? 0 : 6 }} className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[0_14px_30px_-18px_rgba(30,38,34,.4)]">
              <div className="relative h-[72px] shrink-0" style={{ background: ['linear-gradient(135deg,#BFD9F2,#E8F1FA)', 'linear-gradient(135deg,#1E3A5F,#4C7FB5)', 'linear-gradient(135deg,#F4D6A3,#F9ECD6)'][i] }}>
                <div className="absolute left-2 top-2 h-2 w-16 rounded bg-white/70" /><div className="absolute left-2 top-6 h-5 w-10 rounded bg-white/80" /><div className="absolute right-2 bottom-2 flex gap-1">{[0, 1, 2, 3].map((k) => <span key={k} className="h-6 w-3 rounded-sm bg-white/60" style={{ height: 10 + k * 5 }} />)}</div>
                {on && <span className="absolute right-2 top-2 rounded bg-black/40 px-1.5 py-[1px] text-[9px] font-semibold text-white">📷 {deep ? 'REA ✓' : T('capturas', 'shots')}</span>}
              </div>
              <div className="min-h-0 flex-1 p-2">
                <div className="truncate font-mono text-[10px] text-ink-3">{r}</div>
                {on && notes[i].map(([a, b]) => (
                  <div key={a} className="mt-1 space-y-0.5 text-[10.5px] leading-snug">
                    <div className="flex gap-1 text-ink-2"><span className="text-ok">✓</span><span className="truncate">{a}</span></div>
                    <div className="flex gap-1 text-ink-2"><span className="text-danger">✕</span><span className="truncate">{b}</span></div>
                  </div>
                ))}
              </div>
            </motion.div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center justify-end">
        <motion.div animate={{ scale: launch ? 0.96 : 1 }} className="relative flex items-center gap-2 overflow-hidden rounded-2xl px-5 py-2.5 text-[14px] font-semibold text-white shadow-md" style={{ background: 'linear-gradient(100deg,#B85C38,#D97757 60%,#E8956F)' }}>
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90"><ProviderLogo provider="meta" size={13} /></span> {T('Iniciar experimento', 'Start experiment')}
        </motion.div>
      </div>
      <Cursor x={launch ? 560 : deep ? 40 : research ? 40 : 200} y={launch ? 420 : deep ? 150 : research ? 122 : 60} click={launch || (t > 2500 && t < 2700) || (t > 3400 && t < 3600)} />
    </motion.div>
  )
}

/* 5 · the team debates: CEO → CTO → Head of Eng → Product */
const R = 128
const CX = 280
const CY = 238
const pos = (i: number) => ({ x: CX + Math.cos(-Math.PI / 2 + (i * Math.PI) / 2) * R * 1.55, y: CY + Math.sin(-Math.PI / 2 + (i * Math.PI) / 2) * R })
const BUBBLE = (i: number, p: { x: number; y: number }) =>
  [{ left: p.x + 46, top: p.y - 26 }, { left: p.x - 210, top: p.y + 44 }, { left: p.x - 46 - 210, top: p.y - 44 }, { left: p.x - 30, top: p.y + 44 }][i]

const curveBetween = (a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.18) => {
  const mx = (a.x + b.x) / 2 - (b.y - a.y) * bend
  const my = (a.y + b.y) / 2 + (b.x - a.x) * bend
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`
}

function SceneArena({ t }: { t: number }) {
  const T = useT()
  const idx = Math.min(TURNS.length - 1, Math.floor(t / 2600))
  const turn = TURNS[idx]
  const turnText = T(turn.text, turn.text_en)
  const local = t - idx * 2600
  const handing = local > 1900
  const chars = Math.floor(ease((local - 250) / 1400) * turnText.length)
  const P = Object.fromEntries(ARENA.map((m, i) => [m.id, pos(i)]))
  const from = P[turn.from]
  const to = P[turn.to]
  const mf = MEMBER[turn.from]
  const mt = MEMBER[turn.to]
  const svg = useRef<SVGSVGElement>(null)
  // the live handoff: the path draws itself and three glowing particles ride it, GSAP MotionPath
  useGSAP(() => {
    const root = svg.current
    if (!root || !handing) return
    const path = root.querySelector<SVGPathElement>('[data-live-path]')
    const dots = root.querySelectorAll('[data-particle]')
    if (!path) return
    const tl = gsap.timeline()
    tl.fromTo(path, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.55, ease: 'power2.out' })
      .set(dots, { opacity: 1 })
      .to(dots, { motionPath: { path, align: path, alignOrigin: [0.5, 0.5] }, duration: 1.0, ease: 'power1.inOut', stagger: 0.22, repeat: -1 }, 0.3)
    return () => { tl.kill() }
  }, { dependencies: [handing, idx], scope: svg })
  return (
    <motion.div {...sceneProps} className="absolute inset-0">
      <div className="absolute left-5 top-4 text-[11px] uppercase tracking-widest text-ink-3">{T('Turno', 'Turn')} {idx + 1} {T('· el equipo decide producto, stack y alcance', '· the team decides product, stack and scope')}</div>
      <div className="absolute left-1/2 top-0 -translate-x-1/2 w-[560px] h-full">
        <div className="absolute text-center w-[170px]" style={{ left: CX - 85, top: CY - 26 }}>
          <div className="text-[10px] uppercase tracking-[0.3em] text-accent">{T('proyecto', 'project')}</div>
          <div className="serif text-[14px] leading-snug mt-1 text-ink-2">{T('Paraguas · app del clima', 'Umbrella · weather app')}</div>
        </div>
        <svg ref={svg} className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            {ARENA.map((m) => (
              <linearGradient key={m.id} id={`g-${m.id}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={m.color} stopOpacity="0.15" /><stop offset="1" stopColor={m.color} stopOpacity="0.9" /></linearGradient>
            ))}
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor" /></marker>
          </defs>
          {/* the table: who can talk to whom */}
          {ARENA.map((a, i) => ARENA.slice(i + 1).map((b) => <path data-draw key={a.id + b.id} d={curveBetween(P[a.id], P[b.id], 0.08)} fill="none" stroke="#1E2622" strokeOpacity="0.09" strokeWidth="1.5" strokeDasharray="3 7" />))}
          {/* handoffs already made: a gradient arc in the speaker's colour, with its arrow */}
          {TURNS.slice(0, idx).map((h) => (
            <path key={h.from + h.to} d={curveBetween(P[h.from], P[h.to])} fill="none" stroke={`url(#g-${h.from})`} strokeWidth="3" strokeLinecap="round" markerEnd="url(#arrow)" style={{ color: MEMBER[h.from].color }} />
          ))}
          {handing && (
            <g>
              <path data-live-path d={curveBetween(from, to)} fill="none" stroke={mf.color} strokeWidth="3.5" strokeLinecap="round" markerEnd="url(#arrow)" style={{ color: mf.color }} filter="url(#glow)" />
              {[0, 1, 2].map((k) => <circle key={k} data-particle r={k === 0 ? 6 : 4} fill={mf.color} stroke="#FFFFFF" strokeWidth="2" opacity="0" filter="url(#glow)" />)}
            </g>
          )}
        </svg>
        {ARENA.map((m) => {
          const p = P[m.id]
          const on = m.id === turn.from && !handing
          const target = m.id === turn.to && handing
          return (
            <div data-r key={m.id} className="absolute" style={{ left: p.x, top: p.y, transform: 'translate(-50%,-50%)' }}>
              {/* soft halo that breathes while the role talks */}
              <motion.div className="absolute -inset-5 rounded-full" style={{ background: `radial-gradient(circle, ${m.color}44 0%, transparent 70%)` }} animate={{ scale: on ? [1, 1.25, 1] : target ? 1.1 : 0.6, opacity: on ? 1 : target ? 0.7 : 0 }} transition={on ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }} />
              <motion.div
                animate={{ scale: on ? 1.1 : target ? 1.05 : 1, y: on ? -4 : 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                className="relative flex w-[112px] flex-col items-center"
              >
                <span className="rounded-full bg-surface p-[3px] shadow-[0_10px_24px_-10px_rgba(30,38,34,.5)]" style={{ boxShadow: `0 0 0 ${on || target ? 3 : 2}px ${on || target ? m.color : m.color + '66'}` }}>
                  <AgentAvatar agent={{ name: m.name, role: m.id, provider: m.provider }} size={74} ring={false} logo={0.34} chip />
                </span>
                <div className="serif mt-1.5 text-[13px] leading-tight text-ink">{T(m.name, m.name_en)}</div>
                <div className="font-mono text-[8.5px] text-ink-3">{m.model.split('-').slice(0, 2).join('-')}</div>
              </motion.div>
            </div>
          )
        })}
        <AnimatePresence mode="wait">
          {!handing ? (
            <motion.div
              key={`b-${idx}`}
              initial={{ opacity: 0, scale: 0.9, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className="absolute w-[210px] rounded-xl bg-surface px-3.5 py-2.5 text-[13px] leading-snug shadow-[0_18px_40px_-16px_rgba(30,38,34,.45)] border border-line"
              style={{ borderTop: `3px solid ${mf.color}`, ...BUBBLE(ARENA.findIndex((m) => m.id === turn.from), from) }}
            >
              <div className="text-[10px] uppercase tracking-widest" style={{ color: mf.color }}>{T(mf.name, mf.name_en)} · {T(turn.stance, turn.stance_en)}</div>
              <div className="mt-1 text-ink">{turnText.slice(0, chars)}{chars < turnText.length && <span className="caret" />}</div>
            </motion.div>
          ) : (
            <motion.div key={`h-${idx}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="absolute left-1/2 -translate-x-1/2 bottom-4 rounded-full bg-surface border border-line shadow-md px-4 py-1.5 text-[13px] whitespace-nowrap">
              <span className="font-semibold" style={{ color: mf.color }}>{T(mf.name, mf.name_en)}</span>
              <span className="text-ink-3"> ➜ </span>
              <span className="font-semibold" style={{ color: mt.color }}>{T(mt.name, mt.name_en)}</span>
              <span className="text-ink-3 italic"> “{T(turn.reason, turn.reason_en)}”</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

/** A believable phone: titanium frame, side keys, dynamic island, status bar, the weather app's home screen and the home indicator. */
function PhoneMock() {
  const T = useT()
  const hours = [
    { h: '12', t: 17, r: 20 }, { h: '13', t: 18, r: 30 }, { h: '14', t: 18, r: 45 }, { h: '15', t: 17, r: 70 }, { h: '16', t: 16, r: 65 }, { h: '17', t: 15, r: 40 }, { h: '18', t: 15, r: 25 },
  ]
  const days = [
    { d: T('Mañana', 'Tomorrow'), lo: 11, hi: 19, r: 20 }, { d: T('Sáb', 'Sat'), lo: 12, hi: 22, r: 5 }, { d: T('Dom', 'Sun'), lo: 13, hi: 24, r: 0 },
  ]
  const Drop = ({ size = 10, on = true }: { size?: number; on?: boolean }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? '#3D5CC4' : '#B8C7D6'}><path d="M12 2.5c3.5 5 7 8.6 7 12.6A7 7 0 0 1 5 15.1c0-4 3.5-7.6 7-12.6z" /></svg>
  )
  return (
    <div className="relative" style={{ width: 206 }}>
      {/* side keys */}
      <span className="absolute -left-[3px] top-[74px] h-6 w-[3px] rounded-l bg-[#3a3f3c]" />
      <span className="absolute -left-[3px] top-[108px] h-10 w-[3px] rounded-l bg-[#3a3f3c]" />
      <span className="absolute -left-[3px] top-[154px] h-10 w-[3px] rounded-l bg-[#3a3f3c]" />
      <span className="absolute -right-[3px] top-[118px] h-14 w-[3px] rounded-r bg-[#3a3f3c]" />
      {/* frame */}
      <div className="rounded-[34px] p-[3px] shadow-[0_30px_60px_-24px_rgba(30,38,34,.55),0_2px_6px_rgba(0,0,0,.25)]" style={{ background: 'linear-gradient(160deg,#5d6360 0%,#2b302d 35%,#1a1e1c 70%,#4a504d 100%)' }}>
        <div className="rounded-[31px] bg-black p-[7px]">
          <div className="relative overflow-hidden rounded-[24px] bg-[#F3F7FB] text-ink" style={{ height: 396 }}>
            {/* status bar + dynamic island */}
            <div className="relative flex items-center justify-between px-5 pt-2.5 text-[10.5px] font-semibold">
              <span>9:41</span>
              <span className="absolute left-1/2 top-2 h-[18px] w-[62px] -translate-x-1/2 rounded-full bg-black" />
              <span className="flex items-center gap-1">
                <svg width="13" height="9" viewBox="0 0 13 9" fill="#1E2622"><rect x="0" y="6" width="2" height="3" rx=".5" /><rect x="3.5" y="4" width="2" height="5" rx=".5" /><rect x="7" y="2" width="2" height="7" rx=".5" /><rect x="10.5" y="0" width="2" height="9" rx=".5" /></svg>
                <svg width="12" height="9" viewBox="0 0 12 9" fill="#1E2622"><path d="M6 8.5 3.8 6.3a3.1 3.1 0 0 1 4.4 0zM1.5 4 .2 2.7a8.2 8.2 0 0 1 11.6 0L10.5 4a6.4 6.4 0 0 0-9 0z" /></svg>
                <svg width="20" height="10" viewBox="0 0 20 10"><rect x=".5" y=".5" width="16" height="9" rx="2.5" fill="none" stroke="#1E2622" strokeOpacity=".5" /><rect x="2" y="2" width="12" height="6" rx="1.5" fill="#1E2622" /><rect x="17.5" y="3" width="1.5" height="4" rx=".75" fill="#1E2622" fillOpacity=".5" /></svg>
              </span>
            </div>
            {/* header */}
            <div className="mt-3 px-4">
              <div className="flex items-center gap-1 text-[11px] text-ink-2"><svg width="10" height="12" viewBox="0 0 10 12" fill="#2F6B5D"><path d="M5 0a5 5 0 0 0-5 5c0 3.5 5 7 5 7s5-3.5 5-7a5 5 0 0 0-5-5zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" /></svg> Buenos Aires</div>
              <div className="mt-1 flex items-start justify-between">
                <div>
                  <div className="font-mono text-[44px] font-bold leading-none tracking-tight">17°</div>
                  <div className="mt-1 text-[10.5px] text-ink-2">{T('Nublado · máx 19° · mín 11°', 'Cloudy · high 19° · low 11°')}</div>
                </div>
                <svg width="46" height="40" viewBox="0 0 46 40"><ellipse cx="27" cy="18" rx="16" ry="11" fill="#CBD6E0" /><ellipse cx="15" cy="21" rx="11" ry="9" fill="#DCE4EC" /><g fill="#3D5CC4"><path d="M14 30c1.5 2 1.5 3.5 0 5-1.5-1.5-1.5-3 0-5z" /><path d="M23 31c1.5 2 1.5 3.5 0 5-1.5-1.5-1.5-3 0-5z" /><path d="M32 30c1.5 2 1.5 3.5 0 5-1.5-1.5-1.5-3 0-5z" /></g></svg>
              </div>
            </div>
            {/* the verdict */}
            <div className="mx-3 mt-3 rounded-2xl bg-[#2F6B5D] px-3 py-2.5 text-white shadow-[0_8px_18px_-10px_rgba(47,107,93,.8)]">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-[15px]">☔</span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold leading-tight">{T('Llevá paraguas', 'Take an umbrella')}</div>
                  <div className="text-[9.5px] opacity-80">{T('70 % de lluvia entre 15 y 18 h', '70% chance of rain, 3 to 6 pm')}</div>
                </div>
              </div>
            </div>
            {/* hourly */}
            <div className="mt-3 px-3 text-[9.5px] font-semibold uppercase tracking-wider text-ink-3">{T('Por horas', 'Hourly')}</div>
            <div className="mt-1 flex gap-1 px-3">
              {hours.map((x) => (
                <div key={x.h} className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1 ${x.r >= 60 ? 'bg-[#E4ECF7]' : 'bg-white'} ring-1 ring-black/[.04]`}>
                  <span className="font-mono text-[8px] text-ink-3">{x.h}</span>
                  <Drop size={9} on={x.r >= 40} />
                  <span className="text-[9px] font-semibold">{x.t}°</span>
                </div>
              ))}
            </div>
            {/* days */}
            <div className="mx-3 mt-2.5 divide-y divide-black/[.05] rounded-xl bg-white ring-1 ring-black/[.04]">
              {days.map((d) => (
                <div key={d.d} className="flex items-center gap-2 px-2.5 py-1.5 text-[10px]">
                  <span className="w-12 font-medium">{d.d}</span>
                  <span className="flex w-7 items-center gap-0.5 text-[8.5px] text-[#3D5CC4]"><Drop size={8} on={d.r > 0} />{d.r}%</span>
                  <span className="text-ink-3">{d.lo}°</span>
                  <span className="relative mx-1 h-1 flex-1 rounded-full bg-black/[.06]"><span className="absolute inset-y-0 rounded-full bg-gradient-to-r from-[#8FB7D3] to-[#E9B35C]" style={{ left: `${(d.lo - 8) * 5}%`, right: `${100 - (d.hi - 8) * 5}%` }} /></span>
                  <span className="font-semibold">{d.hi}°</span>
                </div>
              ))}
            </div>
            {/* alert */}
            <div className="mx-3 mt-2.5 flex items-center gap-1.5 rounded-lg border border-[#E9C97A] bg-[#FFF6DF] px-2 py-1 text-[9px] text-[#8A5A00]"><span>⚠</span>{T('Alerta amarilla por tormentas · SMN', 'Yellow storm alert · SMN')}</div>
            {/* tab bar */}
            <div className="absolute inset-x-0 bottom-0 border-t border-black/[.06] bg-white/90 px-4 pb-3 pt-1.5 backdrop-blur">
              <div className="flex justify-between text-[8.5px]">
                {[[T('Hoy', 'Today'), true], [T('Mapa', 'Map'), false], [T('Alertas', 'Alerts'), false]].map(([l, on]) => (
                  <span key={String(l)} className={`flex flex-col items-center gap-0.5 ${on ? 'text-[#2F6B5D]' : 'text-ink-3'}`}><span className={`h-3.5 w-3.5 rounded-md ${on ? 'bg-[#2F6B5D]' : 'bg-ink-4/60'}`} />{l}</span>
                ))}
              </div>
              <span className="mx-auto mt-2 block h-[4px] w-[64px] rounded-full bg-black/80" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* 6 · the team at work: research → reverse engineering → design (approved by you) → build → polish → council review; the product appears on the right */
function SceneBuild({ t }: { t: number }) {
  const T = useT()
  const STEP = 1850
  const done = Math.min(BUILD_STEPS.length, Math.floor(t / STEP))
  const active = Math.min(BUILD_STEPS.length - 1, Math.floor(t / STEP))
  const progress = ease((t - active * STEP) / STEP)
  const files = ['package.json', 'app/page.tsx', 'lib/weather.ts', 'components/Umbrella.tsx', 'components/Hourly.tsx', 'styles/tokens.css']
  const shown = active >= 3 ? files.filter((_, i) => t > 3 * STEP + i * 220) : active > 3 ? files : []
  const appOn = t > 3 * STEP + 600
  const finished = t > BUILD_STEPS.length * STEP
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1.25fr_1fr] gap-5">
        <div className="min-w-0">
          <Label>{T('El equipo trabaja · vos aprobás', 'The team works · you approve')}</Label>
          <ol className="mt-2.5 space-y-1.5">
            {BUILD_STEPS.map((s, i) => {
              const isDone = i < done
              const isActive = i === active && !finished
              return (
                <li data-r key={s.key} className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 transition-colors ${isActive ? 'border-accent bg-accent-soft' : isDone ? 'border-line bg-surface' : 'border-dashed border-line bg-surface-2/50'}`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${isDone ? 'bg-accent text-white' : isActive ? 'bg-surface text-accent ring-2 ring-accent' : 'bg-surface-2 text-ink-3'}`}>{isDone ? '✓' : i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12.5px] font-semibold leading-tight">
                      {T(s.label, s.label_en)}
                      {s.key === 'design' && isDone && <span className="rounded bg-accent-soft px-1.5 text-[9.5px] font-semibold text-accent">{T('aprobado por vos', 'approved by you')}</span>}
                      {s.key === 'review' && isDone && <span className="text-[13px]">👑</span>}
                    </div>
                    <div className="truncate text-[10.5px] text-ink-3">{s.key === 'build' && shown.length ? `${shown.slice(-3).join(' · ')}${shown.length > 3 ? ` · +${shown.length - 3}…` : ''}` : T(s.detail, s.detail_en)}</div>
                    {isActive && <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/5"><div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} /></div>}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
        <div className="relative flex items-center justify-center">
          <motion.div data-r animate={{ opacity: appOn ? 1 : 0.3, scale: appOn ? 1 : 0.96, filter: appOn ? 'blur(0px)' : 'blur(2px)' }} className="relative">
            <PhoneMock />
          </motion.div>
          <AnimatePresence>
            {finished && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink px-3 py-1 text-[11.5px] font-semibold text-paper shadow-lg">
                v1 · 100 % {T('listo', 'ready')} · {T('Abrir la app', 'Open the app')} ↗
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

/* 7 · publish: one click on Tably Cloud, the deploy runs and the app gets a public URL that opens from anywhere */
const DEPLOY_STEPS: [string, string][] = [
  ['Empaqueta la v1 aprobada', 'Packs the approved v1'],
  ['Base de datos y auth si los necesita', 'Database and auth when needed'],
  ['Repositorio git propio', 'Its own git repository'],
  ['HTTPS y dominio público', 'HTTPS and a public domain'],
  ['En línea', 'Live'],
]
const DEPLOY_LOG = ['▸ build  vite build · 38 kB gz', '▸ env    3 variables desde «Servicios»', '▸ cert   TLS emitido', '▸ health GET / → 200 en 84 ms']
const PLACES: [string, string][] = [['📱 Buenos Aires', '📱 Buenos Aires'], ['💻 Madrid', '💻 Madrid'], ['📱 Ciudad de México', '📱 Mexico City'], ['💻 Nueva York', '💻 New York']]
function SceneDeploy({ t }: { t: number }) {
  const T = useT()
  const clicked = t > 1100
  const STEP = 1100
  const done = clicked ? Math.min(DEPLOY_STEPS.length, Math.floor((t - 1300) / STEP) + 1) : 0
  const live = done >= DEPLOY_STEPS.length
  const url = 'https://paraguas.tablyteam.app'
  const typed = live ? url.slice(0, Math.floor(ease((t - 6800) / 900) * url.length)) : ''
  const open = t > 7900
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1.1fr_1fr] gap-5">
        <div className="min-w-0">
          <Label>Tably Cloud · {T('publicar', 'publish')}</Label>
          <div data-r className={`mt-2 flex h-9 items-center justify-center gap-2 rounded-xl text-[13px] font-semibold shadow-md transition-colors ${live ? 'bg-ink text-paper' : 'bg-accent text-white'}`}>
            {live ? `● ${T('En línea', 'Live')} · v1` : clicked ? T('Publicando…', 'Publishing…') : `⬆ ${T('Publicar ahora', 'Publish now')}`}
          </div>
          <ol className="mt-3 space-y-1.5">
            {DEPLOY_STEPS.map(([es, en], i) => {
              const ok = i < done
              const now = clicked && i === done
              return (
                <li data-r key={es} className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] ${now ? 'border-accent bg-accent-soft' : ok ? 'border-line bg-surface' : 'border-dashed border-line text-ink-3'}`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${ok ? 'bg-accent text-white' : now ? 'ring-2 ring-accent' : 'bg-surface-2'}`}>{ok ? '✓' : i + 1}</span>
                  {T(es, en)}
                </li>
              )
            })}
          </ol>
          <div data-r className="mt-3 h-[92px] overflow-hidden rounded-lg bg-[#141a17] p-2.5 font-mono text-[10.5px] leading-relaxed text-[#9FCDA8]">
            {DEPLOY_LOG.filter((_, i) => clicked && t > 1500 + i * 1200).map((l) => <div key={l}>{l}</div>)}
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center">
          <motion.div data-r animate={{ opacity: live ? 1 : 0.35, scale: live ? 1 : 0.97 }} className="overflow-hidden rounded-xl border border-line bg-surface shadow-[0_24px_50px_-24px_rgba(30,38,34,.55)]">
            <div className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-2.5 py-1.5">
              <span className="h-2 w-2 rounded-full bg-[#E6A19A]" /><span className="h-2 w-2 rounded-full bg-[#E9C97A]" /><span className="h-2 w-2 rounded-full bg-[#9FCDA8]" />
              <div className="ml-1.5 flex min-w-0 flex-1 items-center gap-1 rounded-md bg-surface px-2 py-0.5 font-mono text-[10.5px]">
                <span className="text-accent">🔒</span><span className="truncate">{typed}</span>{live && !open && <span className="caret" />}
              </div>
            </div>
            <div className="h-[150px] bg-[#F3F7FB] p-3 text-ink">
              {open && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                  <div className="text-[10px] text-ink-3">Buenos Aires · {T('hoy', 'today')}</div>
                  <div className="flex items-end gap-2"><span className="font-mono text-[34px] font-bold leading-none">17°</span><span className="mb-1 text-[11px] text-ink-2">{T('lluvia a las 15 h', 'rain at 3 pm')}</span></div>
                  <div className="mt-2 rounded-lg bg-[#3D5CC4] px-2.5 py-1.5 text-[12px] font-semibold text-white">☂ {T('Sí, llevá paraguas', 'Yes, take an umbrella')}</div>
                  <div className="mt-2 flex gap-1">{[20, 30, 45, 70, 65, 40, 25].map((r, i) => <div key={i} className="flex-1 rounded-sm bg-[#3D5CC4]" style={{ height: 4 + r / 4, opacity: 0.3 + r / 100 }} />)}</div>
                </motion.div>
              )}
            </div>
          </motion.div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {PLACES.map(([es, en], i) => (
              <motion.span key={es} initial={false} animate={{ opacity: open && t > 8300 + i * 280 ? 1 : 0, y: open && t > 8300 + i * 280 ? 0 : 6 }} className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2">
                {T(es, en)} <span className="text-accent">✓</span>
              </motion.span>
            ))}
          </div>
          {open && <div className="mt-2 text-[11px] text-ink-3">{T('Pública, con HTTPS: cualquiera la abre con el link.', 'Public, with HTTPS: anyone opens it with the link.')}</div>}
        </div>
      </div>
      {!clicked && <Cursor x={150} y={70} />}
      {clicked && t < 1500 && <Cursor x={150} y={70} click />}
    </motion.div>
  )
}

/* 8 · Tably Analytics: the snippet goes in, real visits arrive, the app reaches level 2 (measured) */
const VISITS = [12, 18, 15, 26, 31, 28, 40, 46, 39, 58, 64, 71, 83, 96]
function SceneAnalytics({ t }: { t: number }) {
  const T = useT()
  const installed = t > 700
  const grow = ease((t - 1400) / 4200)
  const bars = VISITS.map((v, i) => v * ease(grow * VISITS.length - i))
  const total = Math.round(bars.reduce((a, b) => a + b, 0))
  const events = Math.round(312 * grow)
  const errors = t > 4600 ? 1 : 0
  const level = t > 6400
  const max = Math.max(...VISITS)
  const pages: [string, number][] = [['/', 412], ['/hoy', 268], ['/alertas', 131], ['/7-dias', 84]]
  const evs: [string, number][] = [['consulta_paraguas', 188], ['alerta_abierta', 74], ['ciudad_cambiada', 50]]
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1.35fr_1fr] gap-5">
        <div className="min-w-0">
          <Label>Tably Analytics · {T('app del clima', 'weather app')}</Label>
          <div data-r className={`mt-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-mono text-[10.5px] transition-colors ${installed ? 'border-accent/40 bg-accent-soft/60 text-ink-2' : 'border-dashed border-line text-ink-3'}`}>
            <span className="truncate">{'<script src="tablyteam.com/a.js" defer>'}</span>
            <span className="ml-auto shrink-0 font-sans text-[10.5px] font-semibold text-accent">{installed ? T('instalado ✓', 'installed ✓') : '…'}</span>
          </div>
          <div data-r className="mt-3 grid grid-cols-3 gap-2">
            {([[T('Visitas · 14 d', 'Visits · 14 d'), total, 'text-ink'], [T('Eventos', 'Events'), events, 'text-accent'], [T('Errores', 'Errors'), errors, errors ? 'text-danger' : 'text-ink-3']] as const).map(([k, v, c]) => (
              <div key={k} className="rounded-xl border border-line bg-surface px-3 py-2">
                <div className="text-[10px] uppercase tracking-widest text-ink-3">{k}</div>
                <div className={`font-mono text-[22px] font-bold leading-tight ${c}`}>{v.toLocaleString('es-AR')}</div>
              </div>
            ))}
          </div>
          <div data-r className="mt-3 rounded-xl border border-line bg-surface p-3">
            <div className="text-[10px] uppercase tracking-widest text-ink-3">{T('Visitas por día', 'Visits per day')}</div>
            <div className="mt-2 flex h-[120px] items-end gap-[3px]">
              {bars.map((v, i) => (
                <div key={i} className="flex-1 rounded-t-[3px] bg-[#0082FB]" style={{ height: `${(v / max) * 100}%`, opacity: 0.55 + 0.45 * (i / VISITS.length) }} />
              ))}
            </div>
          </div>
          <AnimatePresence>
            {errors > 0 && (
              <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="mt-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11.5px]">
                <span className="font-bold text-danger">!</span>
                <span className="min-w-0 flex-1 truncate">TypeError: hourly is undefined <span className="font-mono text-[10px] text-ink-3">lib/weather.ts:31</span></span>
                <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">{T('el equipo lo arregla', 'the team fixes it')}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          {([[T('Páginas más vistas', 'Top pages'), pages], [T('Eventos', 'Events'), evs]] as const).map(([title, rows]) => (
            <div data-r key={title} className="rounded-xl border border-line bg-surface p-3">
              <div className="text-[10px] uppercase tracking-widest text-ink-3">{title}</div>
              <div className="mt-1.5 space-y-1">
                {rows.map(([k, v]) => (
                  <div key={k} className="relative flex items-center justify-between overflow-hidden rounded px-1.5 py-0.5 text-[11.5px]">
                    <div className="absolute inset-y-0 left-0 bg-[#0082FB]/10" style={{ width: `${(v / rows[0][1]) * 100 * grow}%` }} />
                    <span className="relative truncate font-mono">{k}</span>
                    <span className="relative font-mono text-ink-2">{Math.round(v * grow)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <AnimatePresence>
            {level && (
              <motion.div initial={{ opacity: 0, y: 10, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="rounded-xl border px-3 py-2 text-[12px] shadow-md" style={{ borderColor: '#7c3aed55', background: '#7c3aed12' }}>
                <div className="font-bold" style={{ color: '#7c3aed' }}>🏆 {T('Nivel 2 · Medido', 'Level 2 · Measured')}</div>
                <div className="text-ink-2">{T('sabés cuánta gente entra, qué hace y qué se rompe', 'you know how many people come in, what they do and what breaks')}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

/* 9 · ads: Muse reads the app, 5 templates are recommended, the video is made in the app's colours and goes to Meta Ads */
const AD_TEMPLATES: [string, string][] = [['Problema → solución', 'Problem → solution'], ['Demo en el teléfono', 'Phone demo'], ['3 razones', '3 reasons'], ['Antes / después', 'Before / after'], ['Prueba social', 'Social proof']]
const AD_AGENTS: [string, string][] = [['Guion con el resumen', 'Script from the summary'], ['Plan de escenas', 'Scene plan'], ['Arma el video', 'Builds the video'], ['Mejora', 'Improves'], ['Aprueba o devuelve', 'Approves or sends back']]
const AD_LINES: [string, string][] = [['¿Salís sin saber si llueve?', 'Heading out not knowing if it rains?'], ['Te lo dice en 3 segundos', 'It tells you in 3 seconds'], ['Probalo gratis', 'Try it free']]
function SceneAds({ t }: { t: number }) {
  const T = useT()
  const summary = t > 600
  const picked = t > 2600 ? 1 : -1
  const render = ease((t - 3400) / 3600)
  const ready = t > 7200
  const line = Math.min(AD_LINES.length - 1, Math.floor(ease((t - 3400) / 4200) * AD_LINES.length))
  const palette = ['#3D5CC4', '#F3F7FB', '#1E2622', '#F2CC6A']
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1.4fr_1fr] gap-5">
        <div className="min-w-0">
          <Label>{T('Anuncios desde tu app', 'Ads from your app')}</Label>
          <motion.div data-r animate={{ opacity: summary ? 1 : 0.35 }} className="mt-2 rounded-xl border border-line bg-surface p-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-ink-2"><ProviderLogo provider="meta" size={14} /> {T('Muse miró la app y resumió', 'Muse looked at the app and summed up')}</div>
            <div className="mt-1 text-[12.5px] leading-snug">{T('Te dice en 3 segundos si llevás paraguas hoy, con alertas oficiales y pronóstico por horas.', 'Tells you in 3 seconds whether to take an umbrella today, with official alerts and an hourly forecast.')}</div>
            <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-ink-3">
              {T('colores de la app', 'app colours')}
              {palette.map((c) => <span key={c} className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ background: c }} />)}
              <span className="ml-1 font-mono">Inter</span>
            </div>
          </motion.div>
          <div data-r className="mt-3 text-[10px] uppercase tracking-widest text-ink-3">{T('5 plantillas recomendadas · de 20 que se renuevan cada mes', '5 recommended templates · of 20 renewed every month')}</div>
          <div className="mt-1.5 grid grid-cols-5 gap-1.5">
            {AD_TEMPLATES.map(([es, en], i) => (
              <div data-r key={es} className={`flex aspect-[9/14] flex-col justify-end rounded-lg border p-1.5 text-[9.5px] font-semibold leading-tight transition-all ${picked === i ? 'border-accent shadow-[0_0_0_3px_rgba(47,107,93,.2)]' : 'border-line'}`} style={{ background: `linear-gradient(160deg, ${palette[i % 2 ? 0 : 2]}, ${palette[i % 2 ? 2 : 0]})` }}>
                <span className="text-white/90">{T(es, en)}</span>
              </div>
            ))}
          </div>
          <div data-r className="mt-3 space-y-1">
            {AD_AGENTS.map(([a, a_en], i) => {
              const on = render > i / 5
              const doneA = render >= (i + 1) / 5 || ready
              return (
                <div key={a} className={`flex items-center gap-2 text-[11.5px] ${on ? 'text-ink' : 'text-ink-3'}`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${doneA ? 'bg-accent text-white' : on ? 'ring-2 ring-accent' : 'bg-surface-2'}`}>{doneA ? '✓' : ''}</span>
                  {T(a, a_en)}
                </div>
              )
            })}
          </div>
        </div>
        <div className="flex flex-col items-center justify-center">
          <div data-r className="relative overflow-hidden rounded-[18px] border-[5px] border-black shadow-xl" style={{ width: 170, height: 302, background: 'linear-gradient(170deg,#3D5CC4,#1E2622)' }}>
            <motion.div animate={{ scale: 1 + render * 0.08 }} className="absolute inset-x-4 top-16 rounded-xl bg-[#F3F7FB] p-2 text-ink shadow-lg">
              <div className="text-[9px] text-ink-3">Buenos Aires</div>
              <div className="font-mono text-[26px] font-bold leading-none">17°</div>
              <div className="mt-1 rounded-md bg-[#3D5CC4]/10 px-1.5 py-1 text-[9.5px] font-semibold text-[#3D5CC4]">☂ {T('Llevá paraguas', 'Take an umbrella')}</div>
            </motion.div>
            {render > 0 && (
              <motion.div key={line} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="absolute inset-x-3 bottom-12 text-center text-[15px] font-extrabold leading-tight text-white drop-shadow">
                {T(...AD_LINES[line])}
              </motion.div>
            )}
            <div className="absolute inset-x-3 bottom-3 h-1 overflow-hidden rounded-full bg-white/25"><div className="h-full bg-white" style={{ width: `${render * 100}%` }} /></div>
          </div>
          <div className="mt-2 font-mono text-[10px] text-ink-3">1080×1920 · 15 s · Remotion</div>
          <AnimatePresence>
            {ready && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-2 flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-[11.5px] font-semibold text-paper shadow-lg">
                <ProviderLogo provider="meta-ads" size={13} /> {T('Enviar a Meta Ads · campaña en pausa', 'Send to Meta Ads · paused campaign')}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

/* 10 · marketplace: the app is listed with its level and real visits, a buyer writes, the owner transfers it */
/* 10 · Meta Ads: the account connected, its numbers, and each finding with the button that does it. The figures are an example. */
function SceneMetaAds({ t }: { t: number }) {
  const T = useT()
  const connected = t > 900
  const n = ease((t - 1300) / 1500)
  const summary = t > 3000
  const found = [t > 4200, t > 5000, t > 5800]
  const paused = t > 8000
  const raised = t > 9400
  const kpis: [string, string][] = [[T('Invertido', 'Spent'), `$${Math.round(1240 * n).toLocaleString('en-US')}`], [T('Resultados', 'Results'), String(Math.round(86 * n))], [T('Costo por resultado', 'Cost per result'), `$${(14.4 * n).toFixed(1)}`]]
  const row = (show: boolean, good: boolean, title: string, detail: string, impact: string, action: string, done: boolean, doneText: string) => show && (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-xl border border-line bg-surface py-2 pl-3.5 pr-3">
      <span className={`absolute inset-y-0 left-0 w-1 ${good ? 'bg-[#2E9E6A]' : 'bg-[#C28A12]'}`} />
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-ink">{title}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${good ? 'bg-[#2E9E6A]/12 text-[#2E9E6A]' : 'bg-[#C28A12]/12 text-[#9A6B0A]'}`}>{impact}</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{detail}</p>
      {action && <div className="mt-1.5">{done ? <span className="text-[11px] font-semibold text-[#2E9E6A]">✓ {doneText}</span> : <span className="inline-block rounded-full bg-accent px-2.5 py-0.5 text-[10.5px] font-semibold text-white">{action}</span>}</div>}
    </motion.div>
  )
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1fr_1.15fr] gap-4">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <ProviderLogo provider="meta-ads" size={18} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">Meta Ads</span>
            {connected ? <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[11px] font-semibold text-[#2E9E6A]">✓ {T('Conectado', 'Connected')}</motion.span> : <span className="rounded-full bg-accent px-2.5 py-0.5 text-[10.5px] font-semibold text-white">{T('Conectar', 'Connect')}</span>}
          </div>
          {connected && (
            <div className="grid grid-cols-3 gap-1.5">
              {kpis.map(([k, v], i) => <div key={k} className={`rounded-lg border px-2 py-1.5 ${i === 2 ? 'border-accent/40 bg-accent-soft/50' : 'border-line bg-surface'}`}><div className="truncate text-[9.5px] text-ink-3">{k}</div><div className="font-mono text-[14px] font-semibold text-ink">{v}</div></div>)}
            </div>
          )}
          {summary && (
            <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg border-l-4 border-accent bg-accent-soft/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink">
              {T('El video vertical trae 8 de cada 10 clientes. La imagen de promo gastó $410 sin un solo lead: frenala y pasá ese presupuesto al video.', 'The vertical video brings 8 of every 10 customers. The promo image spent $410 without a single lead: stop it and move that budget to the video.')}
            </motion.p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {row(found[0], false, T('Frená «Promo imagen»', 'Stop «Promo image»'), T('Mucho gasto, cero leads en 30 días.', 'High spend, zero leads in 30 days.'), T('$410 sin leads', '$410, no leads'), T('Pausar anuncio', 'Pause ad'), paused, T('Pausado', 'Paused'))}
          {row(found[1], true, T('El video en Reels funciona', 'The video on Reels works'), T('El costo más bajo de la cuenta.', 'The lowest cost in the account.'), T('$6,1 por lead', '$6.1 per lead'), T('Subir presupuesto a $30 por día', 'Raise budget to $30 a day'), raised, T('Presupuesto: $30 por día', 'Budget: $30 a day'))}
          {row(found[2], false, T('Sacá Marketplace', 'Remove Marketplace'), T('Todos los leads vienen de Reels, Stories y Feed.', 'Every lead comes from Reels, Stories and Feed.'), T('$180 sin leads', '$180, no leads'), '', false, '')}
        </div>
      </div>
    </motion.div>
  )
}

function SceneMarket({ t }: { t: number }) {
  const T = useT()
  const listed = t > 1200
  const msg = t > 3600
  const transferring = t > 6000
  const sold = t > 7400
  const others = [
    { name: 'Turnos Peluquería', lvl: 4, visits: '3.910', price: 'USD 4.200' },
    { name: 'Lista de compras', lvl: 2, visits: '540', price: T('a convenir', 'negotiable') },
  ]
  const LV = ['#9aa39e', '#0082FB', '#7c3aed', '#d97706', '#059669']
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1.35fr_1fr] gap-5">
        <div className="min-w-0">
          <Label>Marketplace · {T('apps en venta', 'apps for sale')}</Label>
          <motion.div data-r animate={{ opacity: listed ? 1 : 0.4, y: listed ? 0 : 6 }} className="mt-2 rounded-2xl border border-accent bg-surface p-4 shadow-[0_18px_40px_-22px_rgba(30,38,34,.5)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[11px] font-bold" style={{ color: LV[3] }}>🏆 {T('Nivel 3 · Visible', 'Level 3 · Visible')}</div>
                <div className="serif mt-0.5 text-[22px] leading-tight">¿Llevo paraguas?</div>
                <div className="font-mono text-[11px] text-ink-3">paraguas.tablyteam.app ↗</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[18px] font-semibold">USD 1.500</div>
                {sold && <div className="mt-0.5 rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-white">{T('vendida', 'sold')}</div>}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              <span className="rounded-full border border-line px-2 py-0.5 font-mono text-ink-2">👁 1.284 {T('visitas', 'visits')} · 312 / 7d</span>
              <span className="rounded-full border border-line px-2 py-0.5 text-ink-2">PWA · Vite · Open-Meteo</span>
            </div>
            <p className="mt-2 text-[12.5px] leading-snug text-ink-2">{T('Responde en 3 s si llueve hoy. Alertas oficiales, pronóstico por horas y usuarios que vuelven todos los días.', 'Answers in 3 s whether it rains today. Official alerts, an hourly forecast and users who come back every day.')}</p>
          </motion.div>
          <div className="mt-3 space-y-1.5">
            {others.map((o) => (
              <div data-r key={o.name} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/50 px-3 py-2 text-[12px] text-ink-2">
                <span className="text-[10.5px] font-bold" style={{ color: LV[o.lvl] }}>N{o.lvl}</span>
                <span className="min-w-0 flex-1 truncate font-semibold text-ink">{o.name}</span>
                <span className="font-mono text-[10.5px]">👁 {o.visits}</span>
                <span className="font-mono text-[11px]">{o.price}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-2.5">
          <AnimatePresence>
            {msg && (
              <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="rounded-2xl rounded-tl-sm border border-line bg-surface p-3 text-[12px] shadow-md">
                <div className="text-[10px] uppercase tracking-widest text-ink-3">✉ {T('Mensaje de un comprador', 'Message from a buyer')}</div>
                <div className="mt-1 leading-snug">{T('Hola, me interesa la app del clima. ¿Hacemos la transferencia esta semana?', 'Hi, I’m interested in the weather app. Shall we do the transfer this week?')}</div>
                <div className="mt-1 text-[10.5px] text-ink-3">martina@… · {T('hace 2 min', '2 min ago')}</div>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {msg && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }} className="rounded-xl border border-line bg-surface p-3 text-[12px]">
                <div className="text-[10px] uppercase tracking-widest text-ink-3">{T('Desde el constructor', 'From the builder')}</div>
                <div className={`mt-2 flex items-center justify-center gap-2 rounded-lg px-3 py-2 font-semibold shadow-md transition-colors ${sold ? 'bg-ink text-paper' : 'bg-accent text-white'}`}>
                  {sold ? T('Transferida ✓ · código, dominio y datos', 'Transferred ✓ · code, domain and data') : transferring ? T('Transfiriendo…', 'Transferring…') : T('Transferir la app', 'Transfer the app')}
                </div>
                {transferring && <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/5"><div className="h-full bg-accent" style={{ width: `${ease((t - 6000) / 1400) * 100}%` }} /></div>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {!sold && <Cursor x={transferring ? 470 : msg ? 470 : 120} y={transferring ? 300 : msg ? 300 : 120} click={transferring && t < 6300} />}
    </motion.div>
  )
}

/* 11 · audit of an existing project: upload, the roles review from their areas, findings and a readiness score */
const AUDIT_FINDINGS: { role: string; sev: 'bloqueante' | 'mejora'; text: string; text_en: string; where: string }[] = [
  { role: 'qa', sev: 'bloqueante', text: 'El checkout no valida el stock antes de cobrar', text_en: 'Checkout does not validate stock before charging', where: 'api/checkout.ts:48' },
  { role: 'eng', sev: 'bloqueante', text: 'Secretos en el repo: .env commiteado', text_en: 'Secrets in the repo: .env committed', where: '.env' },
  { role: 'design', sev: 'mejora', text: 'Estados vacíos sin diseño en el carrito', text_en: 'No empty states designed for the cart', where: 'components/Cart.tsx' },
  { role: 'product', sev: 'mejora', text: 'Falta el flujo de devolución del brief', text_en: 'The refund flow from the brief is missing', where: 'README.md' },
  { role: 'cto', sev: 'mejora', text: 'Sin tests de integración en pagos', text_en: 'No integration tests on payments', where: 'tests/' },
]

function SceneAudit({ t }: { t: number }) {
  const T = useT()
  const uploaded = t > 900
  const reviewing = t > 1800
  const findings = AUDIT_FINDINGS.filter((_, i) => t > 3200 + i * 900)
  const scored = t > 8200
  const reviewers = TEAM.filter((m) => ['cto', 'eng', 'product', 'design', 'qa'].includes(m.id))
  const num = useRef<HTMLSpanElement>(null)
  const blockers = useRef<HTMLSpanElement>(null)
  const improvements = useRef<HTMLSpanElement>(null)
  // the readiness and the counters tick up when the report lands
  useGSAP(() => {
    if (!scored) return
    if (num.current) countTo(num.current, 68, '', 1.3)
    if (blockers.current) countTo(blockers.current, 2, '', 0.8)
    if (improvements.current) countTo(improvements.current, 3, '', 0.9)
  }, { dependencies: [scored] })
  const perRole = [['qa', 55], ['eng', 60], ['design', 72], ['product', 70], ['cto', 80]] as const
  return (
    <motion.div {...sceneProps}>
      <div className="grid h-full grid-cols-[1.2fr_1fr] gap-5">
        <div className="min-w-0">
          <Label>{T('Auditar un proyecto', 'Audit a project')}</Label>
          <motion.div data-r animate={{ borderColor: uploaded ? '#2F6B5D' : undefined }} className={`mt-2 flex items-center gap-3 rounded-xl border px-3 py-2.5 ${uploaded ? 'bg-accent-soft/60' : 'border-dashed border-line'}`}>
            <span className="text-[20px]">{uploaded ? '📦' : '⬆️'}</span>
            <div className="min-w-0 text-[12.5px]">
              <div className="font-semibold">{uploaded ? 'mi-tienda.zip' : T('Arrastrá tu proyecto (zip o carpeta)', 'Drop your project (zip or folder)')}</div>
              <div className="text-ink-3">{uploaded ? `142 ${T('archivos', 'files')} · Next.js · Stripe · ${T('subido', 'uploaded')} ✓` : T('código, README, lo que tengas', 'code, README, whatever you have')}</div>
            </div>
          </motion.div>
          <div data-r className="mt-3 flex flex-wrap gap-1.5">
            {reviewers.map((m, i) => {
              const on = reviewing && t > 1800 + i * 350
              const done = findings.some((f) => f.role === m.id) || scored
              return (
                <span key={m.id} className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors ${on ? 'bg-surface shadow-sm' : 'border-line bg-surface-2/60 text-ink-3'}`} style={{ borderColor: on ? m.color : undefined }}>
                  <ProviderLogo provider={m.provider} size={13} /> {T(m.name, m.name_en)} {done ? <span className="text-accent">✓</span> : on ? <span className="caret" /> : null}
                </span>
              )
            })}
          </div>
          <div className="mt-3 space-y-1.5">
            <AnimatePresence>
              {findings.map((f) => {
                const m = MEMBER[f.role]
                return (
                  <motion.div key={f.text} initial={{ opacity: 0, x: -14, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 26 }} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-[0_6px_16px_-12px_rgba(30,38,34,.4)]">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${f.sev === 'bloqueante' ? 'bg-danger/15 text-danger' : 'bg-gold/15 text-gold'}`}>{f.sev === 'bloqueante' ? '!' : '↑'}</span>
                    <span className="min-w-0 flex-1 truncate">{T(f.text, f.text_en)} <span className="font-mono text-[10.5px] text-ink-3">{f.where}</span></span>
                    <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-semibold" style={{ color: m.color }}><ProviderLogo provider={m.provider} size={11} />{T(m.name, m.name_en)}</span>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center">
          <div data-r className="relative h-[150px] w-[150px]">
            <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90 overflow-visible">
              <defs>
                <linearGradient id="gauge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F2CC6A" /><stop offset="1" stopColor="#9C7622" /></linearGradient>
                <filter id="gauge-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
              </defs>
              <circle cx="60" cy="60" r="50" fill="none" stroke="#E6EAE7" strokeWidth="11" />
              <motion.circle cx="60" cy="60" r="50" fill="none" stroke="url(#gauge)" strokeWidth="11" strokeLinecap="round" strokeDasharray={2 * Math.PI * 50} initial={{ strokeDashoffset: 2 * Math.PI * 50 }} animate={{ strokeDashoffset: 2 * Math.PI * 50 * (1 - (scored ? 68 : 0) / 100) }} transition={{ duration: 1.3, ease: [0.22, 1, 0.36, 1] }} filter="url(#gauge-glow)" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="font-mono text-[34px] font-bold leading-none text-ink"><span ref={num}>{scored ? '' : '—'}</span><span className="text-[16px]">%</span></div>
            </div>
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.25em] text-ink-3">{T('listo para producción', 'production-ready')}</div>
          <AnimatePresence>
            {scored && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-3 w-full rounded-xl border border-line bg-surface p-3 text-[12px] shadow-[0_18px_40px_-20px_rgba(30,38,34,.4)]">
                <div className="text-[10px] uppercase tracking-widest text-ink-3">{T('Informe de auditoría', 'Audit report')}</div>
                <div className="mt-1 flex items-center gap-3 font-semibold"><span><span ref={blockers} className="font-mono text-danger">0</span> {T('bloqueantes', 'blockers')}</span><span><span ref={improvements} className="font-mono text-gold">0</span> {T('mejoras', 'improvements')}</span></div>
                <div className="mt-2 space-y-1">
                  {perRole.map(([id, v], i) => (
                    <div key={id} className="flex items-center gap-2 text-[10.5px]">
                      <span className="w-14 truncate text-ink-3">{T(MEMBER[id].name, MEMBER[id].name_en)}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/5"><motion.div className="h-full rounded-full" style={{ background: MEMBER[id].color }} initial={{ width: 0 }} animate={{ width: `${v}%` }} transition={{ delay: 0.2 + i * 0.1, duration: 0.8, ease: 'easeOut' }} /></div>
                      <span className="w-7 text-right font-mono text-ink-2">{v}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-md">▶ {T('Que el equipo lo corrija', 'Have the team fix it')}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

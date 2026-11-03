import { Compass } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { toast } from './Toast'

type Lane = 'direct' | 'team'
type View = ReturnType<typeof useArena.getState>['view']
type Step = { sel: string; title: [string, string]; text: [string, string] }

const useTour = create<{ steps: Step[] | null; i: number; view: View | null; userId: string }>(() => ({ steps: null, i: 0, view: null, userId: '' }))
const seenKey = (view: View) => `tably.tour.${useTour.getState().userId || 'anon'}.${view}`
const seen = (view: View) => { try { return !!localStorage.getItem(seenKey(view)) } catch { return true } }

/** Each screen explains only itself. */
function screenSteps(view: View, lane: Lane | null): Step[] {
  switch (view) {
    case 'setup':
      if (!lane) return []
      return [
        ...(lane === 'team' ? [{ sel: 'experiments', title: ['Empezá de un ejemplo', 'Start from an example'], text: ['Son proyectos armados. Tocá uno y se completa el formulario con la idea y el equipo; después cambiás lo que quieras.', 'Ready-made projects. Tap one and the form fills in with the idea and the team; then change whatever you want.'] } as Step] : []),
        { sel: 'idea', title: ['Contá tu idea', 'Tell your idea'], text: ['Escribí con tus palabras qué querés construir: para quién es y qué tiene que hacer. No hace falta saber programar.', 'Write in your own words what you want to build: who it is for and what it must do. No coding needed.'] },
        { sel: 'attach', title: ['Sumá material', 'Add material'], text: ['Opcional: adjuntá documentos, una carpeta o un proyecto que ya tengas, para que el equipo entienda mejor el pedido.', 'Optional: attach documents, a folder or an existing project so the team understands the request better.'] },
        { sel: 'prompt', title: ['Mejorá el pedido con IA', 'Improve the request with AI'], text: ['Una IA lee todo, te hace las preguntas que faltan y convierte tu texto en un brief completo. Se habilita cuando escribiste tu idea.', 'An AI reads everything, asks what is missing and turns your text into a full brief. It turns on once you have written your idea.'] },
        ...(lane === 'team'
          ? [{ sel: 'agents', title: ['Armá el equipo', 'Build the team'], text: ['Cada tarjeta es un rol: elegí qué IA lo ocupa y cómo piensa. Sumá o sacá roles, o usá el equipo que tengas guardado.', 'Each card is a role: choose which AI takes it and how it thinks. Add or remove roles, or use your saved team.'] } as Step]
          : [{ sel: 'builder', title: ['Elegí quién construye', 'Choose who builds'], text: ['Un agente con tu suscripción, si lo tenés instalado, o un modelo con tu API key.', 'An agent on your subscription, if you have it installed, or a model with your API key.'] } as Step,
             { sel: 'direct-team', title: ['Tu equipo revisa', 'Your team reviews'], text: ['No debate antes de construir: son los roles que revisan la app cuando está lista. Tocá uno para editarlo o sumá otros.', 'It does not debate before building: these are the roles that review the app once it is ready. Tap one to edit it or add others.'] } as Step]),
        { sel: 'start', title: lane === 'team' ? ['Largá el debate', 'Start the debate'] : ['Largá la construcción', 'Start building'], text: lane === 'team' ? ['Con este botón el equipo debate tu idea, decide producto y alcance, y después construye. Vos aprobás cada paso.', 'This button makes the team debate your idea, decide product and scope, and then build. You approve every step.'] : ['Con este botón tu pedido se convierte en brief y el constructor arranca enseguida.', 'This button turns your request into a brief and the builder starts right away.'] },
        { sel: 'projects', title: ['Tus proyectos', 'Your projects'], text: ['Acá queda todo lo que construís: abrí cada proyecto, seguí iterando, correlo y publicalo online.', 'Everything you build stays here: open each project, keep iterating, run it and publish it online.'] },
      ]
    case 'audit':
      return [
        { sel: 'audit', title: ['Subí tu proyecto', 'Upload your project'], text: ['Arrastrá la carpeta o un .zip de un proyecto que ya tengas. Muse Team descarta lo que no hace falta antes de subirlo.', 'Drop the folder or a .zip of a project you already have. Muse Team leaves out what is not needed before uploading.'] },
        { sel: 'audit-team', title: ['Elegí quién audita', 'Choose who audits'], text: ['Cada rol revisa el proyecto desde su mirada y te dice qué está mal y qué mejorar.', 'Each role reviews the project from its own angle and tells you what is wrong and what to improve.'] },
      ]
    case 'agents':
      return [
        { sel: 'engines', title: ['Elegí el agente', 'Pick the agent'], text: ['Cambiá entre los agentes de código que usás para ver las conversaciones de cada uno.', 'Switch between the coding agents you use to see each one’s conversations.'] },
        { sel: 'sessions', title: ['Tus conversaciones', 'Your conversations'], text: ['Están agrupadas por proyecto. Buscá la que necesites y tocala para abrirla.', 'They are grouped by project. Find the one you need and tap it to open it.'] },
        { sel: 'conversation', title: ['Seguí desde donde quedó', 'Pick up where it stopped'], text: ['Acá ves la conversación completa y le podés seguir escribiendo al agente.', 'Here you see the whole conversation and can keep writing to the agent.'] },
      ]
    case 'analytics':
      return [
        { sel: 'analytics', title: ['Conectá un sitio', 'Connect a site'], text: ['Las apps que publicás con Muse Team ya miden solas. Para una que vive afuera, este botón instala las analíticas.', 'Apps you publish with Muse Team already measure on their own. For one that lives elsewhere, this button installs analytics.'] },
        { sel: 'apps', title: ['Tus números', 'Your numbers'], text: ['Visitas, gente en vivo, eventos y errores de cada app. Tocá «Ver detalle» para ver quién entra y qué toca.', 'Visits, live people, events and errors for each app. Tap «See details» to see who comes in and what they tap.'] },
      ]
    case 'studio':
      return [
        { sel: 'studio', title: ['Contá qué anunciás', 'Say what you advertise'], text: ['Qué querés anunciar, el link de destino y el objetivo. Con esto el equipo decide el mensaje.', 'What you want to advertise, the destination link and the goal. The team decides the message from this.'] },
        { sel: 'studio-files', title: ['Subí tu material', 'Upload your material'], text: ['Arrastrá videos e imágenes. El equipo elige los mejores momentos y arma el video.', 'Drop videos and images. The team picks the best moments and edits the video.'] },
        { sel: 'studio-record', title: ['O grabá tu app', 'Or record your app'], text: ['Pegá el link y Muse Team la abre como un celular, la recorre y suma la grabación al anuncio.', 'Paste the link and Muse Team opens it like a phone, walks through it and adds the recording to the ad.'] },
        { sel: 'studio-twin', title: ['¿No tenés material?', 'No material?'], text: ['Tu gemelo digital habla a cámara con tu cara y tu voz, con un guion escrito por la IA.', 'Your digital twin talks to camera with your face and voice, from a script written by the AI.'] },
        { sel: 'studio-ads', title: ['Tus anuncios', 'Your ads'], text: ['Acá quedan los que hiciste, listos en vertical y cuadrado.', 'The ones you made stay here, ready in vertical and square.'] },
      ]
    case 'metaads':
      return [
        { sel: 'metaads', title: ['Conectá tu cuenta', 'Connect your account'], text: ['Elegí la cuenta publicitaria y tocá analizar. Muse Team solo lee tus números y crea anuncios en pausa.', 'Pick the ad account and tap analyse. Muse Team only reads your numbers and creates paused ads.'] },
        { sel: 'diagnosis', title: ['Tu diagnóstico', 'Your diagnosis'], text: ['Los números importantes, qué funciona y qué cambiar. Cada punto trae el botón para hacerlo: pausar, eliminar o mover presupuesto.', 'The numbers that matter, what works and what to change. Each point has the button to do it: pause, delete or move budget.'] },
        { sel: 'newads', title: ['Tus anuncios nuevos', 'Your new ads'], text: ['La IA arma un anuncio por cada video de «Crear anuncio». Revisá el texto y publicalo en pausa.', 'The AI builds an ad for each «Create ad» video. Check the text and publish it paused.'] },
      ]
    case 'adtier':
      return [
        { sel: 'adtier', title: ['Elegí cómo mirar', 'Choose how to browse'], text: ['«Para vos» trae lo que le sirve a tu negocio. En las otras pestañas ves el ranking, los videos y las plantillas.', '«For you» shows what fits your business. The other tabs have the ranking, the videos and the templates.'] },
        { sel: 'profile', title: ['El perfil de tu negocio', 'Your business profile'], text: ['Con esto Muse Team busca anuncios de tu rubro. Si algo no está bien, corregilo.', 'Muse Team uses this to find ads in your sector. If something is off, correct it.'] },
        { sel: 'reels', title: ['5 reels para hacer', '5 reels to make'], text: ['Pegá cuentas que te gusten o subí reels de otras marcas, y te escribimos 5 reels para tu negocio.', 'Paste accounts you like or upload reels from other brands, and we write 5 reels for your business.'] },
      ]
    case 'market':
      return [
        { sel: 'market', title: ['Los niveles', 'The levels'], text: ['Cada app sube de nivel a medida que crece: online, medida, visible y monetizada.', 'Each app levels up as it grows: live, measured, visible and monetised.'] },
        { sel: 'market-list', title: ['Las apps en venta', 'Apps for sale'], text: ['Cuando una app llega al nivel 1, puede aparecer acá para venderse.', 'Once an app reaches level 1, it can show up here for sale.'] },
      ]
    case 'team':
      return [
        { sel: 'team', title: ['Tu equipo por partes', 'Your team, part by part'], text: ['Empleados, lo que hay para revisar, su memoria y su puntaje.', 'Employees, what is up for review, their memory and their score.'] },
        { sel: 'team-content', title: ['Editá y aprobá', 'Edit and approve'], text: ['Cambiá el prompt y el conocimiento de cada rol. Lo que aprenden entra a su memoria solo con tu OK.', 'Change each role’s prompt and knowledge. What they learn enters their memory only with your OK.'] },
      ]
    case 'settings':
      return [
        { sel: 'subscription', title: ['Construí con Muse Code', 'Build with Muse Code'], text: ['Muse Code es el agente de Meta que escribe tu app. Se instala una vez y la app lo detecta sola.', 'Muse Code is the Meta agent that writes your app. Install it once and the app detects it on its own.'] },
        { sel: 'keys', title: ['Tu key de Meta', 'Your Meta key'], text: ['Conectá Muse con tu key de Meta. Hasta que la cargues, Muse Team trabaja en modo simulado, sin un modelo real.', 'Connect Muse with your Meta key. Until you add it, Muse Team works in simulated mode, without a real model.'] },
        { sel: 'connections', title: ['Tus cuentas', 'Your accounts'], text: ['Conectá servicios como Google Calendar: tus apps los leen a través de Muse Team.', 'Connect services like Google Calendar: your apps read them through Muse Team.'] },
      ]
    default:
      return []
  }
}

const storedLane = (): Lane | null => {
  try { const l = localStorage.getItem('tably.lane'); return l === 'direct' || l === 'team' ? l : null } catch { return null }
}

let run = 0
/** Waits for the screen to load, keeps the steps it really has (a diagnosis only exists after analysing, say) and starts. */
async function startScreen(view: View, lane: Lane | null, announce = false) {
  const all = screenSteps(view, lane)
  const mine = ++run
  if (!all.length) { if (announce) toast.info(tr('Esta pantalla no tiene recorrido', 'This screen has no tour')); return }
  const has = (s: Step) => !!measure(document.querySelector(`[data-tour="${s.sel}"]`)) || (() => {  // present and with a size (an empty list has none); it may be off screen
    const r = document.querySelector(`[data-tour="${s.sel}"]`)?.getBoundingClientRect()
    return !!r && r.width > 1 && r.height > 1
  })()
  const started = performance.now()
  const loading = () => !!document.querySelector('[data-loader]')
  while (performance.now() - started < 8000 && (loading() || !all.some(has))) await new Promise((r) => setTimeout(r, 150))
  await new Promise((r) => setTimeout(r, 500))  // what loads with the first one
  if (mine !== run || useArena.getState().view !== view) return
  const steps = all.filter(has)
  if (!steps.length) return
  try { localStorage.setItem(seenKey(view), '1') } catch { /* private mode */ }
  useTour.setState({ steps, i: 0, view })
}

/** A way in was chosen (Setup): the first time, the walk of this screen starts. */
export function offerTour(lane: Lane) {
  if (!seen('setup')) void startScreen('setup', lane)
}

/** «Ver el recorrido»: the walk of the screen you are on. */
export function replayTour() {
  const view = useArena.getState().view
  if (view === 'setup' && !storedLane()) {
    document.getElementById('new-project')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    toast.info(tr('Elegí un modo y te muestro esta pantalla', 'Pick a mode and I will show you this screen'))
    try { localStorage.removeItem(seenKey('setup')) } catch { /* private mode */ }
    return
  }
  void startScreen(view, storedLane(), true)
}

type Box = { x: number; y: number; w: number; h: number }
const PAD = 8
const measure = (el: Element | null): Box | null => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  const x = Math.max(4, r.left - PAD), y = Math.max(4, r.top - PAD)
  const w = Math.min(innerWidth - 4, r.right + PAD) - x, h = Math.min(innerHeight - 4, r.bottom + PAD) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}
const same = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1)

/** The walk through one screen: it dims the rest, marks each part and explains it. */
export default function ProductTour({ userId }: { userId: string }) {
  const T = useT()
  const { steps, i } = useTour()
  const view = useArena((s) => s.view)
  const on = !!steps
  const step = steps?.[Math.min(i, steps.length - 1)]
  const [main, setMain] = useState<Box | null>(null)
  const [ready, setReady] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  const close = useCallback(() => useTour.setState({ steps: null, i: 0 }), [])
  const go = useCallback((d: number) => {
    const { i: cur, steps: all } = useTour.getState()
    const next = cur + d
    if (next < 0 || !all) return
    if (next >= all.length) return close()
    useTour.setState({ i: next })
  }, [close])

  // the first time on each screen, its own walk; leaving the screen ends it
  useEffect(() => {
    useTour.setState({ userId })
    run++
    if (useTour.getState().view !== view) close()
    if (userId && !seen(view)) void startScreen(view, storedLane())
  }, [view, userId, close])

  // find the part this step points at, bring it into view and keep following it
  useEffect(() => {
    if (!step) return
    setReady(false); setMain(null)
    let scrolled = false
    const tick = () => {
      const el = document.querySelector(`[data-tour="${step.sel}"]`)
      const size = el?.getBoundingClientRect()
      if (el && size && size.width > 1 && !scrolled) {  // it may be far below the fold: being off screen is no reason to skip it
        scrolled = true
        el.scrollIntoView({ behavior: 'auto', block: size.height > innerHeight * 0.7 ? 'start' : 'center' })
      }
      const box = measure(el)
      setMain((p) => (same(p, box) ? p : box))
      if (box) setReady(true)
    }
    tick()
    const timer = window.setInterval(tick, 40)
    const fallback = window.setTimeout(() => setReady(true), 1500)  // if the part went away, the card still shows so nobody gets stuck
    return () => { window.clearInterval(timer); window.clearTimeout(fallback) }
  }, [step])

  // the card goes next to what it explains, always inside the screen
  useLayoutEffect(() => {
    if (!on || !card.current) return
    const cw = card.current.offsetWidth, ch = card.current.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 14
    const clampX = (x: number) => Math.max(12, Math.min(vw - cw - 12, x)), clampY = (y: number) => Math.max(12, Math.min(vh - ch - 12, y))
    const r = main
    let left = (vw - cw) / 2, top = (vh - ch) / 2
    if (r) {
      if (r.y + r.h + gap + ch < vh) { top = r.y + r.h + gap; left = clampX(r.x) }
      else if (r.y - gap - ch > 0) { top = r.y - gap - ch; left = clampX(r.x) }
      else if (r.x + r.w + gap + cw < vw) { left = r.x + r.w + gap; top = clampY(r.y) }
      else if (r.x - gap - cw > 0) { left = r.x - gap - cw; top = clampY(r.y) }
      else { left = clampX(r.x + r.w - cw - gap); top = clampY(r.y + r.h - ch - gap) }
    }
    setPos((p) => (Math.abs(p.left - left) < 1 && Math.abs(p.top - top) < 1 ? p : { left, top }))
  }, [on, i, main, ready])

  useEffect(() => {
    if (!on) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [on, go, close])

  if (!steps || !step) return null
  const holes = main ? [main] : []
  const last = i >= steps.length - 1
  return (
    <div className="fixed inset-0 z-[400]" role="dialog" aria-modal="true" aria-label={T(...step.title)}>
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs><mask id="tour-holes"><rect width="100%" height="100%" fill="white" />{holes.map((b, k) => <rect key={k} x={b.x} y={b.y} width={b.w} height={b.h} rx="14" fill="black" />)}</mask></defs>
        <rect width="100%" height="100%" fill="rgba(8,10,20,.66)" mask="url(#tour-holes)" />
      </svg>
      {holes.map((b, k) => <span key={k} className="tour-ring pointer-events-none absolute rounded-[14px]" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />)}
      <div ref={card} style={{ left: pos.left, top: pos.top, visibility: ready ? 'visible' : 'hidden' }} className="absolute w-[min(380px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,.6)] transition-[left,top] duration-300">
        <div className="flex items-center justify-between gap-3 text-[12px] font-semibold text-accent">
          <span>{T(`Paso ${i + 1} de ${steps.length}`, `Step ${i + 1} of ${steps.length}`)}</span>
          {!last && <button type="button" onClick={close} className="font-medium text-ink-3 transition hover:text-ink">{T('Saltear', 'Skip')}</button>}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${((i + 1) / steps.length) * 100}%` }} /></div>
        <h3 className="mt-3 text-[18px] font-bold leading-tight text-ink">{T(...step.title)}</h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{T(...step.text)}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          {i > 0 && <button type="button" onClick={() => go(-1)} className="h-9 rounded-full border border-line bg-surface px-4 text-[13px] font-medium text-ink-2 transition hover:border-accent hover:text-accent">{T('Anterior', 'Back')}</button>}
          <button type="button" autoFocus onClick={() => go(1)} className="h-9 rounded-full bg-accent px-5 text-[13px] font-semibold text-white transition hover:brightness-110">{last ? T('Listo', 'Done') : T('Siguiente', 'Next')}</button>
        </div>
      </div>
    </div>
  )
}

/** The way back to the walk, at the foot of the side bar. */
export function TourButton() {
  const T = useT()
  return (
    <button type="button" onClick={replayTour} title={T('Ver el recorrido de esta pantalla', 'Take the tour of this screen')} className="flex h-9 items-center gap-3 rounded-xl px-3 text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-ink md:justify-center lg:justify-start">
      <Compass size={17} className="shrink-0" /><span className="hidden truncate lg:inline">{T('Ver el recorrido', 'Take the tour')}</span>
    </button>
  )
}

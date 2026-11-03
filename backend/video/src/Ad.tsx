import type { ReactNode } from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame, type CalculateMetadataFunction } from 'remotion'
import { linearTiming, TransitionSeries, type TransitionPresentation } from '@remotion/transitions'
import { none } from '@remotion/transitions/none'
import { wipe } from '@remotion/transitions/wipe'
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight'
import { loadFont as loadFraunces } from '@remotion/google-fonts/Fraunces'
import { loadFont as loadNunito } from '@remotion/google-fonts/Nunito'
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { Background, Camera, Finish, themed, whip, zoomBlur, type BgKind, type Palette, type TextFx, type Theme } from './fx'
import { BeforeAfter, Chat, Cta, Hook, Lines, Marquee, Mark, Notes, Notifs, Points, Pov, Problem, Question, Reasons, ScreenScene, Search, Split, Stat, Steps, Zoom, type Ctx, type Labels } from './scenes'

/**
 * The ad: a template (backend/video/src/templates.json) is a list of scenes and a style; the script the team writes from
 * the app's summary fills them. Scenes whose material is missing (no screens, no real figure in the brief…) are left out,
 * so a template never shows filler. Two formats: vertical 9:16 (Reels, Stories) and square 1:1 (feed).
 */
export type FontKey = 'grotesk' | 'serif' | 'rounded'
export type Screen = { src: string; caption: string; kind: 'phone' | 'desktop'; ratio: number; bg?: string }
export type Style = { theme: Theme; fx: TextFx; transition: 'slide' | 'fade' | 'cut' | 'wipe'; pace: number; bg: BgKind; font?: FontKey }
export type TemplateSpec = { id: string; scenes: string[]; style: Style }
export type AdProps = {
  format: 'vertical' | 'square'
  name: string
  url: string
  palette: Palette
  font: FontKey
  template: TemplateSpec
  labels: Labels
  hook: string
  emphasis: string
  sub: string
  points: string[]
  screens: Screen[]
  cta: string
  ctaSub: string
  lines?: string[]
  chat?: { me: boolean; text: string }[]
  notesTitle?: string
  notes?: string[]
  before?: string[]
  after?: string[]
  stat?: { value: string; label: string } | null
  query?: string
  notifs?: { title: string; body: string }[]
  pov?: string
  problem?: string
  steps?: string[]
  question?: string
  answer?: string
  marquee?: string[]
}

export const FPS = 30
type Beat = { kind: string; d: number; i?: number }

/** The scenes this ad really has, in order, with their length in frames. */
export function plan(p: AdProps): Beat[] {
  const pace = p.template.style.pace || 1
  const has = (a?: unknown[], n = 1) => Array.isArray(a) && a.length >= n
  const used = new Set<number>()
  const out: Beat[] = []
  const add = (kind: string, d: number, i?: number) => { out.push({ kind, d: Math.round(d * pace), i }) }
  const free = () => p.screens.findIndex((_, k) => !used.has(k))
  const screen = (i: number) => {
    const j = p.screens[i] && !used.has(i) ? i : free()
    if (j >= 0) { used.add(j); add('screen', 108, j) }
  }
  for (const s of p.template.scenes) {
    if (s === 'hook' && p.hook) add('hook', 78)
    else if (s === 'points' && has(p.points)) add('points', 96)
    else if (s === 'reasons' && has(p.points, 2)) add('reasons', 50 * Math.min(3, p.points.length))
    else if (s.startsWith('screen:')) screen(Number(s.split(':')[1]) || 0)
    else if (s === 'screens') p.screens.forEach((_, i) => screen(i))
    else if (s === 'lines' && has(p.lines, 2)) add('lines', 34 * p.lines!.length + 20)
    else if (s === 'chat' && has(p.chat, 2)) add('chat', 26 * Math.min(5, p.chat!.length) + 50)
    else if (s === 'notes' && has(p.notes, 2)) add('notes', 22 * Math.min(5, p.notes!.length) + 66)
    else if (s === 'beforeAfter' && has(p.before) && has(p.after)) add('beforeAfter', 126)
    else if (s === 'stat' && p.stat?.value) add('stat', 84)
    else if (s === 'search' && p.query) add('search', 64 + p.query.length * 1.6)
    else if (s === 'notifs' && has(p.notifs)) add('notifs', 24 * Math.min(3, p.notifs!.length) + 66)
    else if (s === 'pov' && p.pov) { const j = free(); if (j >= 0) used.add(j); add('pov', 120, j >= 0 ? j : undefined) }
    else if (s === 'problem' && p.problem) add('problem', 96)
    else if (s === 'steps' && has(p.steps, 2)) add('steps', 26 * Math.min(4, p.steps!.length) + 66)
    else if (s === 'question' && p.question && p.answer) add('question', 114)
    else if (s === 'marquee' && has(p.marquee, 2)) add('marquee', 96)
    else if (s === 'split' && p.screens.length && has(p.lines ?? p.points, 2)) { used.add(0); add('split', 40 * Math.min(4, (p.lines ?? p.points).length) + 70, 0) }
    else if (s === 'zoom') { const j = p.screens.findIndex((x, k) => x.kind === 'phone' && !used.has(k)); if (j >= 0) { used.add(j); add('zoom', 126, j) } }
  }
  if (!out.length) add('hook', 78)
  add('cta', 92)
  return out
}

const tlen = (p: AdProps) => (p.template.style.transition === 'cut' ? 1 : 14)
export const durationOf = (p: AdProps) => { const b = plan(p); return b.reduce((s, x) => s + x.d, 0) - (b.length - 1) * tlen(p) }

export const adMetadata: CalculateMetadataFunction<AdProps> = ({ props }) => ({
  durationInFrames: durationOf(props),
  width: 1080,
  height: props.format === 'square' ? 1080 : 1920,
  fps: FPS,
})

const fonts: Record<FontKey, () => { display: string; body: string }> = {
  grotesk: () => ({ display: loadInterTight('normal', { weights: ['600', '800', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
  serif: () => ({ display: loadFraunces('normal', { weights: ['600', '800', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
  rounded: () => ({ display: loadNunito('normal', { weights: ['700', '800', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadNunito('normal', { weights: ['400', '600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
}
const loaded: Partial<Record<FontKey, { display: string; body: string }>> = {}
const fontsFor = (f: FontKey) => (loaded[f] ??= (fonts[f] ?? fonts.grotesk)())

function scene(b: Beat, p: AdProps, c: Ctx): ReactNode {
  const shot = b.i !== undefined ? p.screens[b.i] : undefined
  switch (b.kind) {
    case 'hook': return <Hook c={c} text={p.hook} emphasis={p.emphasis} sub={p.sub} />
    case 'points': return <Points c={c} items={p.points} />
    case 'reasons': return <Reasons c={c} items={p.points.slice(0, 3)} d={b.d} />
    case 'screen': return shot && <ScreenScene c={c} shot={shot} kind={shot.kind} caption={shot.caption} d={b.d} />
    case 'lines': return <Lines c={c} lines={p.lines!} d={b.d} />
    case 'chat': return <Chat c={c} msgs={p.chat!} />
    case 'notes': return <Notes c={c} title={p.notesTitle || p.name} items={p.notes!} />
    case 'beforeAfter': return <BeforeAfter c={c} before={p.before!} after={p.after!} />
    case 'stat': return <Stat c={c} value={p.stat!.value} label={p.stat!.label} />
    case 'search': return <Search c={c} query={p.query!} sub={p.sub} />
    case 'notifs': return <Notifs c={c} items={p.notifs!} />
    case 'pov': return <Pov c={c} text={p.pov!} shot={shot} d={b.d} />
    case 'problem': return <Problem c={c} text={p.problem!} sub={p.sub} />
    case 'steps': return <Steps c={c} items={p.steps!} />
    case 'question': return <Question c={c} question={p.question!} answer={p.answer!} d={b.d} />
    case 'marquee': return <Marquee c={c} words={p.marquee!} />
    case 'split': return shot && <Split c={c} shot={shot} lines={(p.lines ?? p.points).slice(0, 4)} d={b.d} />
    case 'zoom': return shot && <Zoom c={c} shot={shot} caption={shot.caption} d={b.d} />
    default: return <Cta c={c} cta={p.cta} sub={p.ctaSub} />
  }
}

/** The brand, small and always there (Meta's guidance: show it early), except where a scene shows it big. */
function Brand({ c, hidden }: { c: Ctx; hidden: [number, number][] }) {
  const frame = useCurrentFrame()
  let o = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' })
  for (const [a, b] of hidden) o = Math.min(o, interpolate(frame, [a - 8, a, b, b + 8], [1, 0, 0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))
  const size = c.v ? 44 : 38
  return (
    <div style={{ position: 'absolute', left: c.v ? 90 : 80, top: c.v ? 220 : 46, display: 'flex', alignItems: 'center', gap: 16, opacity: o }}>
      <Mark c={c} size={size} />
      <span style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: size * 0.72, color: c.pal.ink, letterSpacing: '-0.01em' }}>{c.name}</span>
    </div>
  )
}

const isDark = (bg: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b < 128 }

export function Ad(p: AdProps) {
  const style = p.template.style
  const pal = themed(p.palette, style.theme)
  const c: Ctx = { v: p.format !== 'square', f: fontsFor(style.font ?? p.font), pal, fx: style.fx, name: p.name, url: p.url, labels: p.labels }
  const beats = plan(p)
  const t = tlen(p)
  const present = () => (style.transition === 'cut' ? none() : style.transition === 'wipe' ? wipe({ direction: 'from-left' }) : style.transition === 'fade' ? zoomBlur() : whip()) as unknown as TransitionPresentation<Record<string, unknown>>
  const hidden: [number, number][] = []
  let at = 0
  for (const b of beats) {
    if (['cta', 'marquee', 'search', 'notifs', 'pov'].includes(b.kind)) hidden.push([at, at + b.d])
    at += b.d - t
  }
  return (
    <AbsoluteFill style={{ fontFamily: c.f.body, background: pal.bg }}>
      <Background pal={pal} kind={style.bg} />
      <TransitionSeries>
        {beats.flatMap((b, i) => [
          ...(i ? [<TransitionSeries.Transition key={`t${i}`} presentation={present()} timing={linearTiming({ durationInFrames: t })} />] : []),
          <TransitionSeries.Sequence key={`s${i}`} durationInFrames={b.d}><Camera d={b.d}>{scene(b, p, c)}</Camera></TransitionSeries.Sequence>,
        ])}
      </TransitionSeries>
      <Brand c={c} hidden={hidden} />
      <Finish dark={isDark(pal.bg)} />
    </AbsoluteFill>
  )
}

const TEMPLATE: TemplateSpec = { id: 'promesa', scenes: ['hook', 'points', 'screens', 'cta'], style: { theme: 'auto', fx: 'rise', transition: 'slide', pace: 1, bg: 'blobs' } }
export const SAMPLE: AdProps = {
  format: 'vertical', name: 'Turnera Luna', url: 'turnera-luna.museteam.app', font: 'grotesk', template: TEMPLATE,
  palette: { bg: '#10161F', surface: '#1B2430', ink: '#F1F4F8', muted: '#A9B4C2', accent: '#F5A524', accentInk: '#10161F' },
  labels: { before: 'Antes', after: 'Ahora', pov: 'POV:', stop: 'Basta de', notes: 'Notas', now: 'ahora', chat: 'Caro' },
  hook: 'Tus clientas reservan solas, a cualquier hora', emphasis: 'reservan solas', sub: 'Turnos online con seña, sin llamadas',
  points: ['Agenda abierta 24 horas', 'Seña con Mercado Pago', 'Recordatorios automáticos'], screens: [], cta: 'Probalo gratis', ctaSub: 'Listo en 2 minutos',
}

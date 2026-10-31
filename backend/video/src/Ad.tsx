import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, Easing, Img, interpolate, Sequence, spring, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from 'remotion'
import { linearTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight'
import { loadFont as loadFraunces } from '@remotion/google-fonts/Fraunces'
import { loadFont as loadNunito } from '@remotion/google-fonts/Nunito'
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'

/**
 * The ad: a hook, three benefits, the product's real screens (captured from the published app or the approved design) and
 * the call to action. Everything comes from the ad script the team writes (backend/app/ads.py). Two formats: vertical
 * 9:16 (Reels, Stories) and square 1:1 (feed). In the vertical one the text stays inside Meta's Reels safe zone
 * (14 % top, 35 % bottom, 6 % sides are covered by the app's own interface).
 */
export type Screen = { src: string; caption: string; kind: 'phone' | 'desktop'; ratio: number; bg?: string }  // bg: the page's own colour, below a short capture
export type AdProps = {
  format: 'vertical' | 'square'
  name: string
  url: string
  palette: { bg: string; surface: string; ink: string; muted: string; accent: string; accentInk: string }
  font: 'grotesk' | 'serif' | 'rounded'
  hook: string
  emphasis: string
  sub: string
  points: string[]
  screens: Screen[]
  cta: string
  ctaSub: string
}

export const FPS = 30
const T = 12  // frames of each transition
const D = { hook: 84, points: 96, screen: 105, cta: 105 }

export const SAMPLE: AdProps = {
  format: 'vertical',
  name: 'Turnera Luna',
  url: 'turnera-luna.tably.app',
  palette: { bg: '#10161F', surface: '#1B2430', ink: '#F1F4F8', muted: '#A9B4C2', accent: '#F5A524', accentInk: '#10161F' },
  font: 'grotesk',
  hook: 'Tus clientes reservan solos, a cualquier hora',
  emphasis: 'reservan solos',
  sub: 'Turnos online para tu estudio, sin llamadas ni WhatsApp',
  points: ['Agenda online las 24 horas', 'Seña con Mercado Pago', 'Recordatorios automáticos'],
  screens: [],
  cta: 'Probalo gratis',
  ctaSub: 'Sin tarjeta · listo en 2 minutos',
}

const durationOf = (p: AdProps) => D.hook + D.points + p.screens.length * D.screen + D.cta - (2 + p.screens.length) * T

export const adMetadata: CalculateMetadataFunction<AdProps> = ({ props }) => ({
  durationInFrames: durationOf(props),
  width: 1080,
  height: props.format === 'square' ? 1080 : 1920,
  fps: FPS,
})

const fonts: Record<AdProps['font'], () => { display: string; body: string }> = {
  grotesk: () => ({ display: loadInterTight('normal', { weights: ['600', '800'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadInter('normal', { weights: ['400', '500', '600'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
  serif: () => ({ display: loadFraunces('normal', { weights: ['600', '800'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadInter('normal', { weights: ['400', '500', '600'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
  rounded: () => ({ display: loadNunito('normal', { weights: ['700', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadNunito('normal', { weights: ['400', '600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
}
const loaded: Partial<Record<AdProps['font'], { display: string; body: string }>> = {}
const fontsFor = (f: AdProps['font']) => (loaded[f] ??= (fonts[f] ?? fonts.grotesk)())

/** Shrinks a line that is longer than the layout was drawn for. */
const fit = (text: string, base: number, chars: number) => Math.round(base * Math.min(1, Math.sqrt(chars / Math.max(text.length, 1))))

type Ctx = { p: AdProps; v: boolean; f: { display: string; body: string } }

function Backdrop({ p }: { p: AdProps }) {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const a = frame / 90
  const blob = (x: number, y: number, r: number, o: number): CSSProperties => ({
    position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: '50%',
    background: `radial-gradient(circle, ${p.palette.accent} 0%, transparent 70%)`, opacity: o,
  })
  return (
    <AbsoluteFill style={{ background: p.palette.bg, overflow: 'hidden' }}>
      <div style={blob(width * (0.85 + 0.05 * Math.sin(a)), height * (0.12 + 0.03 * Math.cos(a)), width * 0.55, 0.22)} />
      <div style={blob(width * (0.1 + 0.05 * Math.cos(a * 0.8)), height * (0.88 + 0.02 * Math.sin(a)), width * 0.6, 0.14)} />
    </AbsoluteFill>
  )
}

/** The brand, small and always there: Meta's guidance is to show it in the first seconds. */
function Brand({ c, until }: { c: Ctx; until: number }) {
  const frame = useCurrentFrame()
  const o = interpolate(frame, [0, 10, until, until + T], [0, 1, 1, 0], { extrapolateRight: 'clamp' })  // the closing scene shows it big
  const size = c.v ? 44 : 38
  return (
    <div style={{ position: 'absolute', left: c.v ? 90 : 72, top: c.v ? 290 : 64, display: 'flex', alignItems: 'center', gap: 16, opacity: o }}>
      <Mark c={c} size={size} />
      <span style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: size * 0.72, color: c.p.palette.ink, letterSpacing: '-0.01em' }}>{c.p.name}</span>
    </div>
  )
}

function Mark({ c, size }: { c: Ctx; size: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.28, background: c.p.palette.accent, color: c.p.palette.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: c.f.display, fontWeight: 800, fontSize: size * 0.56 }}>
      {(c.p.name.trim()[0] || '·').toUpperCase()}
    </span>
  )
}

/** Where text can go: the vertical format keeps Meta's Reels safe zone (top 14 %, bottom 35 %, sides 6 %) and centres in it. */
const SAFE = (c: Ctx): CSSProperties => (c.v ? { padding: '300px 90px 670px', justifyContent: 'center' } : { padding: '130px 72px 80px', justifyContent: 'center' })

/** In the vertical format, while the hook and the benefits play, the product's first screen peeks from the bottom (the part of
 *  the frame the Reels interface covers, so it carries no text). */
function Peek({ c, from }: { c: Ctx; from: number }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = c.p.screens[0]
  if (!c.v || !s) return null
  const up = spring({ frame: frame - from, fps, config: { damping: 30, stiffness: 60 } })
  const w = 640
  return (
    <div style={{ position: 'absolute', left: (1080 - w - 36) / 2, top: 1920 - 260 * up - 40 * Math.min(1, frame / 180), width: w + 36, height: 900, borderRadius: 80, background: '#07090C', padding: 18, boxShadow: '0 -30px 90px -30px rgba(0,0,0,.6)' }}>
      <div style={{ width: w, height: 900, overflow: 'hidden', borderRadius: 62, background: s.bg || '#fff' }}><Img src={s.src} style={{ width: w, display: 'block' }} /></div>
    </div>
  )
}

const rise = (frame: number, fps: number, delay: number) => spring({ frame: frame - delay, fps, config: { damping: 18, stiffness: 140, mass: 0.7 } })

function Hook({ c }: { c: Ctx }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const words = c.p.hook.split(/\s+/).filter(Boolean)
  const marked = new Set(c.p.emphasis.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))
  const size = fit(c.p.hook, c.v ? 112 : 86, c.v ? 34 : 40)
  const subIn = rise(frame, fps, 6 + words.length * 4)
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: c.v ? 44 : 34 }}>
      <h1 style={{ margin: 0, fontFamily: c.f.display, fontWeight: 800, fontSize: size, lineHeight: 1.04, letterSpacing: '-0.025em', color: c.p.palette.ink }}>
        {words.map((w, i) => {
          const s = rise(frame, fps, 4 + i * 4)
          const key = (x?: string) => (x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
          const hot = marked.has(key(w))
          const joined = hot && marked.has(key(words[i + 1]))  // the underline runs across the space to the next marked word
          const bar = interpolate(frame, [14 + words.length * 4, 30 + words.length * 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })
          return (
            <span key={i} style={{ display: 'inline-block', marginRight: '0.24em', opacity: s, transform: `translateY(${(1 - s) * 50}px)`, position: 'relative', color: hot ? c.p.palette.accent : undefined }}>
              {w}
              {hot && <span style={{ position: 'absolute', left: 0, right: joined ? '-0.26em' : '0.02em', bottom: '0.02em', height: '0.1em', borderRadius: 8, background: c.p.palette.accent, transform: `scaleX(${bar})`, transformOrigin: 'left' }} />}
            </span>
          )
        })}
      </h1>
      <p style={{ margin: 0, fontFamily: c.f.body, fontWeight: 500, fontSize: fit(c.p.sub, c.v ? 46 : 38, 60), lineHeight: 1.3, color: c.p.palette.muted, opacity: subIn, transform: `translateY(${(1 - subIn) * 24}px)` }}>{c.p.sub}</p>
    </AbsoluteFill>
  )
}

function Check({ c, size }: { c: Ctx; size: number }) {
  return (
    <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke={c.p.palette.accentInk} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
  )
}

function Points({ c }: { c: Ctx }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const size = c.v ? 92 : 72
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: c.v ? 56 : 40 }}>
      {c.p.points.slice(0, 3).map((pt, i) => {
        const s = rise(frame, fps, 4 + i * 9)
        const pop = spring({ frame: frame - 8 - i * 9, fps, config: { damping: 10, stiffness: 180 } })
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: c.v ? 36 : 28, opacity: s, transform: `translateX(${(1 - s) * -60}px)` }}>
            <span style={{ flexShrink: 0, width: size, height: size, borderRadius: '50%', background: c.p.palette.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${pop})` }}><Check c={c} size={size} /></span>
            <span style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: fit(pt, c.v ? 64 : 54, 26), lineHeight: 1.1, letterSpacing: '-0.015em', color: c.p.palette.ink }}>{pt}</span>
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

/** A real screen of the product inside a phone or a browser window; a tall capture scrolls slowly, like someone using it. */
function ScreenShot({ c, s }: { c: Ctx; s: Screen }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 20, stiffness: 110 } })
  const phone = s.kind === 'phone'
  // the device's size in each format
  const w = phone ? (c.v ? 600 : 400) : (c.v ? 940 : 600)
  const viewH = phone ? Math.round(w * 2.04) : Math.round(w * 0.66)
  const imgH = w * s.ratio
  const travel = Math.max(0, Math.min(imgH - viewH, viewH * 1.2))
  const y = interpolate(frame, [18, D.screen - 6], [0, -travel], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) })
  const capIn = rise(frame, fps, 2)
  const bezel = phone ? 18 : 0
  const device = (
    <div style={{ width: w + bezel * 2, borderRadius: phone ? 78 : 22, background: phone ? '#07090C' : c.p.palette.surface, padding: bezel, boxShadow: '0 40px 120px -30px rgba(0,0,0,.55), 0 0 0 2px rgba(255,255,255,.06)', transform: `translateY(${(1 - enter) * 160}px) scale(${0.92 + enter * 0.08})`, opacity: enter }}>
      {!phone && (
        <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px' }}>
          {['#F26B5E', '#F5BF4F', '#5FC454'].map((k) => <span key={k} style={{ width: 14, height: 14, borderRadius: 7, background: k }} />)}
          <span style={{ marginLeft: 18, flex: 1, height: 30, borderRadius: 15, background: c.p.palette.bg, color: c.p.palette.muted, fontFamily: c.f.body, fontSize: 17, display: 'flex', alignItems: 'center', padding: '0 16px' }}>{c.p.url}</span>
        </div>
      )}
      <div style={{ width: w, height: viewH, overflow: 'hidden', borderRadius: phone ? 60 : '0 0 14px 14px', background: s.bg || '#fff', position: 'relative' }}>
        <Img src={s.src} style={{ width: w, display: 'block', transform: `translateY(${y}px)` }} />
      </div>
    </div>
  )
  const caption = (
    <h2 style={{ margin: 0, fontFamily: c.f.display, fontWeight: 800, fontSize: fit(s.caption, c.v ? 64 : 50, c.v ? 30 : 22), lineHeight: 1.08, letterSpacing: '-0.02em', color: c.p.palette.ink, opacity: capIn, transform: `translateY(${(1 - capIn) * 30}px)` }}>{s.caption}</h2>
  )
  if (!c.v && phone) {  // square: the caption on the left, the phone on the right, cropped at the bottom like it rests on the frame
    return (
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'flex-start', padding: '170px 0 0 72px', gap: 40 }}>
        <div style={{ flex: 1, paddingTop: 30 }}>{caption}</div>
        <div style={{ marginRight: 56 }}>{device}</div>
      </AbsoluteFill>
    )
  }
  return (
    <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', padding: c.v ? '400px 90px 0' : '160px 72px 0', gap: c.v ? 56 : 34 }}>
      <div style={{ alignSelf: 'stretch' }}>{caption}</div>
      {device}
    </AbsoluteFill>
  )
}

function Cta({ c }: { c: Ctx }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const a = rise(frame, fps, 2)
  const b = rise(frame, fps, 10)
  const btn = spring({ frame: frame - 16, fps, config: { damping: 12, stiffness: 150 } })
  const pulse = 1 + 0.025 * Math.sin(Math.max(0, frame - 30) / 6)
  const mark = c.v ? 150 : 110
  return (
    <AbsoluteFill style={{ ...SAFE(c), alignItems: 'center', flexDirection: 'column', gap: c.v ? 40 : 28, textAlign: 'center' }}>
      <div style={{ opacity: a, transform: `scale(${0.8 + a * 0.2})` }}><Mark c={c} size={mark} /></div>
      <div style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: fit(c.p.name, c.v ? 120 : 96, 14), letterSpacing: '-0.03em', lineHeight: 1, color: c.p.palette.ink, opacity: a, transform: `translateY(${(1 - a) * 30}px)`, padding: '0 80px' }}>{c.p.name}</div>
      <div style={{ fontFamily: c.f.body, fontWeight: 500, fontSize: c.v ? 38 : 32, color: c.p.palette.muted, opacity: b }}>{c.p.url}</div>
      <div style={{ marginTop: c.v ? 30 : 16, transform: `scale(${btn * pulse})`, opacity: btn, background: c.p.palette.accent, color: c.p.palette.accentInk, fontFamily: c.f.display, fontWeight: 800, fontSize: c.v ? 54 : 44, padding: c.v ? '30px 70px' : '24px 56px', borderRadius: 999, boxShadow: `0 24px 60px -20px ${c.p.palette.accent}` }}>{c.p.cta}</div>
      {c.p.ctaSub && <div style={{ fontFamily: c.f.body, fontWeight: 500, fontSize: c.v ? 32 : 28, color: c.p.palette.muted, opacity: b }}>{c.p.ctaSub}</div>}
    </AbsoluteFill>
  )
}

export function Ad(p: AdProps) {
  const c: Ctx = { p, v: p.format !== 'square', f: fontsFor(p.font) }
  const seq: { d: number; node: ReactNode }[] = [
    { d: D.hook, node: <Hook c={c} /> },
    { d: D.points, node: <Points c={c} /> },
    ...p.screens.map((s) => ({ d: D.screen, node: <ScreenShot c={c} s={s} /> })),
    { d: D.cta, node: <Cta c={c} /> },
  ]
  return (
    <AbsoluteFill style={{ fontFamily: c.f.body }}>
      <Backdrop p={p} />
      <TransitionSeries>
        {seq.flatMap((s, i) => [
          ...(i ? [<TransitionSeries.Transition key={`t${i}`} presentation={i % 2 ? slide({ direction: 'from-bottom' }) : fade()} timing={linearTiming({ durationInFrames: T })} />] : []),
          <TransitionSeries.Sequence key={`s${i}`} durationInFrames={s.d}>{s.node}</TransitionSeries.Sequence>,
        ])}
      </TransitionSeries>
      <Sequence durationInFrames={D.hook + D.points - T}><Peek c={c} from={20} /></Sequence>
      <Brand c={c} until={durationOf(p) - D.cta} />
    </AbsoluteFill>
  )
}

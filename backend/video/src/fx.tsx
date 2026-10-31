import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, Easing, Img, interpolate, spring, useCurrentFrame } from 'remotion'
import type { TransitionPresentation, TransitionPresentationComponentProps } from '@remotion/transitions'

/**
 * The motion toolkit behind every template, in the spirit of After Effects: easy-ease curves, text revealed through masks
 * with motion blur, devices in 3D with a light sweep, a camera that keeps pushing in, film grain and vignette, and
 * transitions that blur with the movement (zoom blur, whip pan).
 */

export type Palette = { bg: string; surface: string; ink: string; muted: string; accent: string; accentInk: string }
export type Theme = 'auto' | 'dark' | 'light' | 'accent' | 'paper'

export const EASE = Easing.bezier(0.16, 1, 0.3, 1)  // expo out, the «easy ease» of a pro title
export const EASE_IO = Easing.bezier(0.65, 0, 0.35, 1)
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
/** 0 → 1 between `start` and `start + dur`, eased. */
export const prog = (frame: number, start: number, dur: number, ease = EASE) => interpolate(frame, [start, start + dur], [0, 1], { ...CLAMP, easing: ease })

// ------------------------------------------------------------------------------------------------------------- colour

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hex = (c: number[]) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('').toUpperCase()
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)) }
export const alpha = (h: string, a: number) => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})` }
const lum = (h: string) => { const [r, g, b] = rgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
const readable = (bg: string) => (contrast('#0E1217', bg) >= contrast('#FFFFFF', bg) ? '#0E1217' : '#FFFFFF')
/** Pushes a colour towards black (or white) until it stands out on `bg`. */
const standOut = (c: string, bg: string, min: number) => { const to = lum(bg) > 0.4 ? '#000000' : '#FFFFFF'; let x = c; for (let i = 0; i < 12 && contrast(x, bg) < min; i++) x = mix(x, to, 0.12); return x }

/** The template's look on top of the brand's palette: the app's own colours whenever they already fit the template
 *  (a light app in a light template, a dark one in a dark template); otherwise a light or dark version keeping its accent. */
export function themed(p: Palette, theme: Theme): Palette {
  if (theme === 'dark' && lum(p.bg) > 0.2) {
    const bg = '#0E1217'
    const accent = standOut(p.accent, bg, 3)
    return { bg, surface: '#1A2029', ink: '#F4F6F8', muted: '#AEB8C4', accent, accentInk: readable(accent) }
  }
  if ((theme === 'light' || theme === 'paper') && lum(p.bg) > 0.4) return p  // the app is already light: its own colours
  if (theme === 'light' || theme === 'paper') {
    const bg = theme === 'paper' ? '#FBF6E9' : '#F5F3EE'
    const accent = standOut(p.accent, bg, 3)
    return { bg, surface: theme === 'paper' ? '#FFFDF6' : '#FFFFFF', ink: '#15181D', muted: '#56606B', accent, accentInk: readable(accent) }
  }
  if (theme === 'accent') {
    const ink = readable(p.accent)
    return { bg: p.accent, surface: mix(p.accent, ink, 0.12), ink, muted: alpha(ink, 0.75), accent: p.bg, accentInk: p.ink }
  }
  return p
}

// --------------------------------------------------------------------------------------------------------- backdrops

export type BgKind = 'blobs' | 'grid' | 'solid' | 'gradient'

/** An animated backdrop: soft light blobs, a moving grid, a gradient with a travelling highlight or a lit solid. */
export function Background({ pal, kind }: { pal: Palette; kind: BgKind }) {
  const frame = useCurrentFrame()
  const t = frame / 30
  const glow = (x: number, y: number, r: number, col: string, o: number): CSSProperties => ({
    position: 'absolute', left: `${x}%`, top: `${y}%`, width: r, height: r, marginLeft: -r / 2, marginTop: -r / 2, borderRadius: '50%',
    background: `radial-gradient(circle, ${alpha(col, o)} 0%, ${alpha(col, 0)} 68%)`,
  })
  return (
    <AbsoluteFill style={{ background: pal.bg, overflow: 'hidden' }}>
      {kind === 'blobs' && <>
        <div style={glow(82 + 6 * Math.sin(t * 0.5), 14 + 4 * Math.cos(t * 0.4), 1300, pal.accent, 0.32)} />
        <div style={glow(12 + 5 * Math.cos(t * 0.35), 86 + 3 * Math.sin(t * 0.45), 1400, mix(pal.accent, pal.ink, 0.35), 0.16)} />
        <div style={glow(50 + 20 * Math.sin(t * 0.2), 50 + 10 * Math.cos(t * 0.25), 900, pal.accent, 0.08)} />
      </>}
      {kind === 'grid' && (
        <AbsoluteFill style={{
          backgroundImage: `linear-gradient(${alpha(pal.ink, 0.07)} 2px, transparent 2px), linear-gradient(90deg, ${alpha(pal.ink, 0.07)} 2px, transparent 2px)`,
          backgroundSize: '90px 90px', backgroundPosition: `0 ${frame * 0.6}px`,
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 45%, #000 20%, transparent 75%)', maskImage: 'radial-gradient(ellipse at 50% 45%, #000 20%, transparent 75%)',
        }} />
      )}
      {kind === 'gradient' && <>
        <AbsoluteFill style={{ background: `linear-gradient(160deg, ${pal.bg} 0%, ${mix(pal.bg, pal.accent, 0.28)} 100%)` }} />
        <div style={glow(30 + 40 * ((t * 0.08) % 1), 30, 1500, '#FFFFFF', lum(pal.bg) > 0.4 ? 0.25 : 0.06)} />
      </>}
      {kind === 'solid' && <div style={glow(50, -5, 1800, lum(pal.bg) > 0.4 ? '#FFFFFF' : pal.accent, lum(pal.bg) > 0.4 ? 0.6 : 0.12)} />}
    </AbsoluteFill>
  )
}

/** Film grain (a noise that changes every frame) and a vignette: what takes the «flat web page» look away. */
export function Finish({ dark }: { dark: boolean }) {
  const frame = useCurrentFrame()
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,${dark ? 0.42 : 0.12}) 100%)`, pointerEvents: 'none' }} />
      <AbsoluteFill style={{ opacity: dark ? 0.07 : 0.05, mixBlendMode: 'overlay', pointerEvents: 'none' }}>
        <svg width="100%" height="100%"><filter id={`g${frame % 8}`}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={frame % 8} /></filter><rect width="100%" height="100%" filter={`url(#g${frame % 8})`} /></svg>
      </AbsoluteFill>
    </>
  )
}

/** A slow push-in over the whole scene, like a camera on a dolly. */
export function Camera({ d, children }: { d: number; children: ReactNode }) {
  const frame = useCurrentFrame()
  const s = interpolate(frame, [0, d], [1, 1.045], CLAMP)
  return <AbsoluteFill style={{ transform: `scale(${s})` }}>{children}</AbsoluteFill>
}

// -------------------------------------------------------------------------------------------------------------- text

export type TextFx = 'rise' | 'pop' | 'box' | 'type'
const key = (w?: string) => (w ?? '').toLowerCase().replace(/[^\p{L}\p{N}%$]/gu, '')

/** A line of words animated in: through a mask with motion blur (rise), springing with blur (pop), with a highlight box
 *  wiping behind the key words (box), or typed (type). */
export function Words({ text, emphasis = '', fx, start = 0, stagger = 3, style, pal }: { text: string; emphasis?: string; fx: TextFx; start?: number; stagger?: number; style: CSSProperties; pal: Palette }) {
  const frame = useCurrentFrame()
  const words = text.split(/\s+/).filter(Boolean)
  const marked = new Set(emphasis.split(/\s+/).map(key).filter(Boolean))
  if (fx === 'type') {
    const n = Math.max(0, Math.floor((frame - start) / 1.4))
    const on = Math.floor(frame / 12) % 2 === 0 || n < text.length
    return <div style={style}>{text.slice(0, n)}<span style={{ display: 'inline-block', width: '0.06em', height: '0.9em', marginLeft: '0.04em', verticalAlign: '-0.08em', background: pal.accent, opacity: on ? 1 : 0 }} /></div>
  }
  return (
    <div style={style}>
      {words.map((w, i) => {
        const t = frame - start - i * stagger
        const hot = marked.has(key(w))
        const joined = hot && marked.has(key(words[i + 1]))
        if (fx === 'pop') {
          const s = spring({ frame: t, fps: 30, config: { damping: 12, stiffness: 170, mass: 0.6 } })
          return <span key={i} style={{ display: 'inline-block', marginRight: '0.24em', transform: `scale(${0.45 + 0.55 * s})`, opacity: Math.min(1, Math.max(0, t / 5)), filter: `blur(${(1 - Math.min(1, Math.max(0, t / 8))) * 10}px)`, color: hot ? pal.accent : undefined }}>{w}</span>
        }
        const e = prog(t, 0, 20)
        const box = fx === 'box' && hot ? prog(t, 10, 14) : 0
        return (
          <span key={i} style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.1em', marginBottom: '-0.1em', marginRight: joined && fx === 'box' ? 0 : '0.24em', paddingRight: joined && fx === 'box' ? '0.24em' : 0 }}>
            <span style={{ display: 'inline-block', position: 'relative', transform: `translateY(${(1 - e) * 108}%)`, filter: `blur(${(1 - e) * 7}px)`, color: hot ? (fx === 'box' ? (box > 0.5 ? pal.accentInk : undefined) : pal.accent) : undefined }}>
              {fx === 'box' && hot && <span style={{ position: 'absolute', zIndex: -1, left: '-0.1em', right: joined ? '-0.34em' : '-0.1em', top: '0.04em', bottom: '-0.02em', background: pal.accent, borderRadius: '0.12em', transform: `scaleX(${box})`, transformOrigin: 'left' }} />}
              {w}
            </span>
          </span>
        )
      })}
    </div>
  )
}

/** A short line that fades up with blur (subtitles, labels). */
export function Fade({ children, start = 0, style }: { children: ReactNode; start?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame()
  const e = prog(frame, start, 18)
  return <div style={{ ...style, opacity: e, transform: `translateY(${(1 - e) * 28}px)`, filter: `blur(${(1 - e) * 6}px)` }}>{children}</div>
}

// ----------------------------------------------------------------------------------------------------------- devices

/** A light band that sweeps once across its parent (glass, a button). */
export function Sweep({ at, dur = 34, strength = 0.28 }: { at: number; dur?: number; strength?: number }) {
  const frame = useCurrentFrame()
  const x = interpolate(frame, [at, at + dur], [-130, 130], { ...CLAMP, easing: EASE_IO })
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: `linear-gradient(110deg, transparent 38%, rgba(255,255,255,${strength}) 50%, transparent 62%)`, transform: `translateX(${x}%)` }} />
}

export type Shot = { src: string; ratio: number; bg?: string }

/** The phone, in 3D: it swings into place, floats, catches a light sweep, and its screen scrolls like someone using it. */
export function Phone({ shot, w, enter = 0, scroll = 0, flat = false, zoom }: { shot: Shot; w: number; enter?: number; scroll?: number; flat?: boolean; zoom?: { s: number; y: number } }) {
  const frame = useCurrentFrame()
  const e = spring({ frame: frame - enter, fps: 30, config: { damping: 20, stiffness: 80, mass: 1 } })
  const viewH = Math.round(w * 2.05)
  const travel = Math.max(0, Math.min(w * shot.ratio - viewH, viewH * 1.4))
  const ry = flat ? 0 : interpolate(e, [0, 1], [-32, -9]) + 2.5 * Math.sin(frame / 45)
  const rx = flat ? 0 : interpolate(e, [0, 1], [14, 5])
  const float = 10 * Math.sin(frame / 38)
  const r = w * 0.135
  return (
    <div style={{ perspective: 2400 }}>
      <div style={{ transform: `translateY(${(1 - e) * 260 + float}px) rotateY(${ry}deg) rotateX(${rx}deg) scale(${0.86 + 0.14 * e})`, opacity: Math.min(1, e * 1.6), transformStyle: 'preserve-3d' }}>
        <div style={{ position: 'relative', width: w + 30, padding: 15, borderRadius: r + 15, background: 'linear-gradient(145deg, #3A404A 0%, #0A0C10 38%, #1B1F26 100%)', boxShadow: '0 80px 140px -50px rgba(0,0,0,.75), 0 30px 60px -30px rgba(0,0,0,.5), inset 0 0 0 2px rgba(255,255,255,.1)' }}>
          <div style={{ position: 'relative', width: w, height: viewH, borderRadius: r, overflow: 'hidden', background: shot.bg || '#fff' }}>
            <Img src={shot.src} style={{ width: w, display: 'block', transform: zoom ? `scale(${zoom.s})` : `translateY(${-travel * scroll}px)`, transformOrigin: zoom ? `50% ${zoom.y * 100}%` : undefined }} />
            <div style={{ position: 'absolute', top: w * 0.03, left: '50%', width: w * 0.3, height: w * 0.085, marginLeft: -w * 0.15, borderRadius: 999, background: '#05060A' }} />
            <Sweep at={enter + 16} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The desktop screen inside a browser window, tilted back in 3D and settling flat. */
export function Browser({ shot, w, url, pal, enter = 0, scroll = 0 }: { shot: Shot; w: number; url: string; pal: Palette; enter?: number; scroll?: number }) {
  const frame = useCurrentFrame()
  const e = spring({ frame: frame - enter, fps: 30, config: { damping: 22, stiffness: 80 } })
  const viewH = Math.round(w * 0.62)
  const travel = Math.max(0, Math.min(w * shot.ratio - viewH, viewH))
  return (
    <div style={{ perspective: 2600 }}>
      <div style={{ transform: `translateY(${(1 - e) * 220 + 6 * Math.sin(frame / 40)}px) rotateX(${interpolate(e, [0, 1], [24, 4])}deg) scale(${0.88 + 0.12 * e})`, opacity: Math.min(1, e * 1.6) }}>
        <div style={{ width: w, borderRadius: 22, overflow: 'hidden', background: pal.surface, boxShadow: '0 80px 140px -50px rgba(0,0,0,.6), inset 0 0 0 1.5px rgba(255,255,255,.08)' }}>
          <div style={{ height: 50, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', background: mix(pal.surface, pal.ink, 0.06) }}>
            {['#F26B5E', '#F5BF4F', '#5FC454'].map((k) => <span key={k} style={{ width: 13, height: 13, borderRadius: 7, background: k }} />)}
            <span style={{ marginLeft: 16, flex: 1, height: 30, borderRadius: 15, background: pal.bg, color: pal.muted, fontSize: 16, display: 'flex', alignItems: 'center', padding: '0 16px' }}>{url}</span>
          </div>
          <div style={{ position: 'relative', height: viewH, overflow: 'hidden', background: shot.bg || '#fff' }}>
            <Img src={shot.src} style={{ width: w, display: 'block', transform: `translateY(${-travel * scroll}px)` }} />
            <Sweep at={enter + 18} strength={0.18} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------------- transitions

type Empty = Record<string, never>
/** Zoom blur: the new scene comes in from a slight push with blur, the old one pulls back and blurs out. */
function ZoomBlur({ children, presentationDirection, presentationProgress }: TransitionPresentationComponentProps<Empty>) {
  const p = EASE(presentationProgress)
  const enter = presentationDirection === 'entering'
  return <AbsoluteFill style={{ transform: `scale(${enter ? 1.14 - 0.14 * p : 1 - 0.07 * p})`, filter: `blur(${(enter ? 1 - p : p) * 16}px)`, opacity: enter ? p : 1 - p }}>{children}</AbsoluteFill>
}
/** Whip pan: a fast horizontal move with motion blur peaking in the middle. */
function Whip({ children, presentationDirection, presentationProgress }: TransitionPresentationComponentProps<Empty>) {
  const p = EASE_IO(presentationProgress)
  const enter = presentationDirection === 'entering'
  return <AbsoluteFill style={{ transform: `translateX(${enter ? (1 - p) * 100 : -p * 100}%)`, filter: `blur(${Math.sin(presentationProgress * Math.PI) * 22}px)` }}>{children}</AbsoluteFill>
}
export const zoomBlur = (): TransitionPresentation<Empty> => ({ component: ZoomBlur, props: {} })
export const whip = (): TransitionPresentation<Empty> => ({ component: Whip, props: {} })

import type { CSSProperties } from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame } from 'remotion'
import { Browser, EASE_IO, Fade, Phone, Sweep, Words, alpha, mix, prog, type Palette, type Shot, type TextFx } from './fx'

/** What every scene gets: the ad, the format, the fonts, the template's palette and text effect. */
export type Labels = { before: string; after: string; pov: string; stop: string; notes: string; now: string; chat: string }
export type Ctx = {
  v: boolean
  f: { display: string; body: string }
  pal: Palette
  fx: TextFx
  name: string
  url: string
  labels: Labels
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
/** Shrinks a line that is longer than the layout was drawn for. */
export const fit = (text: string, base: number, chars: number) => Math.round(base * Math.min(1, Math.sqrt(chars / Math.max(text.length, 1))))
/** Where text goes: the vertical format keeps Meta's Reels safe zone (top 14 %, bottom 35 %, sides 6 %) and centres in it. */
const SAFE = (c: Ctx, extra: CSSProperties = {}): CSSProperties => ({ ...(c.v ? { padding: '300px 90px 670px' } : { padding: '120px 80px 90px' }), justifyContent: 'center', ...extra })
const H = (c: Ctx, size: number): CSSProperties => ({ margin: 0, fontFamily: c.f.display, fontWeight: 800, fontSize: size, lineHeight: 1.04, letterSpacing: '-0.03em', color: c.pal.ink })
const glass = (c: Ctx): CSSProperties => ({ background: alpha(c.pal.surface, 0.72), border: `1.5px solid ${alpha(c.pal.ink, 0.1)}`, borderRadius: 28, boxShadow: `0 30px 60px -30px ${alpha('#000000', 0.45)}` })

export function Mark({ c, size }: { c: Ctx; size: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.28, background: c.pal.accent, color: c.pal.accentInk, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: c.f.display, fontWeight: 800, fontSize: size * 0.56, flexShrink: 0 }}>
      {(c.name.trim()[0] || '·').toUpperCase()}
    </span>
  )
}

const Icon = ({ kind, size, color }: { kind: 'check' | 'x' | 'search'; size: number; color: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    {kind === 'check' ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : kind === 'x' ? <path d="M7 7l10 10M17 7L7 17" /> : <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>}
  </svg>
)

// ---------------------------------------------------------------------------------------------------------------- hook

export function Hook({ c, text, emphasis, sub }: { c: Ctx; text: string; emphasis: string; sub: string }) {
  const n = text.split(/\s+/).length
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: c.v ? 44 : 30 }}>
      <Words text={text} emphasis={emphasis} fx={c.fx} start={4} style={H(c, fit(text, c.v ? 118 : 92, c.v ? 34 : 42))} pal={c.pal} />
      {sub && <Fade start={10 + n * 3} style={{ fontFamily: c.f.body, fontWeight: 500, fontSize: fit(sub, c.v ? 46 : 36, 60), lineHeight: 1.3, color: c.pal.muted }}>{sub}</Fade>}
    </AbsoluteFill>
  )
}

export function Points({ c, items }: { c: Ctx; items: string[] }) {
  const frame = useCurrentFrame()
  const size = c.v ? 84 : 68
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: c.v ? 30 : 22 }}>
      {items.slice(0, 3).map((pt, i) => {
        const e = prog(frame, 4 + i * 9, 22)
        const pop = spring({ frame: frame - 10 - i * 9, fps: 30, config: { damping: 10, stiffness: 190 } })
        return (
          <div key={i} style={{ ...glass(c), display: 'flex', alignItems: 'center', gap: c.v ? 30 : 24, padding: c.v ? '26px 30px' : '20px 24px', opacity: e, transform: `translateX(${(1 - e) * -80}px)`, filter: `blur(${(1 - e) * 8}px)` }}>
            <span style={{ width: size, height: size, borderRadius: '50%', background: c.pal.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${pop})`, flexShrink: 0 }}><Icon kind="check" size={size * 0.5} color={c.pal.accentInk} /></span>
            <span style={{ ...H(c, fit(pt, c.v ? 58 : 48, 26)), lineHeight: 1.1 }}>{pt}</span>
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

/** A numbered list, one reason per beat, with giant outlined numbers. */
export function Reasons({ c, items, d }: { c: Ctx; items: string[]; d: number }) {
  const frame = useCurrentFrame()
  const each = d / items.length
  const i = Math.min(items.length - 1, Math.floor(frame / each))
  const t = frame - i * each
  const e = prog(t, 0, 16)
  const out = prog(t, each - 8, 8, EASE_IO)
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', alignItems: 'flex-start', gap: 10, opacity: 1 - out * (i < items.length - 1 ? 1 : 0) }}>
      <div style={{ fontFamily: c.f.display, fontWeight: 900, fontSize: c.v ? 360 : 260, lineHeight: 0.85, color: 'transparent', WebkitTextStroke: `6px ${c.pal.accent}`, transform: `scale(${0.7 + 0.3 * e}) translateY(${(1 - e) * 60}px)`, transformOrigin: 'left bottom', filter: `blur(${(1 - e) * 10}px)` }}>{i + 1}</div>
      <Words key={i} text={items[i]} fx="rise" start={Math.round(i * each) + 5} style={H(c, fit(items[i], c.v ? 96 : 76, 22))} pal={c.pal} />
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------------------------------------------------ screens

export function ScreenScene({ c, shot, kind, caption, d }: { c: Ctx; shot: Shot; kind: 'phone' | 'desktop'; caption: string; d: number }) {
  const frame = useCurrentFrame()
  const scroll = prog(frame, 22, d - 30, EASE_IO)
  const cap = <Words text={caption} fx="rise" start={2} style={H(c, fit(caption, c.v ? 66 : 50, c.v ? 30 : 22))} pal={c.pal} />
  if (!c.v && kind === 'phone') {
    return (
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', padding: '0 70px', gap: 40 }}>
        <div style={{ flex: 1 }}>{cap}</div>
        <div style={{ marginTop: 160 }}><Phone shot={shot} w={380} enter={4} scroll={scroll} /></div>
      </AbsoluteFill>
    )
  }
  return (
    <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', padding: c.v ? '300px 90px 0' : '110px 80px 0', gap: c.v ? 64 : 36 }}>
      <div style={{ alignSelf: 'stretch' }}>{cap}</div>
      {kind === 'phone' ? <Phone shot={shot} w={c.v ? 600 : 400} enter={6} scroll={scroll} /> : <Browser shot={shot} w={c.v ? 940 : 820} url={c.url} pal={c.pal} enter={6} scroll={scroll} />}
    </AbsoluteFill>
  )
}

/** The camera pushes into the top of the screen, where the product's key action usually is. */
export function Zoom({ c, shot, caption, d }: { c: Ctx; shot: Shot; caption: string; d: number }) {
  const frame = useCurrentFrame()
  const z = prog(frame, d * 0.25, d * 0.4, EASE_IO)
  const ring = prog(frame, d * 0.62, 14)
  return (
    <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', padding: c.v ? '300px 90px 0' : '110px 80px 0', gap: c.v ? 60 : 30 }}>
      <div style={{ alignSelf: 'stretch' }}><Words text={caption} fx="rise" start={2} style={H(c, fit(caption, c.v ? 66 : 50, 28))} pal={c.pal} /></div>
      <div style={{ position: 'relative' }}>
        <Phone shot={shot} w={c.v ? 600 : 360} enter={4} flat={z > 0.05} zoom={{ s: 1 + 1.1 * z, y: 0.12 }} />
        <div style={{ position: 'absolute', left: '12%', right: '12%', top: '16%', height: '18%', borderRadius: 26, border: `6px solid ${c.pal.accent}`, opacity: ring, transform: `scale(${1.15 - 0.15 * ring})`, boxShadow: `0 0 60px ${alpha(c.pal.accent, 0.6)}` }} />
      </div>
    </AbsoluteFill>
  )
}

/** The app on one side, what happens on the other, line by line. */
export function Split({ c, shot, lines, d }: { c: Ctx; shot: Shot; lines: string[]; d: number }) {
  const frame = useCurrentFrame()
  const each = (d - 20) / lines.length
  const cur = Math.min(lines.length - 1, Math.floor(Math.max(0, frame - 14) / each))
  return (
    <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', padding: c.v ? '0 60px' : '0 60px', gap: c.v ? 40 : 50 }}>
      <div style={{ flexShrink: 0, marginTop: c.v ? -40 : 140 }}><Phone shot={shot} w={c.v ? 470 : 360} enter={2} scroll={prog(frame, 20, d - 26, EASE_IO)} /></div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: c.v ? 34 : 24, marginTop: c.v ? -280 : 0 }}>
        {lines.map((l, i) => {
          const e = prog(frame, 14 + i * each, 16)
          return <div key={i} style={{ ...H(c, fit(l, c.v ? 50 : 42, 26)), lineHeight: 1.12, opacity: e * (i === cur ? 1 : 0.38), transform: `translateY(${(1 - e) * 30}px)`, filter: `blur(${(1 - e) * 6}px)`, color: i === cur ? c.pal.ink : c.pal.muted, borderLeft: `6px solid ${i === cur ? c.pal.accent : 'transparent'}`, paddingLeft: 20 }}>{l}</div>
        })}
      </div>
    </AbsoluteFill>
  )
}

export function Pov({ c, text, shot, d }: { c: Ctx; text: string; shot?: Shot; d: number }) {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center', padding: c.v ? '300px 90px 0' : '100px 80px 0', gap: c.v ? 50 : 26 }}>
      <div style={{ alignSelf: 'stretch' }}>
        <Fade start={0}><span style={{ display: 'inline-block', padding: '6px 18px', borderRadius: 12, background: c.pal.ink, color: c.pal.bg, fontFamily: c.f.display, fontWeight: 900, fontSize: c.v ? 44 : 34 }}>{c.labels.pov}</span></Fade>
        <div style={{ height: 18 }} />
        <Words text={text} fx={c.fx} start={6} style={H(c, fit(text, c.v ? 72 : 54, 40))} pal={c.pal} />
      </div>
      {shot && <div style={{ marginTop: c.v ? 30 : 0 }}><Phone shot={shot} w={c.v ? 520 : 330} enter={12} scroll={prog(frame, 30, d - 34, EASE_IO)} /></div>}
    </AbsoluteFill>
  )
}

// --------------------------------------------------------------------------------------------------- native formats

/** A text conversation: typing dots, then bubbles springing in. */
export function Chat({ c, msgs }: { c: Ctx; msgs: { me: boolean; text: string }[] }) {
  const frame = useCurrentFrame()
  const fs = c.v ? 44 : 34
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: c.v ? 20 : 14 }}>
      <Fade style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <span style={{ width: c.v ? 64 : 48, height: c.v ? 64 : 48, borderRadius: '50%', background: mix(c.pal.surface, c.pal.ink, 0.15), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: c.f.display, fontWeight: 800, color: c.pal.ink, fontSize: c.v ? 28 : 22 }}>{c.labels.chat[0]}</span>
        <span style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: c.v ? 36 : 28, color: c.pal.ink }}>{c.labels.chat}</span>
      </Fade>
      {msgs.slice(0, 5).map((m, i) => {
        const at = 10 + i * 26
        const typing = !m.me && frame >= at - 12 && frame < at
        const s = spring({ frame: frame - at, fps: 30, config: { damping: 14, stiffness: 200, mass: 0.6 } })
        const bubble: CSSProperties = { alignSelf: m.me ? 'flex-end' : 'flex-start', maxWidth: '82%', padding: c.v ? '22px 30px' : '16px 22px', borderRadius: 34, borderBottomRightRadius: m.me ? 10 : 34, borderBottomLeftRadius: m.me ? 34 : 10,
          background: m.me ? c.pal.accent : c.pal.surface, color: m.me ? c.pal.accentInk : c.pal.ink, fontFamily: c.f.body, fontWeight: 500, fontSize: fs, lineHeight: 1.25, boxShadow: `0 16px 30px -18px ${alpha('#000000', 0.4)}` }
        if (typing) return <div key={i} style={{ ...bubble, display: 'flex', gap: 10 }}>{[0, 1, 2].map((k) => <span key={k} style={{ width: 14, height: 14, borderRadius: 7, background: c.pal.muted, opacity: 0.4 + 0.6 * Math.abs(Math.sin((frame + k * 5) / 5)) }} />)}</div>
        if (frame < at) return null
        return <div key={i} style={{ ...bubble, transform: `scale(${0.6 + 0.4 * s})`, transformOrigin: m.me ? 'right bottom' : 'left bottom', opacity: Math.min(1, s * 1.5) }}>{m.text}</div>
      })}
    </AbsoluteFill>
  )
}

/** A note on the phone: the title, the list typed in, each item ticked. */
export function Notes({ c, title, items }: { c: Ctx; title: string; items: string[] }) {
  const frame = useCurrentFrame()
  const e = spring({ frame, fps: 30, config: { damping: 18, stiffness: 90 } })
  const fs = c.v ? 46 : 36
  return (
    <AbsoluteFill style={{ ...SAFE(c), alignItems: 'center' }}>
      <div style={{ width: '100%', padding: c.v ? '44px 48px' : '32px 36px', borderRadius: 36, background: c.pal.surface, boxShadow: `0 50px 90px -40px ${alpha('#000000', 0.45)}`, transform: `rotate(${-2 + e * 1}deg) translateY(${(1 - e) * 200}px)`, opacity: e }}>
        <div style={{ fontFamily: c.f.body, fontSize: c.v ? 26 : 20, fontWeight: 700, color: c.pal.accent, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.labels.notes}</div>
        <div style={{ ...H(c, c.v ? 64 : 50), marginTop: 10, marginBottom: 26 }}>{title}</div>
        {items.slice(0, 5).map((it, i) => {
          const at = 18 + i * 20
          const n = Math.max(0, Math.floor((frame - at) / 1.2))
          const tick = prog(frame, at + it.length * 1.2 + 4, 8)
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '12px 0', borderTop: i ? `1.5px solid ${alpha(c.pal.ink, 0.08)}` : undefined, opacity: frame >= at ? 1 : 0 }}>
              <span style={{ width: fs, height: fs, borderRadius: fs / 2, border: `4px solid ${tick > 0 ? c.pal.accent : alpha(c.pal.ink, 0.3)}`, background: tick > 0.5 ? c.pal.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transform: `scale(${1 + 0.25 * Math.sin(tick * Math.PI)})` }}>{tick > 0.5 && <Icon kind="check" size={fs * 0.6} color={c.pal.accentInk} />}</span>
              <span style={{ fontFamily: c.f.body, fontWeight: 600, fontSize: fs, color: c.pal.ink, lineHeight: 1.2 }}>{it.slice(0, n)}</span>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

export function BeforeAfter({ c, before, after }: { c: Ctx; before: string[]; after: string[] }) {
  const frame = useCurrentFrame()
  const wipe = prog(frame, 42, 26, EASE_IO)
  const fs = c.v ? 46 : 34
  const card = (label: string, items: string[], good: boolean, at: number) => (
    <div style={{ flex: 1, padding: c.v ? '30px 36px' : '24px 26px', borderRadius: 30, background: good ? c.pal.surface : alpha(c.pal.surface, 0.45), border: good ? `3px solid ${c.pal.accent}` : `2px solid ${alpha(c.pal.ink, 0.1)}`, boxShadow: good ? `0 30px 70px -30px ${alpha(c.pal.accent, 0.6)}` : 'none' }}>
      <div style={{ fontFamily: c.f.display, fontWeight: 900, fontSize: c.v ? 34 : 26, letterSpacing: '0.06em', textTransform: 'uppercase', color: good ? c.pal.accent : c.pal.muted, marginBottom: 14 }}>{label}</div>
      {items.slice(0, 3).map((t, i) => {
        const e = prog(frame, at + i * 6, 16)
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 0', opacity: e, transform: `translateY(${(1 - e) * 20}px)` }}>
            <span style={{ width: fs * 0.9, height: fs * 0.9, borderRadius: '50%', flexShrink: 0, background: good ? c.pal.accent : alpha('#FF5A5F', 0.18), display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon kind={good ? 'check' : 'x'} size={fs * 0.5} color={good ? c.pal.accentInk : '#FF5A5F'} /></span>
            <span style={{ fontFamily: c.f.body, fontWeight: good ? 700 : 500, fontSize: fs, color: good ? c.pal.ink : c.pal.muted, textDecoration: good ? 'none' : 'line-through', textDecorationColor: alpha('#FF5A5F', 0.7), lineHeight: 1.2 }}>{t}</span>
          </div>
        )
      })}
    </div>
  )
  return (
    <AbsoluteFill style={{ ...SAFE(c, c.v ? { padding: '300px 80px 560px' } : {}), flexDirection: c.v ? 'column' : 'row', gap: 26 }}>
      {card(c.labels.before, before, false, 4)}
      <div style={{ flex: 1, display: 'flex', clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0 round 30px)` }}>{card(c.labels.after, after, true, 48)}</div>
    </AbsoluteFill>
  )
}

export function Stat({ c, value, label }: { c: Ctx; value: string; label: string }) {
  const frame = useCurrentFrame()
  const m = /^([^\d-]*)(-?[\d.,]+)(.*)$/.exec(value)
  const e = prog(frame, 4, 34)
  let shown = value
  if (m) {
    const n = parseFloat(m[2].replace(/\./g, '').replace(',', '.'))
    if (Number.isFinite(n)) shown = `${m[1]}${Math.round(n * e).toLocaleString('es-AR')}${m[3]}`
  }
  const s = spring({ frame, fps: 30, config: { damping: 14, stiffness: 120 } })
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: 18 }}>
      <div style={{ fontFamily: c.f.display, fontWeight: 900, fontSize: fit(value, c.v ? 300 : 230, 5), lineHeight: 0.9, letterSpacing: '-0.05em', color: c.pal.accent, transform: `scale(${0.7 + 0.3 * s})`, transformOrigin: 'left center', filter: `blur(${(1 - s) * 12}px)`, textShadow: `0 0 80px ${alpha(c.pal.accent, 0.45)}` }}>{shown}</div>
      <Words text={label} fx="rise" start={14} style={H(c, fit(label, c.v ? 62 : 48, 34))} pal={c.pal} />
    </AbsoluteFill>
  )
}

export function Search({ c, query, sub }: { c: Ctx; query: string; sub: string }) {
  const frame = useCurrentFrame()
  const typed = Math.max(0, Math.floor((frame - 8) / 1.6))
  const done = 8 + query.length * 1.6
  const r = spring({ frame: frame - done - 8, fps: 30, config: { damping: 16, stiffness: 120 } })
  const click = prog(frame, done + 34, 14)
  const fs = c.v ? 44 : 34
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: 30 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: c.v ? '28px 36px' : '20px 28px', borderRadius: 999, background: c.pal.surface, boxShadow: `0 24px 50px -24px ${alpha('#000000', 0.4)}`, border: `2px solid ${alpha(c.pal.ink, 0.08)}` }}>
        <Icon kind="search" size={fs} color={c.pal.muted} />
        <span style={{ fontFamily: c.f.body, fontSize: fs, fontWeight: 500, color: c.pal.ink }}>{query.slice(0, typed)}<span style={{ opacity: Math.floor(frame / 10) % 2 ? 0 : 1, color: c.pal.accent }}>|</span></span>
      </div>
      <div style={{ position: 'relative', overflow: 'hidden', padding: c.v ? '34px 38px' : '24px 28px', borderRadius: 30, background: c.pal.surface, border: `3px solid ${alpha(c.pal.accent, r)}`, opacity: r, transform: `translateY(${(1 - r) * 80}px) scale(${1 - click * 0.03 + Math.sin(click * Math.PI) * 0.02})` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <Mark c={c} size={c.v ? 70 : 54} />
          <div>
            <div style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: c.v ? 46 : 36, color: c.pal.ink }}>{c.name}</div>
            <div style={{ fontFamily: c.f.body, fontSize: c.v ? 28 : 22, color: c.pal.accent }}>{c.url}</div>
          </div>
        </div>
        {sub && <div style={{ marginTop: 16, fontFamily: c.f.body, fontSize: c.v ? 34 : 26, color: c.pal.muted, lineHeight: 1.3 }}>{sub}</div>}
        <Sweep at={done + 20} strength={0.2} />
      </div>
    </AbsoluteFill>
  )
}

export function Notifs({ c, items }: { c: Ctx; items: { title: string; body: string }[] }) {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: c.v ? 18 : 12 }}>
      <Fade style={{ textAlign: 'center', fontFamily: c.f.display, fontWeight: 300, fontSize: c.v ? 150 : 100, color: alpha(c.pal.ink, 0.9), letterSpacing: '-0.03em', marginBottom: 20 }}>9:41</Fade>
      {items.slice(0, 3).map((n, i) => {
        const s = spring({ frame: frame - 14 - i * 22, fps: 30, config: { damping: 15, stiffness: 160 } })
        return (
          <div key={i} style={{ display: 'flex', gap: 20, alignItems: 'flex-start', padding: c.v ? '24px 28px' : '18px 22px', borderRadius: 34, background: alpha(c.pal.surface, 0.86), border: `1.5px solid ${alpha(c.pal.ink, 0.08)}`, boxShadow: `0 24px 50px -26px ${alpha('#000000', 0.5)}`, transform: `translateY(${(1 - s) * -140}px) scale(${0.9 + 0.1 * s})`, opacity: Math.min(1, s * 1.4) }}>
            <Mark c={c} size={c.v ? 66 : 50} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: c.f.body, fontSize: c.v ? 26 : 20, color: c.pal.muted }}><span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{c.name}</span><span>{c.labels.now}</span></div>
              <div style={{ fontFamily: c.f.display, fontWeight: 800, fontSize: c.v ? 38 : 30, color: c.pal.ink, marginTop: 4 }}>{n.title}</div>
              <div style={{ fontFamily: c.f.body, fontSize: c.v ? 32 : 25, color: c.pal.muted, marginTop: 2, lineHeight: 1.25 }}>{n.body}</div>
            </div>
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

/** Silent explainer: one big line at a time, the word being «said» lit up like karaoke subtitles. */
export function Lines({ c, lines, d }: { c: Ctx; lines: string[]; d: number }) {
  const frame = useCurrentFrame()
  const each = d / lines.length
  const i = Math.min(lines.length - 1, Math.floor(frame / each))
  const t = frame - i * each
  const words = lines[i].split(/\s+/)
  const lit = Math.floor(t / Math.max(3, (each - 10) / words.length))
  const e = prog(t, 0, 10)
  return (
    <AbsoluteFill style={{ ...SAFE(c), alignItems: 'center' }}>
      <div style={{ ...H(c, fit(lines[i], c.v ? 96 : 76, 30)), textAlign: 'center', opacity: e, transform: `translateY(${(1 - e) * 40}px) scale(${0.96 + 0.04 * e})`, filter: `blur(${(1 - e) * 8}px)` }}>
        {words.map((w, k) => (
          <span key={k} style={{ display: 'inline-block', margin: '0 0.12em', padding: '0 0.1em', borderRadius: '0.14em', background: k === lit ? c.pal.accent : 'transparent', color: k === lit ? c.pal.accentInk : k < lit ? c.pal.ink : alpha(c.pal.ink, 0.45), transform: `scale(${k === lit ? 1.06 : 1})` }}>{w}</span>
        ))}
      </div>
    </AbsoluteFill>
  )
}

export function Problem({ c, text, sub }: { c: Ctx; text: string; sub: string }) {
  const frame = useCurrentFrame()
  const strike = prog(frame, 30, 16, EASE_IO)
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: 24 }}>
      <Fade style={{ fontFamily: c.f.display, fontWeight: 900, fontSize: c.v ? 54 : 42, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#FF5A5F' }}>{c.labels.stop}</Fade>
      <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
        <Words text={text} fx="rise" start={6} style={{ ...H(c, fit(text, c.v ? 100 : 80, 30)), color: strike > 0.5 ? c.pal.muted : c.pal.ink }} pal={c.pal} />
        <div style={{ position: 'absolute', left: -10, right: -10, top: '48%', height: c.v ? 16 : 12, borderRadius: 8, background: '#FF5A5F', transform: `scaleX(${strike}) rotate(-2deg)`, transformOrigin: 'left', boxShadow: `0 0 30px ${alpha('#FF5A5F', 0.6)}` }} />
      </div>
      {sub && <Fade start={52} style={{ fontFamily: c.f.body, fontWeight: 600, fontSize: c.v ? 48 : 38, color: c.pal.accent, lineHeight: 1.25 }}>{sub}</Fade>}
    </AbsoluteFill>
  )
}

export function Steps({ c, items }: { c: Ctx; items: string[] }) {
  const frame = useCurrentFrame()
  const n = Math.min(items.length, 4)
  const size = c.v ? 96 : 74
  const line = prog(frame, 10, 20 + n * 22, EASE_IO)
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column' }}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: c.v ? 54 : 32 }}>
        <div style={{ position: 'absolute', left: size / 2 - 3, top: size / 2, width: 6, height: `calc(${line * 100}% - ${size}px)`, background: c.pal.accent, borderRadius: 3, opacity: 0.6 }} />
        {items.slice(0, n).map((s, i) => {
          const at = 8 + i * 22
          const p = spring({ frame: frame - at, fps: 30, config: { damping: 12, stiffness: 180 } })
          const e = prog(frame, at + 4, 18)
          return (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 30 }}>
              <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: c.pal.accent, color: c.pal.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: c.f.display, fontWeight: 900, fontSize: size * 0.48, transform: `scale(${p})`, boxShadow: `0 0 0 ${10 * p}px ${alpha(c.pal.accent, 0.18)}` }}>{i + 1}</span>
              <span style={{ ...H(c, fit(s, c.v ? 58 : 46, 24)), lineHeight: 1.1, opacity: e, transform: `translateX(${(1 - e) * 40}px)`, filter: `blur(${(1 - e) * 6}px)` }}>{s}</span>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

export function Question({ c, question, answer, d }: { c: Ctx; question: string; answer: string; d: number }) {
  const frame = useCurrentFrame()
  const at = Math.round(d * 0.45)
  const s = spring({ frame: frame - at, fps: 30, config: { damping: 13, stiffness: 150 } })
  return (
    <AbsoluteFill style={{ ...SAFE(c), flexDirection: 'column', gap: 40 }}>
      <Words text={question} fx={c.fx === 'box' ? 'rise' : c.fx} start={4} style={{ ...H(c, fit(question, c.v ? 104 : 80, 30)), opacity: interpolate(s, [0, 1], [1, 0.6], CLAMP) }} pal={c.pal} />
      <div style={{ alignSelf: 'flex-start', position: 'relative', overflow: 'hidden', padding: c.v ? '26px 40px' : '20px 30px', borderRadius: 26, background: c.pal.accent, color: c.pal.accentInk, fontFamily: c.f.display, fontWeight: 800, fontSize: fit(answer, c.v ? 70 : 54, 26), lineHeight: 1.1, transform: `scale(${0.6 + 0.4 * s}) rotate(${(1 - s) * -4}deg)`, transformOrigin: 'left center', opacity: Math.min(1, s * 1.5) }}>
        {answer}
        <Sweep at={at + 14} strength={0.3} />
      </div>
    </AbsoluteFill>
  )
}

/** Huge words running across the frame in rows, a filled row and an outlined one, tilted. */
export function Marquee({ c, words }: { c: Ctx; words: string[] }) {
  const frame = useCurrentFrame()
  const fs = c.v ? 190 : 150
  const row = (k: number) => {
    const dir = k % 2 ? 1 : -1
    const text = Array.from({ length: 6 }, (_, i) => words[(i + k) % words.length]).join('  ·  ')
    return (
      <div key={k} style={{ whiteSpace: 'nowrap', fontFamily: c.f.display, fontWeight: 900, fontSize: fs, lineHeight: 1.05, letterSpacing: '-0.04em', transform: `translateX(${dir * (frame * 9) - (dir > 0 ? 2400 : 200)}px)`,
        color: k % 2 ? 'transparent' : c.pal.ink, WebkitTextStroke: k % 2 ? `4px ${c.pal.ink}` : undefined }}>{text}</div>
    )
  }
  const s = spring({ frame: frame - 18, fps: 30, config: { damping: 14, stiffness: 120 } })
  return (
    <AbsoluteFill style={{ justifyContent: 'center', overflow: 'hidden' }}>
      <div style={{ transform: 'rotate(-7deg) scale(1.2)', display: 'flex', flexDirection: 'column', gap: 6 }}>{[0, 1, 2, 3, 4, 5].slice(0, c.v ? 6 : 4).map(row)}</div>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: c.v ? '30px 46px' : '24px 36px', borderRadius: 36, background: c.pal.accent, transform: `scale(${s}) rotate(${(1 - s) * 8}deg)`, boxShadow: `0 40px 80px -30px ${alpha('#000000', 0.6)}` }}>
          <span style={{ fontFamily: c.f.display, fontWeight: 900, fontSize: c.v ? 96 : 72, color: c.pal.accentInk, letterSpacing: '-0.03em' }}>{c.name}</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

// ----------------------------------------------------------------------------------------------------------------- end

export function Cta({ c, cta, sub }: { c: Ctx; cta: string; sub: string }) {
  const frame = useCurrentFrame()
  const mark = spring({ frame: frame - 2, fps: 30, config: { damping: 12, stiffness: 140 } })
  const btn = spring({ frame: frame - 18, fps: 30, config: { damping: 12, stiffness: 150 } })
  const ring = (frame % 40) / 40
  const size = c.v ? 160 : 120
  return (
    <AbsoluteFill style={{ ...SAFE(c), alignItems: 'center', flexDirection: 'column', gap: c.v ? 36 : 24, textAlign: 'center' }}>
      <div style={{ position: 'relative', transform: `scale(${mark}) rotate(${(1 - mark) * -20}deg)` }}>
        <span style={{ position: 'absolute', inset: 0, borderRadius: size * 0.28, border: `4px solid ${c.pal.accent}`, transform: `scale(${1 + ring * 0.6})`, opacity: (1 - ring) * 0.6 }} />
        <Mark c={c} size={size} />
      </div>
      <Words text={c.name} fx="rise" start={8} stagger={4} style={{ ...H(c, fit(c.name, c.v ? 124 : 96, 14)), textAlign: 'center' }} pal={c.pal} />
      <Fade start={14} style={{ fontFamily: c.f.body, fontWeight: 500, fontSize: c.v ? 38 : 30, color: c.pal.muted }}>{c.url}</Fade>
      <div style={{ position: 'relative', overflow: 'hidden', marginTop: c.v ? 24 : 12, transform: `scale(${btn * (1 + 0.025 * Math.sin(Math.max(0, frame - 36) / 6))})`, opacity: Math.min(1, btn * 1.4), background: c.pal.accent, color: c.pal.accentInk, fontFamily: c.f.display, fontWeight: 800, fontSize: c.v ? 56 : 44, padding: c.v ? '32px 76px' : '24px 58px', borderRadius: 999, boxShadow: `0 30px 70px -24px ${alpha(c.pal.accent, 0.9)}` }}>
        {cta}
        <Sweep at={34} dur={26} strength={0.4} />
      </div>
      {sub && <Fade start={24} style={{ fontFamily: c.f.body, fontWeight: 500, fontSize: c.v ? 32 : 26, color: c.pal.muted }}>{sub}</Fade>}
    </AbsoluteFill>
  )
}


import type { TransitionPresentation } from '@remotion/transitions'
import { linearTiming, TransitionSeries } from '@remotion/transitions'
import { none } from '@remotion/transitions/none'
import { AbsoluteFill, Img, interpolate, OffthreadVideo, useCurrentFrame, type CalculateMetadataFunction } from 'remotion'
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight'
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { loadFont as loadFraunces } from '@remotion/google-fonts/Fraunces'
import { loadFont as loadNunito } from '@remotion/google-fonts/Nunito'
import { Background, EASE, Finish, Words, alpha, prog, themed, whip, zoomBlur, type Palette, type TextFx } from './fx'
import { Cta, fit, type Ctx } from './scenes'

/**
 * The Ad Studio's edit: the user's own videos and images, cut and ordered by the team (backend/app/studio.py). Video clips
 * keep their sound and get word-by-word subtitles from the transcript; a landscape clip in a vertical ad sits on a blurred
 * copy of itself; images move like a camera on them; title cards carry the hook; the end card is the call to action.
 */
export type Word = { w: string; t: number; d: number }  // seconds from the clip's start
export type Clip =
  | { kind: 'video'; src: string; from: number; to: number; words?: Word[]; title?: string; emphasis?: string; zoom?: 'in' | 'out' | 'none'; fit?: 'cover' | 'contain'; volume?: number }
  | { kind: 'image'; src: string; d: number; title?: string; sub?: string; motion?: 'in' | 'out' | 'left' | 'right' }
  | { kind: 'title'; d: number; text: string; sub?: string; emphasis?: string }
export type StudioProps = {
  format: 'vertical' | 'square'
  name: string
  url: string
  palette: Palette
  font: 'grotesk' | 'serif' | 'rounded'
  fx: TextFx
  transition: 'cut' | 'whip' | 'zoom'
  subtitles: { style: 'karaoke' | 'box' | 'clean'; position: 'bottom' | 'center' }
  clips: Clip[]
  cta: { text: string; sub: string } | null
}

const FPS = 30
const len = (c: Clip) => Math.max(15, Math.round((c.kind === 'video' ? c.to - c.from : c.d) * FPS))
const tlen = (p: StudioProps) => (p.transition === 'cut' ? 1 : 10)
export const studioDuration = (p: StudioProps) => p.clips.reduce((s, c) => s + len(c), 0) + (p.cta ? 90 : 0) - (p.clips.length + (p.cta ? 1 : 0) - 1) * tlen(p)

export const studioMetadata: CalculateMetadataFunction<StudioProps> = ({ props }) => ({
  durationInFrames: Math.max(30, studioDuration(props)), width: 1080, height: props.format === 'square' ? 1080 : 1920, fps: FPS,
})

const FONTS = {
  grotesk: () => ({ display: loadInterTight('normal', { weights: ['700', '800', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadInter('normal', { weights: ['500', '600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
  serif: () => ({ display: loadFraunces('normal', { weights: ['700', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadInter('normal', { weights: ['500', '600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
  rounded: () => ({ display: loadNunito('normal', { weights: ['800', '900'], subsets: ['latin', 'latin-ext'] }).fontFamily, body: loadNunito('normal', { weights: ['600', '700'], subsets: ['latin', 'latin-ext'] }).fontFamily }),
}
const cache: Record<string, { display: string; body: string }> = {}

/** Subtitles: a few words at a time, the one being said lit up. */
function Subtitles({ c, words, style, position }: { c: Ctx; words: Word[]; style: StudioProps['subtitles']['style']; position: 'bottom' | 'center' }) {
  const frame = useCurrentFrame()
  const t = frame / FPS
  const i = words.findIndex((w) => t >= w.t && t < w.t + Math.max(w.d, 0.12))
  const cur = i >= 0 ? i : words.findIndex((w) => w.t > t) - 1
  if (cur < 0 || !words[cur] || t > words[words.length - 1].t + words[words.length - 1].d + 0.4) return null
  const start = Math.floor(cur / 4) * 4
  const chunk = words.slice(start, start + 4)
  const fs = c.v ? 74 : 58
  const chunkIn = prog(frame, Math.round(chunk[0].t * FPS), 6)
  return (
    <AbsoluteFill style={{ justifyContent: position === 'center' ? 'center' : 'flex-end', alignItems: 'center', padding: c.v ? '0 70px 720px' : '0 60px 90px' }}>
      <div style={{ textAlign: 'center', fontFamily: c.f.display, fontWeight: 900, fontSize: fs, lineHeight: 1.12, letterSpacing: '-0.01em', transform: `scale(${0.92 + 0.08 * chunkIn})`, opacity: chunkIn,
        ...(style === 'box' ? { background: alpha('#000000', 0.62), padding: '14px 26px', borderRadius: 22 } : {}),
        textShadow: style === 'box' ? 'none' : '0 4px 18px rgba(0,0,0,.75), 0 0 2px rgba(0,0,0,.9)' }}>
        {chunk.map((w, k) => {
          const on = start + k === cur
          return (
            <span key={k} style={{ display: 'inline-block', margin: '0 0.14em', padding: style === 'karaoke' ? '0 0.12em' : 0, borderRadius: '0.16em', transform: `scale(${on ? 1.08 : 1})`,
              color: style === 'karaoke' ? (on ? c.pal.accentInk : '#FFFFFF') : on ? c.pal.accent : '#FFFFFF', background: style === 'karaoke' && on ? c.pal.accent : 'transparent', textShadow: style === 'karaoke' && on ? 'none' : undefined }}>{w.w}</span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

function Title({ c, text, emphasis, top }: { c: Ctx; text: string; emphasis?: string; top: boolean }) {
  return (
    <AbsoluteFill style={{ padding: c.v ? (top ? '300px 80px 0' : '0 80px') : '70px 70px 0', justifyContent: top ? 'flex-start' : 'center' }}>
      <Words text={text} emphasis={emphasis} fx={c.fx} start={3} style={{ margin: 0, fontFamily: c.f.display, fontWeight: 900, fontSize: fit(text, c.v ? 96 : 76, 32), lineHeight: 1.04, letterSpacing: '-0.03em', color: top ? '#FFFFFF' : c.pal.ink, textShadow: top ? '0 6px 30px rgba(0,0,0,.6)' : undefined }} pal={c.pal} />
    </AbsoluteFill>
  )
}

function VideoClip({ c, clip, d, subs }: { c: Ctx; clip: Extract<Clip, { kind: 'video' }>; d: number; subs: StudioProps['subtitles'] }) {
  const frame = useCurrentFrame()
  const z = clip.zoom === 'in' ? interpolate(frame, [0, d], [1, 1.12]) : clip.zoom === 'out' ? interpolate(frame, [0, d], [1.12, 1]) : 1
  const startFrom = Math.round(clip.from * FPS)
  const contain = clip.fit === 'contain'
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {contain && (
        <AbsoluteFill style={{ filter: 'blur(40px) brightness(0.55)', transform: 'scale(1.25)' }}>
          <OffthreadVideo src={clip.src} startFrom={startFrom} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ transform: `scale(${z})` }}>
        <OffthreadVideo src={clip.src} startFrom={startFrom} volume={clip.volume ?? 1} style={{ width: '100%', height: '100%', objectFit: contain ? 'contain' : 'cover' }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,.35) 0%, transparent 28%, transparent 60%, rgba(0,0,0,.45) 100%)' }} />
      {clip.title && <Title c={c} text={clip.title} emphasis={clip.emphasis} top />}
      {clip.words && clip.words.length > 0 && <Subtitles c={c} words={clip.words} style={subs.style} position={subs.position} />}
    </AbsoluteFill>
  )
}

function ImageClip({ c, clip, d }: { c: Ctx; clip: Extract<Clip, { kind: 'image' }>; d: number }) {
  const frame = useCurrentFrame()
  const p = interpolate(frame, [0, d], [0, 1], { easing: EASE })
  const m = clip.motion ?? 'in'
  const s = m === 'out' ? 1.18 - 0.14 * p : 1.04 + 0.14 * p
  const x = m === 'left' ? 4 - 8 * p : m === 'right' ? -4 + 8 * p : 0
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <AbsoluteFill style={{ filter: 'blur(36px) brightness(0.5)', transform: 'scale(1.2)' }}><Img src={clip.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${s}) translateX(${x}%)` }}><Img src={clip.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></AbsoluteFill>
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,.4) 0%, transparent 30%, transparent 62%, rgba(0,0,0,.5) 100%)' }} />
      {clip.title && <Title c={c} text={clip.title} top />}
      {clip.sub && (
        <AbsoluteFill style={{ justifyContent: 'flex-end', padding: c.v ? '0 80px 720px' : '0 60px 90px' }}>
          <div style={{ fontFamily: c.f.body, fontWeight: 700, fontSize: c.v ? 46 : 36, color: '#FFFFFF', textShadow: '0 3px 14px rgba(0,0,0,.8)', opacity: prog(frame, 8, 14) }}>{clip.sub}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  )
}

function TitleCard({ c, clip }: { c: Ctx; clip: Extract<Clip, { kind: 'title' }> }) {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ padding: c.v ? '300px 90px 670px' : '120px 80px', justifyContent: 'center', gap: 30 }}>
      <Words text={clip.text} emphasis={clip.emphasis} fx={c.fx} start={3} style={{ margin: 0, fontFamily: c.f.display, fontWeight: 900, fontSize: fit(clip.text, c.v ? 112 : 88, 30), lineHeight: 1.03, letterSpacing: '-0.03em', color: c.pal.ink }} pal={c.pal} />
      {clip.sub && <div style={{ fontFamily: c.f.body, fontWeight: 600, fontSize: c.v ? 44 : 34, color: c.pal.muted, opacity: prog(frame, 16, 16), lineHeight: 1.3 }}>{clip.sub}</div>}
    </AbsoluteFill>
  )
}

export function Studio(p: StudioProps) {
  const pal = themed(p.palette, 'auto')
  const c: Ctx = { v: p.format !== 'square', f: (cache[p.font] ??= (FONTS[p.font] ?? FONTS.grotesk)()), pal, fx: p.fx, name: p.name, url: p.url,
    labels: { before: '', after: '', pov: 'POV:', stop: '', notes: '', now: '', chat: '' } }
  const t = tlen(p)
  const present = () => (p.transition === 'cut' ? none() : p.transition === 'zoom' ? zoomBlur() : whip()) as unknown as TransitionPresentation<Record<string, unknown>>
  const items = [...p.clips.map((clip) => ({ d: len(clip), node: clip.kind === 'video' ? <VideoClip c={c} clip={clip} d={len(clip)} subs={p.subtitles} /> : clip.kind === 'image' ? <ImageClip c={c} clip={clip} d={len(clip)} /> : <TitleCard c={c} clip={clip} /> })),
    ...(p.cta ? [{ d: 90, node: <Cta c={c} cta={p.cta.text} sub={p.cta.sub} /> }] : [])]
  return (
    <AbsoluteFill style={{ background: pal.bg, fontFamily: c.f.body }}>
      <Background pal={pal} kind="blobs" />
      <TransitionSeries>
        {items.flatMap((it, i) => [
          ...(i ? [<TransitionSeries.Transition key={`t${i}`} presentation={present()} timing={linearTiming({ durationInFrames: t })} />] : []),
          <TransitionSeries.Sequence key={`s${i}`} durationInFrames={it.d}>{it.node}</TransitionSeries.Sequence>,
        ])}
      </TransitionSeries>
      <Finish dark />
    </AbsoluteFill>
  )
}

export const STUDIO_SAMPLE: StudioProps = {
  format: 'vertical', name: 'Tably', url: 'tablyteam.com', palette: { bg: '#10161F', surface: '#1B2430', ink: '#F1F4F8', muted: '#A9B4C2', accent: '#F5A524', accentInk: '#10161F' },
  font: 'grotesk', fx: 'rise', transition: 'whip', subtitles: { style: 'karaoke', position: 'bottom' },
  clips: [{ kind: 'title', d: 2.5, text: 'Tu idea, hecha app', emphasis: 'hecha app' }], cta: { text: 'Probalo gratis', sub: '' },
}

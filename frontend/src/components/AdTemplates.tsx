import { Player, Thumbnail } from '@remotion/player'
import { Check, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Ad, durationOf, type AdProps, type FontKey, type Screen, type TemplateSpec } from '@ads/Ad'
import { contrast, mix, type BgKind, type Palette, type TextFx, type Theme } from '@ads/fx'
import catalog from '@ads/templates.json'
import { useT } from '../lib/i18n'

type Tpl = (typeof catalog.templates)[number]
export type AppScreen = { url: string; kind: 'phone' | 'desktop'; ratio: number; bg: string }
export type AppSummary = { name?: string; one_liner?: string; features?: string[] } | null

const PALETTE = { bg: '#10161F', surface: '#1B2430', ink: '#F1F4F8', muted: '#A9B4C2', accent: '#F5A524', accentInk: '#10161F' }

/** The user's style for the ad: colours (a template theme over the app's palette, or their own), font, background, text motion. */
export type Look = { theme?: Theme; palette?: Palette; font?: FontKey; bg?: BgKind; fx?: TextFx }

/** A full palette from two colours the user picked. */
export function paletteFrom(bg: string, accent: string): Palette {
  const ink = contrast('#0E1217', bg) >= contrast('#FFFFFF', bg) ? '#14181D' : '#F4F6F8'
  return { bg, surface: mix(bg, ink, 0.07), ink, muted: mix(ink, bg, 0.38), accent, accentInk: contrast('#0E1217', accent) >= contrast('#FFFFFF', accent) ? '#0E1217' : '#FFFFFF' }
}

/** A template played with sample copy, the app's name and real screens (when they are captured): what the gallery shows. */
function preview(t: Tpl, en: boolean, summary: AppSummary, screens: AppScreen[], look: Look, appPalette: Palette | null): AdProps {
  const s = catalog.sample[en ? 'en' : 'es']
  const feats = (summary?.features ?? []).filter((f) => f.length <= 34).slice(0, 3)
  const shots: Screen[] = screens.length
    ? screens.map((x, i) => ({ src: x.url, kind: x.kind, ratio: x.ratio, bg: x.bg, caption: s.captions[i % s.captions.length] }))
    : []
  return {
    format: 'vertical', name: summary?.name || 'Turnera Luna', url: 'tu-app.tably.app', font: look.font ?? 'grotesk', palette: look.palette ?? appPalette ?? PALETTE,
    template: { id: t.id, scenes: t.scenes, style: { ...t.style, ...(look.palette ? { theme: look.theme ?? 'auto' } : {}), ...(look.theme ? { theme: look.theme } : {}), ...(look.bg ? { bg: look.bg } : {}), ...(look.fx ? { fx: look.fx } : {}), ...(look.font ? { font: look.font } : {}) } } as TemplateSpec,
    labels: { before: en ? 'Before' : 'Antes', after: en ? 'Now' : 'Ahora', pov: 'POV:', stop: en ? 'Stop' : 'Basta de', notes: en ? 'Notes' : 'Notas', now: en ? 'now' : 'ahora', chat: en ? 'Sam' : 'Caro' },
    hook: summary?.one_liner && summary.one_liner.length <= 60 ? summary.one_liner : s.hook, emphasis: summary?.one_liner ? '' : s.emphasis, sub: s.sub,
    points: feats.length === 3 ? feats : s.points, screens: shots, cta: s.cta, ctaSub: s.cta_sub, lines: s.lines, chat: s.chat, notesTitle: s.notes_title, notes: s.notes,
    before: s.before, after: s.after, stat: s.stat, query: s.query, notifs: s.notifs, pov: s.pov, problem: s.problem, steps: s.steps, question: s.question, answer: s.answer, marquee: s.marquee,
  }
}

/** One template: a still until the pointer is on it, then it plays. */
function Card({ t, props, selected, onPick, why, rank }: { t: Tpl; props: AdProps; selected: boolean; onPick: () => void; why?: string; rank?: number }) {
  const T = useT()
  const [hot, setHot] = useState(false)
  const n = useMemo(() => durationOf(props), [props])
  const common = { component: Ad, inputProps: props, durationInFrames: n, compositionWidth: 1080, compositionHeight: 1920, fps: 30, style: { width: '100%', aspectRatio: '9 / 16' } } as const
  return (
    <button type="button" onClick={onPick} onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)} onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      className={`group flex w-full flex-col overflow-hidden rounded-2xl border bg-surface text-left transition ${selected ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-accent/60'}`}>
      <div className="relative overflow-hidden bg-black">
        {hot ? <Player {...common} autoPlay loop initiallyMuted acknowledgeRemotionLicense /> : <Thumbnail {...common} frameToDisplay={Math.min(58, n - 1)} />}
        {rank !== undefined && <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-bold text-white"><Sparkles size={10} /> {rank + 1}</span>}
        {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white"><Check size={14} /></span>}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <span className="text-[13px] font-bold leading-tight text-ink">{T(t.name.es, t.name.en)}</span>
        <span className="text-[11.5px] leading-snug text-ink-3">{why ?? T(t.desc.es, t.desc.en)}</span>
      </div>
    </button>
  )
}

/** The 5 templates recommended for this app and, on demand, the whole catalogue with filters. */
export default function TemplatePicker({ recommended, summary, screens, selected, onPick, look, onLook, appPalette }: {
  recommended: { id: string; why: string }[]; summary: AppSummary; screens: AppScreen[]; selected: string | null; onPick: (id: string) => void
  look: Look; onLook: (l: Look) => void; appPalette: Palette | null
}) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [all, setAll] = useState(false)
  const [goal, setGoal] = useState<'all' | 'conversion' | 'awareness'>('all')
  const byId = useMemo(() => Object.fromEntries(catalog.templates.map((t) => [t.id, t])), [])
  const props = useMemo(() => Object.fromEntries(catalog.templates.map((t) => [t.id, preview(t, en, summary, screens, look, appPalette)])), [en, summary, screens, look, appPalette])
  const recs = recommended.filter((r) => byId[r.id])
  const rest = catalog.templates.filter((t) => goal === 'all' || t.goal === goal)
  const sel = selected ? byId[selected] : null
  return (
    <div className="flex flex-col gap-4">
      <StyleBar look={look} onLook={onLook} appPalette={appPalette} />
      {sel && (
        <div className="flex flex-col gap-4 rounded-2xl border border-accent/40 bg-accent-soft/40 p-3 sm:flex-row">
          <div className="mx-auto w-[200px] shrink-0 overflow-hidden rounded-xl bg-black sm:mx-0">
            <Player component={Ad} inputProps={props[sel.id]} durationInFrames={durationOf(props[sel.id])} compositionWidth={1080} compositionHeight={1920} fps={30} style={{ width: '100%', aspectRatio: '9 / 16' }} controls autoPlay loop initiallyMuted acknowledgeRemotionLicense />
          </div>
          <div className="min-w-0 text-[13px]">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent">{T('Plantilla elegida', 'Chosen template')}</div>
            <div className="mt-0.5 text-[16px] font-bold text-ink">{T(sel.name.es, sel.name.en)}</div>
            <p className="mt-1 text-ink-2">{T(sel.desc.es, sel.desc.en)}</p>
            <p className="mt-2 text-ink-3"><b className="text-ink-2">{T('Por qué funciona:', 'Why it works:')}</b> {T(sel.why.es, sel.why.en)}</p>
            <p className="mt-2 text-[12px] text-ink-4">{T('La vista previa usa texto de ejemplo; tu anuncio sale con el guion que escribe el equipo desde tu app.', 'The preview uses sample copy; your ad comes out with the script the team writes from your app.')}</p>
          </div>
        </div>
      )}
      {recs.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3"><Sparkles size={13} className="text-accent" /> {T('Recomendadas para tu app', 'Recommended for your app')}</div>
          <div className="grid grid-cols-2 gap-2.5 min-[520px]:grid-cols-3 min-[760px]:grid-cols-5">
            {recs.map((r, i) => <Card key={r.id} t={byId[r.id]} props={props[r.id]} selected={selected === r.id} onPick={() => onPick(r.id)} why={r.why} rank={i} />)}
          </div>
        </div>
      )}
      <div>
        <button type="button" onClick={() => setAll((v) => !v)} className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:text-accent">
          {all ? T('Ocultar el catálogo', 'Hide the catalogue') : T(`Ver las ${catalog.templates.length} plantillas`, `See all ${catalog.templates.length} templates`)}
        </button>
        {all && (
          <div className="mt-3">
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
              {([['all', 'Todas', 'All'], ['conversion', 'Para vender', 'To sell'], ['awareness', 'Para darse a conocer', 'For awareness']] as const).map(([k, es, en2]) => (
                <button key={k} type="button" onClick={() => setGoal(k)} className={`rounded-full border px-3 py-1 ${goal === k ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent'}`}>{T(es, en2)}</button>
              ))}
              <span className="ml-auto text-[11.5px] text-ink-4">{T(`Actualizadas el ${catalog.updated} · se renuevan cada mes`, `Updated ${catalog.updated} · renewed monthly`)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5 min-[520px]:grid-cols-3 min-[760px]:grid-cols-5">
              {rest.map((t) => <Card key={t.id} t={t} props={props[t.id]} selected={selected === t.id} onPick={() => onPick(t.id)} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const CHIP = 'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] transition'
const chip = (on: boolean) => `${CHIP} ${on ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent'}`
const Dot = ({ c }: { c: string }) => <span className="h-3.5 w-3.5 rounded-full border border-black/15" style={{ background: c }} />

/** Colours, font, background and text motion of the ad. Every choice plays at once in the previews. */
function StyleBar({ look, onLook, appPalette }: { look: Look; onLook: (l: Look) => void; appPalette: Palette | null }) {
  const T = useT()
  const app = appPalette ?? PALETTE
  const custom = look.palette && look.palette !== appPalette ? look.palette : null
  const [bg, setBg] = useState(custom?.bg ?? '#111827')
  const [accent, setAccent] = useState(custom?.accent ?? app.accent)
  const colors: [string, string, Look, string[]][] = [
    ['app', T('Colores de tu app', 'Your app colours'), { palette: appPalette ?? undefined, theme: 'auto' }, [app.bg, app.accent]],
    ['tpl', T('Los de cada plantilla', 'Each template’s'), {}, []],
    ['dark', T('Noche', 'Night'), { theme: 'dark' }, ['#0E1217', app.accent]],
    ['light', T('Claro', 'Light'), { theme: 'light' }, ['#F5F3EE', app.accent]],
    ['accent', T('Fondo de marca', 'Brand background'), { theme: 'accent' }, [app.accent, app.bg]],
  ]
  const which = custom ? 'custom' : look.palette ? 'app' : look.theme ?? 'tpl'
  const set = (patch: Look, keep: (keyof Look)[] = ['font', 'bg', 'fx']) => onLook({ ...Object.fromEntries(keep.filter((k) => look[k]).map((k) => [k, look[k]])), ...patch })
  const row = (label: string, children: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-1.5"><span className="w-full text-[11px] font-semibold uppercase tracking-wide text-ink-3 min-[560px]:w-24">{label}</span>{children}</div>
  )
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3">
      {row(T('Colores', 'Colours'), <>
        {colors.map(([k, l, patch, dots]) => <button key={k} type="button" onClick={() => set(patch)} className={chip(which === k)}>{dots.map((c, i) => <Dot key={i} c={c} />)}{l}</button>)}
        <span className={`${chip(which === 'custom')} cursor-default`}>
          <input type="color" value={bg} onChange={(e) => { setBg(e.target.value); set({ palette: paletteFrom(e.target.value.toUpperCase(), accent), theme: 'auto' }) }} className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0" aria-label={T('Color de fondo', 'Background colour')} />
          <input type="color" value={accent} onChange={(e) => { setAccent(e.target.value); set({ palette: paletteFrom(bg, e.target.value.toUpperCase()), theme: 'auto' }) }} className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0" aria-label={T('Color de acento', 'Accent colour')} />
          {T('Elegir', 'Pick')}
        </span>
      </>)}
      {row(T('Letras', 'Type'), ([[undefined, T('Según plantilla', 'Per template')], ['grotesk', T('Moderna', 'Modern')], ['serif', T('Editorial', 'Editorial')], ['rounded', T('Amigable', 'Friendly')]] as [FontKey | undefined, string][]).map(([k, l]) => (
        <button key={l} type="button" onClick={() => onLook({ ...look, font: k })} className={chip(look.font === k)} style={{ fontFamily: k === 'serif' ? 'Georgia, serif' : k === 'rounded' ? 'ui-rounded, system-ui' : undefined }}>{l}</button>
      )))}
      {row(T('Fondo', 'Background'), ([[undefined, T('Según plantilla', 'Per template')], ['blobs', T('Luces', 'Lights')], ['gradient', T('Degradé', 'Gradient')], ['grid', T('Cuadrícula', 'Grid')], ['solid', T('Liso', 'Plain')]] as [BgKind | undefined, string][]).map(([k, l]) => (
        <button key={l} type="button" onClick={() => onLook({ ...look, bg: k })} className={chip(look.bg === k)}>{l}</button>
      )))}
      {row(T('Texto', 'Text'), ([[undefined, T('Según plantilla', 'Per template')], ['rise', T('Sube con desenfoque', 'Blur rise')], ['pop', T('Rebote', 'Pop')], ['box', T('Resaltado', 'Highlight box')], ['type', T('Máquina de escribir', 'Typewriter')]] as [TextFx | undefined, string][]).map(([k, l]) => (
        <button key={l} type="button" onClick={() => onLook({ ...look, fx: k })} className={chip(look.fx === k)}>{l}</button>
      )))}
    </div>
  )
}

import DOMPurify from 'dompurify'
import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, FileText, Loader2, Palette, RefreshCw, Send, Sparkles, Wand2 } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'
import { reconnectBuild, useBuild } from '../buildStore'
import { api } from '../lib/api'
import { tr, useLang, useT } from '../lib/i18n'
import { toast } from './Toast'
import { BuilderBusyNotice } from './BlockedNotice'

const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string)

// summaries already fetched in this tab, by build + design content key (the server caches them too)
const cache = new Map<string, { text: string | null; reason?: string; model?: string }>()

/**
 * The design, for anyone: what the current design is in plain words (a model reads DESIGN.md + the mockup), the
 * mockup itself, and a box to ask the designer for specific changes at any moment of the build.
 */
// a direction is judged as a desktop page: rendered at 1280 px and scaled down to its card
function DirectionFrame({ title, html }: { title: string; html: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  const [loaded, setLoaded] = useState(false)
  const scale = size.w ? size.w / 1280 : 1
  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden bg-surface-2">
      {!loaded && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-3">{tr('Cargando…', 'Loading…')}</div>}
      <iframe title={title} sandbox="allow-scripts" srcDoc={html} onLoad={() => setLoaded(true)} className="absolute left-0 top-0 origin-top-left border-0" style={{ width: 1280, height: size.h / scale, transform: `scale(${scale})` }} />
    </div>
  )
}

function DirectionsPicker() {
  const T = useT()
  const b = useBuild()
  const [wish, setWish] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (body: { index?: number; feedback?: string }) => {
    setBusy(true)
    try {
      await api.buildDesignDirection(b.id!, body, b.sessionId)
      useBuild.getState().set({ status: 'connecting', directions: [] })
      reconnectBuild(b.id!)
    } catch (e) {
      toast.error(tr('No se pudo elegir', 'Could not choose'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface p-4">
      <h3 className="text-[22px] leading-tight">{T('Elegí cómo querés que se vea', 'Choose how you want it to look')}</h3>
      <p className="mt-1 text-[13px] text-ink-2">{T('Es la pantalla principal en tres estilos. Todavía no hay código: el diseño completo sale de la que elijas.', 'This is the main screen in three styles. No code yet: the full design comes from the one you choose.')}</p>
      <div className="mt-4 grid min-h-[70vh] flex-1 grid-cols-1 gap-3 xl:grid-cols-3">
        {b.directions.map((d, i) => (
          <div key={i} className="flex min-h-[70vh] min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-sm">
            <DirectionFrame title={d.name} html={d.html} />
            <div className="border-t border-line p-3">
              <div className="text-sm font-semibold text-ink">{d.name}</div>
              {d.why && <p className="mt-0.5 text-[12.5px] text-ink-2">{d.why}</p>}
              <button type="button" disabled={busy} onClick={() => send({ index: i, feedback: wish.trim() || undefined })} className="mt-2 w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50">{T('Elegir esta', 'Choose this one')}</button>
              <button type="button" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(d.html); w.document.close() } }} className="mt-1.5 w-full rounded-xl border border-line bg-surface px-4 py-1.5 text-[12.5px] text-ink-2 transition hover:text-ink">{T('Verla grande', 'See it large')}</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-xl border border-line bg-paper p-3">
        <div className="text-[13px] font-semibold text-ink">{T('¿Le cambiarías algo o no te convence ninguna?', 'Would you change something, or none of them work?')}</div>
        <textarea value={wish} onChange={(e) => setWish(e.target.value)} rows={2} placeholder={T('Ej.: más sobria, con más foto, parecida a la web de tal marca…', 'E.g.: more restrained, more photos, like such-and-such brand’s site…')} className="mt-2 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent" />
        <button type="button" disabled={busy || !wish.trim()} onClick={() => send({ feedback: wish.trim() })} className="mt-2 rounded-xl border border-accent/50 bg-paper px-4 py-1.5 text-[13px] font-semibold text-accent disabled:opacity-40">{T('Ninguna: ver otras tres', 'None: see three others')}</button>
        <span className="ml-3 text-[11.5px] text-ink-3">{T('Si elegís una, lo que escribiste acá se aplica a esa.', 'If you choose one, what you wrote here applies to it.')}</span>
      </div>
    </div>
  )
}

export default function DesignPanel() {
  const T = useT()
  const lang = useLang()
  const b = useBuild()
  const designKey = `${b.id}|${b.designHtml?.length ?? 0}|${b.files['design/DESIGN.md']?.size ?? 0}|${lang}`
  const [summary, setSummary] = useState<{ text: string | null; reason?: string; model?: string } | null>(() => cache.get(designKey) ?? null)
  const [loading, setLoading] = useState(false)
  const [ask, setAsk] = useState('')
  const [sending, setSending] = useState(false)
  const running = b.status === 'running' || b.status === 'connecting' || b.status === 'reviewing'
  const hasDesign = !!b.designHtml || !!b.files['design/DESIGN.md']

  const load = (refresh = false) => {
    if (!b.sessionId || !b.id || !hasDesign) return
    const hit = refresh ? null : cache.get(designKey)
    if (hit) { setSummary(hit); return }
    setLoading(true)
    api.designSummary(b.sessionId, b.id, lang, refresh)
      .then((d) => { cache.set(designKey, d); setSummary(d) })
      .catch((e) => toast.error(tr('No pude describir el diseño', 'Could not describe the design'), (e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [designKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (text: string) => {
    if (!b.id || !text.trim()) return
    setSending(true)
    try {
      const r = await api.designRequest(b.id, text.trim(), b.sessionId)
      setAsk('')
      if (r.mode !== 'redo') {
        // the change runs on the builder: a finished build has no open socket, so attach to see it work
        useBuild.getState().set({ status: 'connecting', error: null, pane: 'code', paneOpen: false })
        reconnectBuild(b.id)
      }
      toast.ok(
        tr('Pedido de diseño enviado', 'Design request sent'),
        r.mode === 'redo' ? tr('El diseñador hace otra ronda con tu pedido.', 'The designer does another round with your request.') : r.mode === 'queued' ? tr('Lo toma en el próximo turno.', 'It picks it up on the next turn.') : tr('La construcción se reanudó para aplicarlo.', 'The build resumed to apply it.'),
      )
    } catch (e) {
      toast.error(tr('No se pudo pedir el cambio', 'Could not request the change'), (e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const QUICK = [
    [tr('Más contraste y legibilidad', 'More contrast and legibility'), tr('Subí el contraste general y el tamaño de la tipografía de lectura; que todo se lea bien al sol y en pantallas chicas.', 'Raise the overall contrast and the reading font size; everything must be readable in sunlight and on small screens.')],
    [tr('Más aire', 'More breathing room'), tr('Más espacio entre secciones y dentro de las tarjetas; menos elementos por pantalla; jerarquía visual más clara.', 'More space between sections and inside cards; fewer elements per screen; clearer visual hierarchy.')],
    [tr('Modo oscuro', 'Dark mode'), tr('Agregá modo oscuro completo que siga la preferencia del sistema, con un conmutador en la interfaz.', 'Add a full dark mode following the system preference, with a switch in the interface.')],
    [tr('Paleta más sobria', 'Calmer palette'), tr('Paleta más sobria y profesional: neutros cálidos con un solo color de acento; menos saturación.', 'A calmer, more professional palette: warm neutrals with a single accent color; less saturation.')],
    [tr('Animaciones sutiles', 'Subtle motion'), tr('Transiciones suaves al cambiar de pantalla y al cargar datos; nada que distraiga; respetá reduced-motion.', 'Smooth transitions between screens and when data loads; nothing distracting; respect reduced-motion.')],
    [tr('Pantalla de inicio más clara', 'Clearer home screen'), tr('Que la pantalla de inicio muestre primero lo más importante, con una sola acción principal bien visible.', 'The home screen should show the most important thing first, with a single, very visible primary action.')],
  ]

  if (b.directions.length) return <DirectionsPicker />
  if (b.previews && !hasDesign) {
    const steps = [['buscando', T('Ver qué referencias tenemos', 'Check which references we have')], ['bajando', T('Buscar las que faltan', 'Find the missing ones')], ['generando', T('Generar tus tres opciones', 'Generate your three options')]]
    const at = steps.findIndex(([id]) => id === b.previews!.stage)
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto bg-surface p-8">
        <h3 className="text-[26px] leading-tight">{T('Construyendo previews', 'Building previews')}</h3>
        <p className="mt-2 text-[14px] text-ink-2">{b.previews.text}</p>
        <ol className="mt-6 flex flex-col gap-2 text-[14px]">
          {steps.map(([id, label], i) => <li key={id} className={i === at ? 'font-semibold text-ink' : i < at ? 'text-ink-3 line-through' : 'text-ink-4'}>{i + 1}. {label}</li>)}
        </ol>
        <p className="mt-6 text-[12.5px] text-ink-3">{T('Tarda unos minutos. Todavía no se escribe código y podés dejar esta pantalla: te va a esperar.', 'This takes a few minutes. No code is being written yet and you can leave this screen: it will wait for you.')}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface md:flex-row md:overflow-visible">
      {/* left: the design in plain words + the request box */}
      <div className="flex w-full shrink-0 flex-col border-b border-line md:w-[420px] md:border-b-0 md:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-5">
          <BuilderBusyNotice what={T('Tu pedido de diseño se está aplicando.', 'Your design request is being applied.')} className="mb-4" />
          <div className="text-[10.5px] uppercase tracking-[0.3em] text-accent">{T('El diseño actual', 'The current design')}</div>
          <h3 className="mt-1 text-[22px] leading-tight">{T('Qué tiene el diseño, en palabras simples', 'What the design has, in plain words')}</h3>
          {!hasDesign ? (
            <div className="mt-4 rounded-2xl border border-dashed border-line bg-paper px-4 py-5 text-[13px] text-ink-2">
              <div className="flex items-center gap-2 font-semibold text-ink"><Palette size={15} className="text-accent" /> {T('Todavía no hay maqueta', 'No mockup yet')}</div>
              <p className="mt-1.5">{T('El diseñador la crea antes de escribir código cuando la construcción arranca con fase de diseño. También podés pedirla ahora:', 'The designer creates it before any code when the build starts with a design phase. You can also ask for it now:')}</p>
              <button disabled={sending || !b.id} onClick={() => send(tr('Creá design/mockup.html (maqueta hi-fi navegable de las pantallas principales) y design/DESIGN.md (sistema visual: paleta, tipografía, componentes, estados) a partir del producto tal como está construido.', 'Create design/mockup.html (a clickable hi-fi mockup of the main screens) and design/DESIGN.md (visual system: palette, typography, components, states) from the product as built.'))} className="mt-3 flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} {T('Pedir una maqueta', 'Ask for a mockup')}
              </button>
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-line bg-paper p-4 shadow-[0_12px_28px_-18px_rgba(30,38,34,.35)]">
              {loading && !summary?.text ? (
                <div className="flex items-center gap-2 py-4 text-[13px] text-ink-2"><Loader2 size={16} className="animate-spin text-accent" /> {T('Un modelo está leyendo el diseño para explicártelo…', 'A model is reading the design to explain it to you…')}</div>
              ) : summary?.text ? (
                <article className="md text-[13.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: md(summary.text) }} />
              ) : (
                <div className="text-[13px] text-ink-3">{summary?.reason === 'no_key' ? T('Cargá una API key en Configuración para que un modelo te describa el diseño.', 'Add an API key in Settings so a model can describe the design.') : T('Sin descripción todavía.', 'No description yet.')}</div>
              )}
              <div className="mt-3 flex items-center gap-3 border-t border-line pt-2.5 text-[11px] text-ink-3">
                {summary?.model && <span>{summary.model}</span>}
                <button onClick={() => load(true)} disabled={loading} className="ml-auto flex items-center gap-1 transition hover:text-ink disabled:opacity-40"><RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> {T('volver a describir', 'describe again')}</button>
                {b.files['design/DESIGN.md'] && <button onClick={() => useBuild.getState().set({ selected: 'design/DESIGN.md', pane: 'code', paneOpen: true })} className="flex items-center gap-1 transition hover:text-ink"><FileText size={11} /> DESIGN.md</button>}
              </div>
            </div>
          )}
        </div>

        {/* the request box */}
        <div className="shrink-0 border-t border-line bg-paper p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold"><Sparkles size={14} className="text-accent" /> {T('Pedile algo al diseñador', 'Ask the designer for something')}</div>
          {b.files['research/REFERENCES.md'] && (
            <button
              disabled={sending || !b.id}
              onClick={() => send(tr('Llevá TODAS las pantallas al nivel del «Plano visual objetivo» de research/REFERENCES.md, mirando las capturas reales de research/shots/: reproducí región por región la distribución y proporciones, los componentes y su estilo, la paleta (hex), la tipografía equivalente, el espaciado, los estados, las interacciones y el comportamiento móvil. Pulido final: nada desalineado, nada a medias. Con elementos propios, sin assets, marcas ni textos de terceros. Actualizá design/mockup.html y design/DESIGN.md para que coincidan.', 'Bring EVERY screen to the level of the «Target visual blueprint» in research/REFERENCES.md, looking at the real captures in research/shots/: reproduce region by region the layout and proportions, components and their style, palette (hex), equivalent typography, spacing, states, interactions and mobile behaviour. Final polish: nothing misaligned, nothing half done. With our own elements, no third-party assets, brands or texts. Update design/mockup.html and design/DESIGN.md to match.'))}
              className="mb-2 flex h-9 w-full items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} {T('Llevar el diseño al nivel del referente', 'Bring the design to the reference’s level')}
            </button>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK.map(([label, text]) => (
              <button key={label} disabled={sending} onClick={() => setAsk(text)} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-2 shadow-sm transition hover:bg-accent-soft hover:border-accent hover:text-accent disabled:opacity-40">{label}</button>
            ))}
          </div>
          <div className="mt-2 flex items-end gap-2 rounded-xl border border-line bg-surface px-3 py-2 shadow-sm focus-within:border-accent">
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(ask) } }}
              rows={3}
              placeholder={T('Ej.: el botón principal más grande y verde, la lista de días como tarjetas con el ícono del clima a la izquierda…', 'E.g.: a bigger green primary button, the day list as cards with the weather icon on the left…')}
              className="flex-1 resize-none bg-transparent text-[13px] outline-none"
              disabled={!b.id || sending}
            />
            <button onClick={() => send(ask)} disabled={!ask.trim() || sending || !b.id} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm transition hover:brightness-110 disabled:opacity-40" title={`${T('Pedir', 'Request')} (⌘↵)`}>{sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}</button>
          </div>
          <div className="mt-1.5 text-[11px] text-ink-4">
            {b.status === 'design_review' ? T('Estás en la revisión del diseño: el diseñador hace otra ronda con lo que pidas.', 'You are in the design review: the designer does another round with what you ask.') : running ? T('La construcción está corriendo: lo toma en el próximo turno.', 'The build is running: it picks it up on the next turn.') : T('Se reanuda la construcción, se actualiza la maqueta y se aplica en la app real.', 'The build resumes, the mockup is updated and the change is applied to the real app.')}
          </div>
        </div>
      </div>

      {/* right: the mockup */}
      <div className="flex min-h-[75vh] min-w-0 flex-1 flex-col p-3 md:min-h-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/70 px-3">
            <span className="h-2 w-2 rounded-full bg-[#E6A19A]" /><span className="h-2 w-2 rounded-full bg-[#E9C97A]" /><span className="h-2 w-2 rounded-full bg-[#9FCDA8]" />
            <span className="ml-2 font-mono text-[10px] text-ink-3">design/mockup.html · {T('maqueta hi-fi del Product Designer', 'hi-fi mockup by the Product Designer')}</span>
            {b.designRounds > 0 && <span className="ml-2 rounded-full border border-line bg-surface px-1.5 text-[10px] text-ink-3">{T('ronda', 'round')} {b.designRounds + 1}</span>}
            {b.designHtml && <button onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(b.designHtml!); w.document.close() } }} className="ml-auto flex items-center gap-1 text-[11px] text-ink-3 transition hover:text-accent"><ExternalLink size={11} /> {T('abrir en pestaña', 'open in tab')}</button>}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            {b.designHtml ? (
              <motion.iframe key="mock" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} title={T('Diseño', 'Design')} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={b.designHtml} className="h-full w-full flex-1 bg-white" />
            ) : (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-ink-3">
                <Palette size={28} className="text-ink-4" />
                {T('La maqueta aparece acá cuando el diseñador la escribe.', 'The mockup appears here once the designer writes it.')}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

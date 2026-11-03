import { AlertTriangle, ExternalLink, Eye, Loader2, MousePointerClick, Sparkles, X, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type PersonDetail, type PersonEvent } from '../lib/api'
import { getLang, useT } from '../lib/i18n'
import AiPicker from './AiPicker'
import { ago, countryName, deviceLabel, flag } from './AnalyticsDetail'
import Md from './Md'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'

const hour = (ts: number) => new Date(ts * 1000).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'es-AR', { weekday: 'short', day: 'numeric', month: 'short' })
const KIND = { pageview: [Eye, 'text-ink-3'], click: [MousePointerClick, 'text-accent'], event: [Zap, 'text-gold'], error: [AlertTriangle, 'text-danger'] } as const

function Step({ e }: { e: PersonEvent }) {
  const T = useT()
  const [Icon, tone] = KIND[e.kind as keyof typeof KIND] ?? KIND.event
  const verb = { pageview: T('Entró a', 'Opened'), click: T('Tocó', 'Tapped'), event: T('Evento', 'Event'), error: T('Error', 'Error') }[e.kind] ?? e.kind
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-[12.5px]">
      <span className="w-11 shrink-0 pt-px font-mono text-[11px] text-ink-4">{hour(e.ts)}</span>
      <Icon size={14} className={`mt-0.5 shrink-0 ${tone}`} />
      <span className="min-w-0 break-words text-ink-2">
        {verb} <span className={e.kind === 'pageview' ? 'font-mono text-[12px] text-ink' : 'font-medium text-ink'}>{e.name || e.path}</span>
        {e.name && e.kind !== 'pageview' && <span className="ml-1 font-mono text-[11px] text-ink-4">{e.path}</span>}
        {e.times > 1 && <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-3">×{e.times}</span>}
      </span>
    </li>
  )
}

function Ranked({ title, rows, mono }: { title: string; rows: { key: string; n: number }[]; mono?: boolean }) {
  if (!rows.length) return null
  const top = rows[0].n
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-semibold text-ink">{title}</div>
      <ul className="mt-1.5 space-y-1">
        {rows.slice(0, 6).map((r) => (
          <li key={r.key} className="relative flex items-center justify-between gap-2 overflow-hidden rounded-md px-2 py-1 text-[12px]">
            <span className="absolute inset-y-0 left-0 rounded-md bg-accent-soft" style={{ width: `${(r.n / top) * 100}%` }} />
            <span className={`relative truncate text-ink-2 ${mono ? 'font-mono text-[11.5px]' : ''}`} title={r.key}>{r.key}</span>
            <span className="relative tabular-nums text-ink">{r.n}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One visitor in depth: what they did, visit by visit, and «Analizar usuario» with the AI the owner picks. */
export default function PersonPanel({ slug, who, days, onClose }: { slug: string; who: string; days: number; onClose: () => void }) {
  const T = useT()
  const [d, setD] = useState<PersonDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    api.analyticsPerson(slug, who, days).then((x) => alive && setD(x)).catch((e) => alive && setErr((e as Error).message))
    return () => { alive = false }
  }, [slug, who, days])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const analyze = async () => {
    if (!provider) return toast.error(T('Elegí una IA en la lista', 'Pick an AI from the list'))
    setBusy(true)
    try {
      const analysis = await api.analyticsPersonAnalyze(slug, who, days, provider, model)
      setD((x) => (x ? { ...x, analysis } : x))
    } catch (e) {
      toast.error(T('No se pudo analizar', 'Could not analyse'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const p = d?.person
  const title = p?.name || p?.email || T(`Visitante anónimo ${who.slice(0, 6)}`, `Anonymous visitor ${who.slice(0, 6)}`)
  return createPortal(
    <div className="fixed inset-0 z-[125] flex justify-end bg-ink/40 backdrop-blur-[2px]" onClick={onClose}>
      <aside data-person-panel role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-[640px] flex-col border-l border-line bg-paper shadow-2xl">
        <header className="flex items-start gap-3 border-b border-line bg-surface px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-semibold text-ink">{title}</h2>
            {p?.name && p.email && <div className="truncate text-[12.5px] text-ink-3">{p.email}</div>}
            {p && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
                {p.country && <span>{flag(p.country)} {countryName(p.country)}</span>}
                {p.device && deviceLabel(p.device)}
                <span className="text-ink-3">{[p.os, p.browser].filter(Boolean).join(' · ')}</span>
                <span className="text-ink-3">{T('Última vez', 'Last seen')}: {ago(p.last_seen)}</span>
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} title={T('Cerrar', 'Close')} className="rounded-lg border border-line p-1.5 text-ink-3 transition hover:text-ink"><X size={15} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {err && <div className="rounded-xl border border-line bg-surface p-4 text-[13px] text-ink-2">{err}</div>}
          {!d && !err && <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3"><Loader2 size={15} className="animate-spin" /> {T('Cargando lo que hizo…', 'Loading what they did…')}</div>}
          {d && p && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[[T('Visitas', 'Visits'), p.sessions], [T('Páginas', 'Pages'), p.pageviews], [T('Acciones', 'Actions'), p.actions], [T('Errores', 'Errors'), p.errors]].map(([label, n]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface px-3 py-2">
                    <div className="text-[11px] text-ink-3">{label}</div>
                    <div className="text-[19px] font-semibold tabular-nums text-ink">{n}</div>
                  </div>
                ))}
              </div>

              <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
                <div className="text-[14px] font-semibold text-ink">{T('Analizar con IA', 'Analyse with AI')}</div>
                <p className="mt-0.5 text-[12px] text-ink-3">{T('Resume qué hizo, qué buscaba y por dónde navegó. La IA recibe la actividad, no su nombre ni su email.', 'Sums up what they did, what they were after and where they went. The AI gets the activity, not their name or email.')}</p>
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <button type="button" data-analyze onClick={analyze} disabled={busy} className="flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-60">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    {busy ? T('Analizando…', 'Analysing…') : d.analysis ? T('Analizar de nuevo', 'Analyse again') : T('Analizar usuario', 'Analyse user')}
                  </button>
                  <AiPicker provider={provider} model={model} onChange={(a, m) => { setProvider(a); setModel(m) }} className="flex-1 pt-0.5" />
                </div>
                {d.analysis && (
                  <div data-analysis className="mt-3 border-t border-line pt-3">
                    <Md text={d.analysis.summary} className="leading-relaxed text-ink-2 [&_h1]:text-[14px] [&_h2]:text-[13.5px] [&_li]:text-[13px] [&_p]:text-[13px]" />
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-4">
                      <ProviderLogo provider={d.analysis.provider} size={12} /> {d.analysis.model && d.analysis.model !== 'default' ? d.analysis.model : d.analysis.provider} · {ago(d.analysis.ts)}
                    </div>
                  </div>
                )}
              </section>

              {(d.pages.length > 0 || d.clicks.length > 0) && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Ranked title={T('Dónde más estuvo', 'Where they spent the most time')} rows={d.pages} mono />
                  <Ranked title={T('Qué más tocó', 'What they tapped most')} rows={d.clicks} />
                </div>
              )}

              <section className="mt-5">
                <div className="text-[14px] font-semibold text-ink">{T('Recorrido', 'Journey')}</div>
                <div className="mt-2 space-y-3">
                  {d.visits.map((v) => {
                    const mins = Math.round((v.end - v.start) / 60)
                    return (
                      <div key={v.start} className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
                        <div className="flex flex-wrap items-center gap-x-2 border-b border-line/60 pb-2 text-[12px] text-ink-3">
                          <span className="font-medium text-ink">{day(v.start)}</span>
                          <span>· {mins < 1 ? T('menos de 1 min', 'under 1 min') : `${mins} min`}</span>
                          {v.source && <span className="flex items-center gap-1">· <ExternalLink size={11} /> {T('llegó desde', 'came from')} {v.source}</span>}
                        </div>
                        <ol className="mt-1">{v.events.map((e) => <Step key={`${e.ts}-${e.kind}-${e.name}`} e={e} />)}</ol>
                      </div>
                    )
                  })}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

import { AlertTriangle, Building2, CheckCircle2, Clapperboard, Copy, Download, ExternalLink, Eye, Heart, KeyRound, Layers, Link2, Loader2, Medal, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type AdTierCard, type AdTierDetail, type AdTierEvidence, type AdTierHome, type AdTierMasters, type AdTierPage, type AdTierTemplate, type AdTierTier, type ForYouHome, type ForYouMatches, type MetaApp, type ReelIdea } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import PageHeader from './PageHeader'
import { toast } from './Toast'

const TIER_COLOR: Record<AdTierTier, string> = { S: '#FF6B6B', A: '#FF9F43', B: '#F7C948', C: '#7BC67E' }
const TIERS: AdTierTier[] = ['S', 'A', 'B', 'C']
const FORMATS: Record<string, [string, string]> = { brand_spot: ['Spot de marca', 'Brand spot'], ugc: ['UGC', 'UGC'], demo: ['Demo', 'Demo'], testimonial: ['Testimonial', 'Testimonial'], explainer: ['Explicativo', 'Explainer'], other: ['Otro', 'Other'] }
const DIMS: [keyof NonNullable<AdTierDetail['score']>, string, string, number][] = [['hook', 'Hook (0–3 s)', 'Hook (0–3 s)', 25], ['structure', 'Estructura y ritmo', 'Structure and pace', 25], ['copy', 'Mensaje y copy', 'Message and copy', 20], ['visual', 'Craft visual y sonido', 'Visual and sound craft', 15], ['platform_fit', 'Plataforma y CTA', 'Platform fit and CTA', 15]]
const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none transition focus:border-accent'
const SELECT = 'h-9 rounded-full border border-line bg-surface px-3 text-[12.5px] text-ink-2 outline-none focus:border-accent'
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-ink-3'
type Tab = 'foryou' | 'tiers' | 'videos' | 'templates' | 'brands' | 'admin' | 'api'
type Filters = Record<string, string>
const DURATIONS: [string, string, string, Filters][] = [['', 'Cualquier duración', 'Any length', {}], ['reel', 'Reels · hasta 60 s', 'Reels · up to 60 s', { max_s: '60' }], ['15', 'Hasta 15 s', 'Up to 15 s', { max_s: '15' }], ['30', '15–30 s', '15–30 s', { min_s: '15', max_s: '30' }], ['60', '30–60 s', '30–60 s', { min_s: '30', max_s: '60' }], ['61', 'Más de 60 s', 'Over 60 s', { min_s: '60' }]]
const qs = (f: Filters, extra: Filters = {}) => { const p = new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)); const s = p.toString(); return s ? `?${s}` : '' }
const fmtName = (f: string | null | undefined, en: boolean) => (f ? (FORMATS[f]?.[en ? 1 : 0] ?? f) : '')

/** AdTier: video ads ranked S/A/B/C by evidence (awards, performance) and an AI score, each broken down into a template. */
export default function AdTier({ onBack }: { onBack: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [tab, setTab] = useState<Tab>('foryou')
  const [home, setHome] = useState<AdTierHome | null>(null)
  const [filters, setFilters] = useState<Filters>({})
  const [dur, setDur] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const f = useMemo(() => ({ ...filters, ...(DURATIONS.find((d) => d[0] === dur)?.[3] ?? {}) }), [filters, dur])

  useEffect(() => { api.adtier(qs(f)).then(setHome).catch((e) => toast.error(tr('No pude leer AdTier', 'Could not read AdTier'), (e as Error).message)) }, [f])
  // while the team analyses videos, the tier list fills in by itself
  useEffect(() => {
    if (!home?.working) return
    const t = window.setTimeout(() => api.adtier(qs(f)).then(setHome).catch(() => {}), 8000)
    return () => window.clearTimeout(t)
  }, [home, f])
  const total = home ? Object.values(home.facets.counts).reduce((a, b) => a + b, 0) : 0
  const tabs: [Tab, string, string][] = [['foryou', 'Para vos', 'For you'], ['tiers', 'Tier list', 'Tier list'], ['videos', 'Videos', 'Videos'], ['templates', 'Plantillas maestras', 'Master templates'], ['brands', 'Marcas', 'Brands'], ['api', 'API y MCP', 'API and MCP'], ...(home?.admin ? [['admin', 'Administrar', 'Admin'] as [Tab, string, string]] : [])]
  const set = (k: string, v: string) => setFilters((x) => ({ ...x, [k]: v }))

  const bar = home && (
    <div className="flex flex-wrap items-center gap-2">
      <select value={filters.format ?? ''} onChange={(e) => set('format', e.target.value)} className={SELECT}><option value="">{T('Todos los formatos', 'All formats')}</option>{Object.keys(FORMATS).map((k) => <option key={k} value={k}>{fmtName(k, en)}</option>)}</select>
      <select value={filters.industry ?? ''} onChange={(e) => set('industry', e.target.value)} className={SELECT}><option value="">{T('Todas las industrias', 'All industries')}</option>{home.facets.industry.map((k) => <option key={k} value={k}>{k}</option>)}</select>
      <select value={dur} onChange={(e) => setDur(e.target.value)} className={SELECT}>{DURATIONS.map(([k, es, e2]) => <option key={k} value={k}>{T(es, e2)}</option>)}</select>
      <select value={filters.platform_origin ?? ''} onChange={(e) => set('platform_origin', e.target.value)} className={SELECT}><option value="">{T('Todas las plataformas', 'All platforms')}</option>{['tv', 'youtube', 'tiktok', 'meta'].map((k) => <option key={k} value={k}>{k === 'tv' ? 'TV' : k[0].toUpperCase() + k.slice(1)}</option>)}</select>
      <select value={filters.language ?? ''} onChange={(e) => set('language', e.target.value)} className={SELECT}><option value="">{T('Todos los idiomas', 'All languages')}</option>{home.facets.language.map((k) => <option key={k} value={k}>{k}</option>)}</select>
      <button type="button" onClick={() => setDur(dur === 'reel' ? '' : 'reel')} className={`h-9 rounded-full border px-3 text-[12.5px] ${dur === 'reel' ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent'}`}>{T('Reels · hasta 60 s', 'Reels · up to 60 s')}</button>
      <button type="button" onClick={() => set('region', filters.region === 'latam' ? '' : 'latam')} className={`h-9 rounded-full border px-3 text-[12.5px] ${filters.region === 'latam' ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent'}`}>LatAm</button>
      {(Object.values(filters).some(Boolean) || dur) && <button type="button" onClick={() => { setFilters({}); setDur('') }} className="text-[12px] text-ink-3 underline">{T('Limpiar', 'Clear')}</button>}
    </div>
  )

  return (
    <div className="min-h-full bg-paper">
      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6">
        <PageHeader onBack={onBack} kicker="AdTier" title={T('Los mejores anuncios en video, con su plantilla', 'The best video ads, with their template')}
          subtitle={T('Cada video tiene un tier S/A/B/C por evidencia (premios, performance) y un score de IA, y está descompuesto en una plantilla que podés copiar: hook, estructura por segundos y CTA.', 'Each video has an S/A/B/C tier from evidence (awards, performance) and an AI score, broken down into a template you can copy: hook, structure by the second and CTA.')}
          right={<span className="flex items-center gap-1.5 text-[12px] text-ink-3"><Medal size={14} className="text-accent" /> {T(`${total} videos publicados`, `${total} published videos`)}</span>} />

        <div className="mt-4 flex flex-wrap gap-1.5 border-b border-line pb-3">
          {tabs.map(([k, es, e2]) => <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3.5 py-1.5 text-[13px] ${tab === k ? 'bg-ink text-paper font-semibold' : 'text-ink-2 hover:bg-surface-2'}`}>{T(es, e2)}</button>)}
        </div>

        {!!home?.working && (
          <p className="mt-3 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {T(`El equipo está analizando ${home.working} anuncios con Muse: aparecen acá a medida que terminan.`, `The team is analysing ${home.working} ads with Muse: they show up here as they finish.`)}</p>
        )}
        {!home ? <div className="flex items-center gap-2 py-10 text-ink-3"><Loader2 size={16} className="animate-spin" /> {T('Cargando…', 'Loading…')}</div> : (
          <div className="mt-4 flex flex-col gap-4">
            {(tab === 'tiers' || tab === 'videos') && bar}
            {tab === 'foryou' && <ForYou onOpen={setOpen} />}
            {tab === 'tiers' && <TierRows home={home} onOpen={setOpen} />}
            {tab === 'videos' && <Grid filters={f} onOpen={setOpen} />}
            {tab === 'templates' && <Masters admin={home.admin} />}
            {tab === 'brands' && <Brands onPick={(b) => { setFilters({ brand: b }); setTab('videos') }} />}
            {tab === 'api' && <ApiInfo base={home.public_url} />}
            {tab === 'admin' && home.admin && <Admin home={home} onOpen={setOpen} />}
            <p className="mt-6 border-t border-line pt-4 text-[11.5px] leading-relaxed text-ink-4">
              {T('AdTier es un índice con análisis y crítica: los videos se reproducen desde su plataforma oficial (embed) y nunca se descargan ni se alojan acá. Se muestra la atribución de cada uno (marca, agencia, año, fuente de la evidencia). Pedidos de baja: se retiran en 48 h', 'AdTier is an index with analysis and critique: videos play from their official platform (embed) and are never downloaded or hosted here. Each one shows its attribution (brand, agency, year, source of the evidence). Takedown requests: removed within 48 h')}{home.takedown_email ? <> · <a className="underline" href={`mailto:${home.takedown_email}`}>{home.takedown_email}</a></> : '.'}
              {home.admin && !home.takedown_email && <span className="ml-1 text-[#C28A12]">{T('(Configurá ADTIER_TAKEDOWN_EMAIL para mostrar el email de bajas.)', '(Set ADTIER_TAKEDOWN_EMAIL to show the takedown email.)')}</span>}
            </p>
          </div>
        )}
      </div>
      {open && <Detail id={open} admin={!!home?.admin} onClose={() => setOpen(null)} onOpen={setOpen} onChanged={() => api.adtier(qs(f)).then(setHome).catch(() => {})} />}
    </div>
  )
}

function Thumb({ v, onOpen, big = false }: { v: AdTierCard; onOpen: (id: string) => void; big?: boolean }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  return (
    <button type="button" onClick={() => onOpen(v.id)} className={`group flex shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface text-left transition hover:-translate-y-0.5 hover:border-accent/60 ${big ? 'w-full' : 'w-[220px]'}`}>
      <span className="relative block aspect-video w-full overflow-hidden bg-black">
        {v.thumbnail_url ? <img src={v.thumbnail_url} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" /> : null}
        {v.tier && <span className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-[14px] font-black text-black" style={{ background: TIER_COLOR[v.tier] }}>{v.tier}</span>}
        {v.duration_s ? <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10.5px] font-semibold text-white">{Math.round(v.duration_s)} s</span> : null}
      </span>
      <span className="flex flex-col gap-0.5 p-2.5">
        <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink">{v.title || v.brand}</span>
        <span className="truncate text-[11.5px] text-ink-3">{[v.brand, v.year, fmtName(v.format, en)].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  )
}

function TierRows({ home, onOpen }: { home: AdTierHome; onOpen: (id: string) => void }) {
  const T = useT()
  const empty = TIERS.every((t) => !home.tiers[t].length)
  if (empty) return <p className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-[14px] text-ink-3">{home.admin ? T('Todavía no hay videos publicados. Cargalos en «Administrar»: por URL o con un CSV.', 'No published videos yet. Load them in «Admin»: by URL or with a CSV.') : T('Todavía no hay videos publicados con estos filtros.', 'No published videos with these filters yet.')}</p>
  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      {TIERS.map((t) => (
        <div key={t} className="flex border-b border-line last:border-b-0" style={{ minHeight: 120 }}>
          <div className="flex w-16 shrink-0 items-center justify-center text-[40px] font-black text-black sm:w-24" style={{ background: TIER_COLOR[t] }}>{t}</div>
          <div className="flex min-w-0 flex-1 gap-2.5 overflow-x-auto bg-surface-2/40 p-3 scroll-thin">
            {home.tiers[t].length ? home.tiers[t].map((v) => <Thumb key={v.id} v={v} onOpen={onOpen} />) : <span className="self-center text-[12.5px] text-ink-4">{T('Ninguno todavía', 'None yet')}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function Grid({ filters, onOpen }: { filters: Filters; onOpen: (id: string) => void }) {
  const T = useT()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AdTierPage | null>(null)
  useEffect(() => { setPage(1) }, [filters, q])
  useEffect(() => { const t = window.setTimeout(() => api.adtierVideos(qs(filters, { q, page: String(page) })).then(setData).catch(() => {}), 250); return () => window.clearTimeout(t) }, [filters, q, page])
  const pages = data ? Math.max(1, Math.ceil(data.total / data.per)) : 1
  return (
    <div className="flex flex-col gap-3">
      <label className="relative max-w-[460px]"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={T('Buscar en títulos, marcas y lo que se dice en los videos', 'Search titles, brands and what is said in the videos')} className={`${INPUT} pl-8`} /></label>
      <div className="grid grid-cols-1 gap-3 min-[520px]:grid-cols-2 min-[900px]:grid-cols-3 min-[1200px]:grid-cols-4">{data?.videos.map((v) => <Thumb key={v.id} v={v} onOpen={onOpen} big />)}</div>
      {data && !data.videos.length && <p className="py-8 text-center text-[13px] text-ink-3">{T('Nada con esos filtros.', 'Nothing matches those filters.')}</p>}
      {pages > 1 && <div className="flex items-center justify-center gap-2 text-[13px]"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className={PILL}>←</button><span className="text-ink-3">{page} / {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)} className={PILL}>→</button></div>}
    </div>
  )
}

function TemplateView({ t }: { t: AdTierTemplate }) {
  const T = useT()
  const purpose: Record<string, string> = { hook: '#FF6B6B', problem: '#FF9F43', demo: '#4C9AFF', proof: '#7BC67E', offer: '#B388FF', cta: '#F7C948' }
  const end = Math.max(1, ...(t.beats ?? []).map((b) => b.to))
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {t.reusable_skeleton && <p className="rounded-xl bg-accent-soft px-3 py-2 font-semibold text-ink">{t.reusable_skeleton}</p>}
      {t.hook && <div><div className={LABEL}>{T('Hook', 'Hook')} · {t.hook.seconds ?? '0-3'} s · {t.hook.type}</div><p className="mt-1 text-ink-2">{t.hook.description}</p>{t.hook.line && <p className="mt-1 border-l-2 border-accent pl-2 italic text-ink">«{t.hook.line}»</p>}</div>}
      {!!t.beats?.length && (
        <div>
          <div className={LABEL}>{T('Estructura por segundos', 'Structure by the second')}</div>
          <div className="mt-1.5 flex h-3 overflow-hidden rounded-full">{t.beats.map((b, i) => <span key={i} title={`${b.from}–${b.to} s · ${b.purpose}`} style={{ width: `${((b.to - b.from) / end) * 100}%`, background: purpose[b.purpose] ?? '#888' }} />)}</div>
          <ol className="mt-2 flex flex-col gap-1">{t.beats.map((b, i) => <li key={i} className="text-ink-2"><span className="font-mono text-[11.5px] text-ink-4">{b.from}–{b.to} s</span> <b className="text-ink" style={{ color: purpose[b.purpose] }}>{b.purpose}</b> — {b.visual}{b.audio ? <span className="text-ink-3"> · {b.audio}</span> : null}</li>)}</ol>
        </div>
      )}
      {t.cta && <div><div className={LABEL}>CTA · {t.cta.seconds} s · {t.cta.type}</div>{t.cta.line && <p className="mt-1 border-l-2 border-accent pl-2 italic text-ink">«{t.cta.line}»</p>}</div>}
      <div className="flex flex-wrap gap-1.5">{(t.tone ?? []).map((x) => <span key={x} className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-2">{x}</span>)}</div>
      {t.production && <p className="text-ink-3">{T('Producción', 'Production')}: {[t.production.people_on_camera != null && T(`${t.production.people_on_camera} en cámara`, `${t.production.people_on_camera} on camera`), t.production.locations != null && T(`${t.production.locations} locaciones`, `${t.production.locations} locations`), t.production.captions && T('subtítulos', 'captions'), t.production.music, t.production.budget_tier].filter(Boolean).join(' · ')}</p>}
      {t.adapt_notes && <p className="text-ink-2"><b className="text-ink">{T('Cómo adaptarla:', 'How to adapt it:')}</b> {t.adapt_notes}</p>}
    </div>
  )
}

function Detail({ id, admin, onClose, onOpen, onChanged }: { id: string; admin: boolean; onClose: () => void; onOpen: (id: string) => void; onChanged: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [d, setD] = useState<AdTierDetail | null>(null)
  const load = () => api.adtierVideo(id).then(setD).catch((e) => { toast.error(T('No se pudo abrir', 'Could not open'), (e as Error).message); onClose() })
  useEffect(() => { setD(null); load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d || !admin || !['queued', 'meta', 'frames', 'transcribe', 'analyze'].includes(d.stage ?? '')) return
    const t = window.setTimeout(load, 3000)
    return () => window.clearTimeout(t)
  }, [d]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const vertical = d?.embed_provider === 'tiktok'
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div className="relative w-full max-w-[1080px] rounded-2xl border border-line bg-paper p-4 shadow-2xl sm:p-6" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink-2 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={16} /></button>
        {!d ? <div className="flex items-center gap-2 py-16 text-ink-3"><Loader2 size={16} className="animate-spin" /> {T('Cargando…', 'Loading…')}</div> : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-3">
              <div className={`overflow-hidden rounded-xl bg-black ${vertical ? 'mx-auto aspect-[9/16] w-full max-w-[340px]' : 'aspect-video w-full'}`}>
                <iframe src={d.embed_url} title={d.title} className="h-full w-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
              </div>
              <div>
                <h2 className="pr-10 text-[20px] font-bold leading-tight text-ink">{d.title}</h2>
                <p className="mt-1 text-[13px] text-ink-3">{[d.brand, d.agency, d.year, d.country, d.language, fmtName(d.format, en), d.industry].filter(Boolean).join(' · ')}</p>
                <a href={d.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline"><ExternalLink size={12} /> {T('Ver en la plataforma', 'View on the platform')}</a>
              </div>
              {d.unreviewed && !admin && <p className="rounded-xl border border-[#C28A12]/40 bg-[#C28A12]/10 px-3 py-2 text-[12.5px] text-ink-2">{d.score ? T('Lo encontramos para tu perfil: está analizado por Muse pero todavía no lo revisó una persona y no tiene premio verificado, así que su tier sale solo del score.', 'We found it for your profile: Muse analysed it but no person has reviewed it yet and it has no verified award, so its tier comes from the score alone.') : T('Lo encontramos para tu perfil y todavía no está analizado: podés verlo igual; la plantilla aparece cuando Muse termine.', 'We found it for your profile and it is not analysed yet: you can watch it anyway; the template shows up when Muse finishes.')}</p>}
              {d.tier_info && (
                <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-[26px] font-black text-black" style={{ background: TIER_COLOR[d.tier_info.tier] }}>{d.tier_info.tier}</span>
                  <div className="text-[12.5px] text-ink-2">
                    <div className="font-semibold text-ink">{d.tier_info.basis === 'evidence' ? T('Por evidencia externa', 'From external evidence') : d.tier_info.basis === 'human' ? T('Asignado en la revisión', 'Set in review') : T('Por score', 'From the score')}</div>
                    <p>{d.tier_info.justification}</p>
                    {d.tier_info.assigned_by === 'ai' && <p className="mt-1 text-ink-4">{T('Analizado automáticamente; todavía sin revisión humana.', 'Analysed automatically; not reviewed by a person yet.')}</p>}
                    {admin && d.tier_info.proposed && <p className="mt-1 text-ink-4">{T('Propuesto por la IA', 'Proposed by the AI')}: {d.tier_info.proposed} · {T('evidencia', 'evidence')}: {d.tier_info.evidence_tier ?? '—'} · score: {d.tier_info.score_tier}</p>}
                  </div>
                </div>
              )}
              {!!d.evidence.length && (
                <div><div className={LABEL}>{T('Evidencia', 'Evidence')}</div>
                  <ul className="mt-1 flex flex-col gap-1 text-[12.5px] text-ink-2">{d.evidence.map((e, i) => <li key={i}><span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase text-ink-3">{e.type}</span> {e.detail}{e.days_active ? ` · ${e.days_active} ${T('días activo', 'days live')}` : ''}{e.url && <> · <a href={e.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{T('fuente', 'source')}</a></>}</li>)}</ul>
                </div>
              )}
              {d.score && (
                <div><div className={LABEL}>Score {d.score.total}/100{d.score.needs_review ? <span className="ml-1 normal-case text-[#C28A12]">· {T('las dos corridas difieren: revisar', 'the two runs differ: review')}</span> : null}</div>
                  <div className="mt-1.5 flex flex-col gap-1.5">{DIMS.map(([k, es, e2, w]) => (
                    <div key={k} title={d.score!.rationale?.[k] ?? ''}>
                      <div className="flex justify-between text-[12px] text-ink-2"><span>{T(es, e2)} <span className="text-ink-4">({w} %)</span></span><b className="text-ink">{Number(d.score![k])}</b></div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${Number(d.score![k])}%` }} /></div>
                      {d.score!.rationale?.[k] && <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{d.score!.rationale[k]}</p>}
                    </div>
                  ))}</div>
                  <p className="mt-1 text-[11px] text-ink-4">{d.score.model}</p>
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 lg:pr-10">
                <h3 className="flex-1 text-[16px] font-bold text-ink">{T('Plantilla', 'Template')}{d.template_version ? <span className="ml-1 text-[12px] font-normal text-ink-4">v{d.template_version}</span> : null}</h3>
                {d.template && d.status === 'published' && <>
                  <a href={`/api/adtier/videos/${d.slug}/template.md`} className={PILL}><Download size={13} /> Markdown</a>
                  <a href={`/api/adtier/videos/${d.slug}/template.json`} className={PILL}><Download size={13} /> JSON</a>
                </>}
              </div>
              {d.template ? <TemplateView t={d.template} /> : <p className="text-[13px] text-ink-3">{T('Todavía sin plantilla.', 'No template yet.')}</p>}
              {admin && <AdminBox d={d} onChange={(x) => { setD(x); onChanged() }} onDeleted={() => { onChanged(); onClose() }} />}
              {!!d.similar.length && (
                <div><div className={LABEL}>{T('Parecidos', 'Similar')}</div><div className="mt-2 grid grid-cols-2 gap-2">{d.similar.map((v) => <Thumb key={v.id} v={v} onOpen={onOpen} big />)}</div></div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The admin's part of a video: its ingest state, the review (tier + template + publish), re-run, delete. */
function AdminBox({ d, onChange, onDeleted }: { d: AdTierDetail; onChange: (d: AdTierDetail) => void; onDeleted: () => void }) {
  const T = useT()
  const [tier, setTier] = useState<AdTierTier>(d.tier_info?.tier ?? 'C')
  const [tpl, setTpl] = useState(JSON.stringify(d.template ?? {}, null, 2))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const working = ['queued', 'meta', 'frames', 'transcribe', 'analyze'].includes(d.stage ?? '')
  const save = async (publish: boolean) => {
    let body: Record<string, unknown> | null = null
    try { body = JSON.parse(tpl) } catch { return toast.error(T('La plantilla no es JSON válido', 'The template is not valid JSON')) }
    setBusy(true)
    try { onChange(await api.adtierReview(d.id, { tier, template: body, publish, note })); toast.ok(publish ? T('Publicado', 'Published') : T('Guardado', 'Saved')) } catch (e) { toast.error(T('No se pudo guardar', 'Could not save'), (e as Error).message) } finally { setBusy(false) }
  }
  const stageName: Record<string, [string, string]> = { queued: ['En cola', 'Queued'], meta: ['Leyendo la metadata', 'Reading metadata'], frames: ['Sacando cuadros', 'Taking frames'], transcribe: ['Transcribiendo', 'Transcribing'], analyze: ['Analizando con Muse', 'Analysing with Muse'] }
  return (
    <div className="mt-2 flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-soft/30 p-3">
      <div className="flex items-center gap-2 text-[13px] font-bold text-ink"><ShieldCheck size={15} className="text-accent" /> {T('Revisión', 'Review')} <span className="font-normal text-ink-3">· {d.status}</span></div>
      {working && <p className="flex items-center gap-2 text-[12.5px] text-ink-2"><Loader2 size={13} className="animate-spin text-accent" /> {T(...(stageName[d.stage ?? ''] ?? ['Trabajando', 'Working']))}</p>}
      {d.error && <p className="flex items-start gap-1.5 text-[12.5px] text-danger"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {d.error}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={LABEL}>Tier</span>
        {TIERS.map((t) => <button key={t} onClick={() => setTier(t)} className={`h-8 w-8 rounded-md text-[14px] font-black ${tier === t ? 'text-black ring-2 ring-ink' : 'text-black/60 opacity-60'}`} style={{ background: TIER_COLOR[t] }}>{t}</button>)}
        {tier === 'S' && !d.evidence.length && <span className="text-[11.5px] text-danger">{T('S necesita evidencia externa', 'S needs external evidence')}</span>}
      </div>
      <label><span className={LABEL}>{T('Plantilla (JSON)', 'Template (JSON)')}</span><textarea value={tpl} onChange={(e) => setTpl(e.target.value)} rows={8} className={`${INPUT} mt-1 font-mono text-[11.5px]`} /></label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={T('Nota de la revisión (opcional): por qué este tier', 'Review note (optional): why this tier')} className={INPUT} />
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || working} onClick={() => save(true)} className={PRIMARY}><CheckCircle2 size={14} /> {d.status === 'published' ? T('Guardar publicado', 'Save published') : T('Aprobar y publicar', 'Approve and publish')}</button>
        <button disabled={busy || working} onClick={() => save(false)} className={PILL}>{T('Guardar sin publicar', 'Save unpublished')}</button>
        <button disabled={busy || working} onClick={() => api.adtierReingest(d.id).then(onChange)} className={PILL}><RefreshCw size={13} /> {T('Volver a analizar', 'Analyse again')}</button>
        <button disabled={busy} onClick={() => { if (window.confirm(T('¿Sacar este video del catálogo?', 'Remove this video from the catalogue?'))) api.adtierDelete(d.id).then(onDeleted) }} className="ml-auto flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-danger/10 hover:text-danger" aria-label={T('Borrar', 'Delete')}><Trash2 size={14} /></button>
      </div>
      {!!d.transcript?.length && <details className="text-[12px] text-ink-3"><summary className="cursor-pointer">{T('Transcripción (solo admin)', 'Transcript (admin only)')}</summary><p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed">{d.transcript.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n')}</p></details>}
    </div>
  )
}

function Admin({ home, onOpen }: { home: AdTierHome; onOpen: (id: string) => void }) {
  const T = useT()
  const [q, setQ] = useState<Awaited<ReturnType<typeof api.adtierQueue>> | null>(null)
  const [url, setUrl] = useState('')
  const [meta, setMeta] = useState<Record<string, string>>({})
  const [ev, setEv] = useState<AdTierEvidence>({ type: 'award', detail: '', url: '' })
  const [csv, setCsv] = useState('')
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(home.autopublish)
  const load = () => api.adtierQueue().then(setQ).catch(() => {})
  useEffect(() => { load(); const t = window.setInterval(load, 5000); return () => window.clearInterval(t) }, [])
  const add = async () => {
    setBusy(true)
    try { await api.adtierAdd(url, ev.detail || ev.url ? [ev] : [], meta); setUrl(''); setMeta({}); setEv({ type: 'award', detail: '', url: '' }); toast.ok(T('Cargado: el equipo lo está analizando', 'Loaded: the team is analysing it')); load() } catch (e) { toast.error(T('No se pudo cargar', 'Could not load'), (e as Error).message) } finally { setBusy(false) }
  }
  const lot = async () => {
    setBusy(true)
    try { const r = await api.adtierBatch(csv); toast.ok(T(`${r.added.length} cargados`, `${r.added.length} loaded`), r.errors.join(' · ') || undefined); if (!r.errors.length) setCsv(''); load() } catch (e) { toast.error(T('No se pudo cargar el lote', 'Could not load the batch'), (e as Error).message) } finally { setBusy(false) }
  }
  const m = (k: string, label: string, w = '') => <label className={w}><span className={LABEL}>{label}</span><input value={meta[k] ?? ''} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} className={`${INPUT} mt-1`} /></label>
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="flex items-center gap-1.5 text-[15px] font-bold text-ink"><Plus size={15} /> {T('Cargar un video', 'Load a video')}</h3>
        <p className="mt-1 text-[12px] text-ink-3">{T('YouTube, Vimeo o TikTok. Se reproduce por su embed oficial; el equipo lee la metadata, saca 6 cuadros del storyboard del proveedor, transcribe (subtítulos del proveedor o Meta Muse Voice Transcribe) y lo analiza con Muse.', 'YouTube, Vimeo or TikTok. It plays through its official embed; the team reads the metadata, takes 6 frames from the provider’s storyboard, transcribes it (provider captions or Meta Muse Voice Transcribe) and analyses it with Muse.')}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="col-span-2"><span className={LABEL}>URL</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" className={`${INPUT} mt-1`} /></label>
          {m('brand', T('Marca', 'Brand'))}{m('agency', T('Agencia', 'Agency'))}{m('year', T('Año', 'Year'))}{m('country', T('País (AR, MX…)', 'Country (US, GB…)'))}{m('industry', T('Industria', 'Industry'))}
          <label><span className={LABEL}>{T('Formato', 'Format')}</span><select value={meta.format ?? ''} onChange={(e) => setMeta({ ...meta, format: e.target.value })} className={`${INPUT} mt-1`}><option value="">{T('Que lo detecte la IA', 'Let the AI detect it')}</option>{Object.keys(FORMATS).map((k) => <option key={k} value={k}>{fmtName(k, T('es', 'en') === 'en')}</option>)}</select></label>
          <div className="col-span-2 mt-1 rounded-xl border border-line p-2.5">
            <div className={LABEL}>{T('Evidencia externa', 'External evidence')}</div>
            <div className="mt-1.5 grid grid-cols-[110px_1fr] gap-2">
              <select value={ev.type} onChange={(e) => setEv({ ...ev, type: e.target.value as AdTierEvidence['type'] })} className={INPUT}><option value="award">{T('Premio', 'Award')}</option><option value="performance">Performance</option><option value="editorial">{T('Lista editorial', 'Editorial list')}</option></select>
              <input value={ev.detail} onChange={(e) => setEv({ ...ev, detail: e.target.value })} placeholder={T('Ej.: Cannes 2024 Gold Film · 212 días activo, 7 variaciones', 'E.g.: Cannes 2024 Gold Film · 212 days live, 7 variations')} className={INPUT} />
              <input value={ev.url} onChange={(e) => setEv({ ...ev, url: e.target.value })} placeholder={T('Link verificable de la evidencia', 'Verifiable link to the evidence')} className={`${INPUT} col-span-2`} />
            </div>
            <p className="mt-1.5 text-[11px] text-ink-4">{T('Sin evidencia externa un video no puede ser S.', 'Without external evidence a video cannot be S.')}</p>
          </div>
        </div>
        <button disabled={busy || !url.trim()} onClick={add} className={`${PRIMARY} mt-3`}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {T('Cargar y analizar', 'Load and analyse')}</button>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="flex items-center gap-1.5 text-[15px] font-bold text-ink"><Upload size={15} /> {T('Cargar un lote (CSV)', 'Load a batch (CSV)')}</h3>
        <p className="mt-1 text-[12px] text-ink-3">{T('Columnas', 'Columns')}: <code className="text-[11px]">{(q?.columns ?? []).join(',')}</code></p>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} placeholder={'url,brand,year,country,evidence_type,evidence_detail,evidence_url\nhttps://www.youtube.com/watch?v=…,Marca,2024,AR,award,Cannes 2024 Gold Film,https://…'} className={`${INPUT} mt-2 font-mono text-[11.5px]`} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button disabled={busy || !csv.trim()} onClick={lot} className={PRIMARY}><Upload size={14} /> {T('Cargar el lote', 'Load the batch')}</button>
          <label className={`${PILL} cursor-pointer`}><input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); e.target.value = '' }} />{T('Elegir archivo', 'Pick a file')}</label>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-[15px] font-bold text-ink">{T('Cola de revisión', 'Review queue')}</h3>
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><input type="checkbox" checked={!!auto} onChange={(e) => api.adtierAutopublish(e.target.checked).then((r) => setAuto(r.autopublish))} /> {T('Publicar automático los que tienen evidencia', 'Auto-publish the ones with evidence')}</label>
          {!!home.seed_size && <button disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.adtierSeed(); toast.ok(T(`${r.added.length} ganadores nuevos cargados`, `${r.added.length} new winners loaded`), r.errors.join(' · ') || undefined); load() } finally { setBusy(false) } }} className={PILL}><Medal size={13} /> {T(`Cargar ganadores (${home.seed_size})`, `Load winners (${home.seed_size})`)}</button>}
          {q?.agreement.reviewed ? <span className="text-[12px] text-ink-3">{T(`La IA acertó el tier en ${q.agreement.pct} % de ${q.agreement.reviewed} revisados (meta: más de 70 %)`, `The AI got the tier right in ${q.agreement.pct}% of ${q.agreement.reviewed} reviewed (goal: over 70%)`)}</span> : null}
          {!!q?.drafts.length && <button onClick={() => api.adtierRetry().then((r) => { toast.ok(T(`Reintentando ${r.retrying}`, `Retrying ${r.retrying}`)); load() })} className={PILL}><RefreshCw size={13} /> {T('Reintentar los que fallaron', 'Retry the failed ones')}</button>}
          <button onClick={() => api.adtierCheckEmbeds().then((r) => toast.ok(T(`${r.checked} embeds revisados`, `${r.checked} embeds checked`), r.unpublished.length ? T(`${r.unpublished.length} despublicados`, `${r.unpublished.length} unpublished`) : undefined))} className={PILL}><ShieldCheck size={13} /> {T('Verificar embeds', 'Check embeds')}</button>
        </div>
        {([['review', T('Para revisar', 'To review')], ['drafts', T('En proceso o con error', 'In progress or failed')], ['unreviewed', T('Publicados sin revisar', 'Published, not reviewed')]] as const).map(([k, l]) => (
          <div key={k} className="mt-3">
            <div className={LABEL}>{l} · {q?.[k].length ?? 0}</div>
            <div className="mt-2 grid grid-cols-1 gap-2 min-[520px]:grid-cols-2 min-[900px]:grid-cols-4">
              {(q?.[k] ?? []).map((v) => (
                <div key={v.id} className="relative">
                  <Thumb v={{ ...v, tier: v.proposed ?? v.tier }} onOpen={onOpen} big />
                  {q?.running.includes(v.id) && <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/75 px-2 py-0.5 text-[10.5px] text-white"><Loader2 size={10} className="animate-spin" /> {T('analizando', 'analysing')}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
        {!home.takedown_email && <p className="mt-3 text-[12px] text-[#C28A12]">{T('Falta el email de bajas (ADTIER_TAKEDOWN_EMAIL) para mostrar en el catálogo.', 'The takedown email (ADTIER_TAKEDOWN_EMAIL) is missing from the catalogue.')}</p>}
      </section>
    </div>
  )
}

function Masters({ admin }: { admin: boolean }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [m, setM] = useState<AdTierMasters | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { api.adtierMasters().then(setM).catch(() => {}) }, [])
  if (!m) return <Loader2 size={16} className="animate-spin text-ink-3" />
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-3">{T(`Con ${m.min} o más videos publicados del mismo formato y tier, el equipo arma la plantilla maestra: estructura promedio, los 5 hooks más frecuentes y qué separa a los mejores.`, `With ${m.min} or more published videos of the same format and tier, the team builds the master template: average structure, the 5 most frequent hooks and what sets the best apart.`)}</p>
      <div className="flex flex-wrap gap-2">
        {m.status.map((s) => (
          <div key={`${s.format}${s.tier}`} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px]">
            <span className="flex h-6 w-6 items-center justify-center rounded text-[12px] font-black text-black" style={{ background: TIER_COLOR[s.tier] }}>{s.tier}</span>
            <span className="text-ink">{fmtName(s.format, en)}</span><span className="text-ink-4">{s.videos}/{m.min}</span>
            {admin && s.ready && <button disabled={!!busy} onClick={async () => { setBusy(s.format + s.tier); try { setM(await api.adtierMakeMaster(s.format, s.tier)) } catch (e) { toast.error(T('No se pudo', 'Could not'), (e as Error).message) } finally { setBusy(null) } }} className="text-accent hover:underline">{busy === s.format + s.tier ? <Loader2 size={12} className="animate-spin" /> : s.made ? T('Rehacer', 'Redo') : T('Armar', 'Build')}</button>}
          </div>
        ))}
        {!m.status.length && <p className="text-[13px] text-ink-4">{T('Todavía no hay videos publicados.', 'No published videos yet.')}</p>}
      </div>
      {m.masters.map((x) => (
        <section key={x.format + x.tier} className="rounded-2xl border border-line bg-surface p-4">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-ink"><Layers size={15} /> {fmtName(x.format, en)} · tier {x.tier} <span className="text-[12px] font-normal text-ink-4">{x.videos.length} videos · {x.model}</span></h3>
          {x.body.skeleton && <p className="mt-2 rounded-xl bg-accent-soft px-3 py-2 text-[13px] font-semibold text-ink">{x.body.skeleton}</p>}
          <div className="mt-3 grid grid-cols-1 gap-3 text-[12.5px] md:grid-cols-2">
            <div><div className={LABEL}>{T('Estructura promedio', 'Average structure')}</div><ol className="mt-1 flex flex-col gap-0.5 text-ink-2">{(x.body.beats ?? []).map((b, i) => <li key={i}><span className="font-mono text-[11px] text-ink-4">{b.from}–{b.to} s</span> <b className="text-ink">{b.purpose}</b> — {b.what}</li>)}</ol></div>
            <div><div className={LABEL}>{T('Hooks más frecuentes', 'Most frequent hooks')}</div><ul className="mt-1 flex flex-col gap-0.5 text-ink-2">{(x.body.top_hooks ?? []).map((h, i) => <li key={i}><b className="text-ink">{h.type}</b> {Math.round((h.share ?? 0) * 100)} % — «{h.example}»</li>)}</ul></div>
            {!!x.body.what_wins?.length && <div className="md:col-span-2"><div className={LABEL}>{T('Qué separa a los mejores', 'What sets the best apart')}</div><ul className="mt-1 list-disc pl-4 text-ink-2">{x.body.what_wins.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
          </div>
        </section>
      ))}
    </div>
  )
}

function Brands({ onPick }: { onPick: (b: string) => void }) {
  const T = useT()
  const [b, setB] = useState<{ brand: string; videos: number }[] | null>(null)
  useEffect(() => { api.adtierBrands().then((r) => setB(r.brands)).catch(() => {}) }, [])
  if (!b) return <Loader2 size={16} className="animate-spin text-ink-3" />
  return (
    <div className="flex flex-wrap gap-2">
      {b.map((x) => <button key={x.brand} onClick={() => onPick(x.brand)} className={PILL}>{x.brand} <span className="text-ink-4">{x.videos}</span></button>)}
      {!b.length && <p className="text-[13px] text-ink-4">{T('Todavía no hay marcas.', 'No brands yet.')}</p>}
    </div>
  )
}

function ApiInfo({ base }: { base: string }) {
  const T = useT()
  const mcp = `${base.replace(/\/$/, '')}/mcp/adtier`
  const cfg = JSON.stringify({ mcpServers: { adtier: { type: 'http', url: mcp } } }, null, 2)
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.ok(T('Copiado', 'Copied')))
  const rows: [string, string][] = [['GET /api/public/adtier/videos?tier=S&format=ugc&industry=fintech&q=…', T('Videos publicados con filtros (tier, format, industry, language, country, region=latam, min_s, max_s, q, page)', 'Published videos with filters (tier, format, industry, language, country, region=latam, min_s, max_s, q, page)')],
    ['GET /api/public/adtier/videos/{slug}', T('Ficha: tier y justificación, evidencia, scores y plantilla', 'Card: tier and reason, evidence, scores and template')], ['GET /api/public/adtier/templates/{slug}', T('Solo la plantilla', 'Just the template')]]
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="text-[15px] font-bold text-ink">{T('API pública de lectura', 'Public read API')}</h3>
        <ul className="mt-2 flex flex-col gap-2">{rows.map(([u, d]) => <li key={u}><code className="break-all text-[12px] text-ink">{base.replace(/\/$/, '')}{u.replace(/^GET /, '')}</code><p className="text-ink-3">{d}</p></li>)}</ul>
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="text-[15px] font-bold text-ink">{T('Servidor MCP', 'MCP server')}</h3>
        <p className="mt-1 text-ink-3">{T('Herramientas: search_videos, get_template, list_tiers. Conectalo en Claude, Cursor o tu agente y pedí «3 videos tier S formato UGC, industria fintech».', 'Tools: search_videos, get_template, list_tiers. Connect it in Claude, Cursor or your agent and ask for «3 tier S UGC videos in fintech».')}</p>
        <div className="mt-2 flex items-center gap-2"><code className="flex-1 break-all rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink">{mcp}</code><button onClick={() => copy(mcp)} className={PILL}><Copy size={13} /></button></div>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11.5px] text-ink-2">{cfg}</pre>
        <button onClick={() => copy(cfg)} className={`${PILL} mt-2`}><Copy size={13} /> {T('Copiar configuración', 'Copy configuration')}</button>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ «Para vos»: the ads this person needs */

const KIND_LABEL: Record<string, [string, string]> = { b2b: ['Vende a empresas (B2B)', 'Sells to businesses (B2B)'], b2c: ['Vende al público (B2C)', 'Sells to consumers (B2C)'], both: ['A empresas y al público', 'Businesses and consumers'], startup: ['Emprendimiento o startup', 'Startup'], freelance: ['Profesional independiente', 'Freelancer'], nonprofit: ['ONG o causa', 'Non-profit'], app: ['App o software', 'App or software'] }
const GOAL_LABEL: Record<string, [string, string]> = { awareness: ['Que me conozcan', 'Get known'], leads: ['Conseguir clientes / contactos', 'Get leads'], sales: ['Vender más', 'Sell more'], downloads: ['Descargas de la app', 'App downloads'], signups: ['Registros', 'Sign-ups'] }
const COUNTRIES: [string, string, string][] = [['AR', 'Argentina', 'Argentina'], ['MX', 'México', 'Mexico'], ['CO', 'Colombia', 'Colombia'], ['CL', 'Chile', 'Chile'], ['PE', 'Perú', 'Peru'], ['UY', 'Uruguay', 'Uruguay'], ['PY', 'Paraguay', 'Paraguay'], ['BO', 'Bolivia', 'Bolivia'], ['EC', 'Ecuador', 'Ecuador'], ['VE', 'Venezuela', 'Venezuela'], ['CR', 'Costa Rica', 'Costa Rica'], ['PA', 'Panamá', 'Panama'], ['GT', 'Guatemala', 'Guatemala'], ['DO', 'Rep. Dominicana', 'Dominican Rep.'], ['PR', 'Puerto Rico', 'Puerto Rico'], ['BR', 'Brasil', 'Brazil'], ['ES', 'España', 'Spain'], ['US', 'Estados Unidos', 'United States'], ['GB', 'Reino Unido', 'United Kingdom'], ['CA', 'Canadá', 'Canada'], ['FR', 'Francia', 'France'], ['IT', 'Italia', 'Italy'], ['DE', 'Alemania', 'Germany'], ['PT', 'Portugal', 'Portugal']]
const PLACEMENT_LABEL: Record<string, [string, string, string, string]> = { reels: ['Reels, TikTok y Shorts', 'Reels, TikTok and Shorts', 'verticales, hasta 60 s', 'vertical, up to 60 s'], stories: ['Historias', 'Stories', 'hasta 15 s', 'up to 15 s'], long: ['YouTube o TV', 'YouTube or TV', 'piezas largas, hasta 3 min', 'longer pieces, up to 3 min'] }
const WORKING = ['queued', 'meta', 'frames', 'transcribe', 'analyze']
const STAGE_LABEL: Record<string, [string, string]> = { queued: ['en cola', 'queued'], meta: ['leyendo datos', 'reading metadata'], frames: ['mirando cuadros', 'looking at frames'], transcribe: ['transcribiendo', 'transcribing'], analyze: ['analizando con Muse', 'analysing with Muse'], review: ['sin revisar', 'not reviewed'], error: ['no se pudo analizar', 'could not analyse'] }

function ForYou({ onOpen }: { onOpen: (id: string) => void }) {
  const T = useT()
  const [home, setHome] = useState<ForYouHome | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const load = () => api.foryou().then((h) => { setHome(h); setSel((s) => s ?? h.profiles[0]?.id ?? null); if (!h.profiles.length) setCreating(true) }).catch((e) => toast.error(T('No pude abrir «Para vos»', 'Could not open «For you»'), (e as Error).message))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!home) return <div className="flex items-center gap-2 py-10 text-ink-3"><Loader2 size={16} className="animate-spin" /> {T('Cargando…', 'Loading…')}</div>
  return (
    <div className="flex flex-col gap-4">
      {!home.model && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#C28A12]/40 bg-[#C28A12]/10 px-3 py-2.5 text-[13px] text-ink-2">
          <AlertTriangle size={15} className="text-[#C28A12]" />
          <span className="min-w-0 flex-1">{T('Sin la clave de Meta Muse el perfil sale solo de tus respuestas y los anuncios que encontremos no se pueden analizar.', 'Without the Meta Muse key the profile comes only from your answers and the ads we find cannot be analysed.')}</span>
          <button onClick={() => useArena.getState().set({ view: 'settings' })} className={PILL}><KeyRound size={14} /> {T('Agregar clave', 'Add key')}</button>
        </div>
      )}
      {home.profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {home.profiles.map((p) => (
            <button key={p.id} onClick={() => { setSel(p.id); setCreating(false) }} className={`flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] ${sel === p.id && !creating ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-ink-2 hover:border-accent'}`}>
              {p.source === 'tably' ? <Layers size={13} /> : <Building2 size={13} />} {p.name}
            </button>
          ))}
          <button onClick={() => setCreating(true)} className={PILL}><Plus size={14} /> {T('Otro negocio o proyecto', 'Another business or project')}</button>
        </div>
      )}
      {creating ? <ProfileWizard home={home} onCancel={home.profiles.length ? () => setCreating(false) : undefined} onCreated={(m) => { setCreating(false); setSel(m.profile.id); load() }} />
        : sel ? <ProfileView key={sel} id={sel} home={home} onOpen={onOpen} onDeleted={() => { setSel(null); load() }} /> : null}
    </div>
  )
}

function ProfileWizard({ home, onCancel, onCreated }: { home: ForYouHome; onCancel?: () => void; onCreated: (m: ForYouMatches) => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [mode, setMode] = useState<'pick' | 'tably' | 'form'>(home.projects.length ? 'pick' : 'form')
  const [busy, setBusy] = useState(false)
  const [a, setA] = useState<Record<string, string>>({ kind: 'b2c', goal: 'sales', country: '', sector: '', placement: 'reels' })
  const [doc, setDoc] = useState<{ name: string; text: string } | null>(null)
  const [accounts, setAccounts] = useState('')
  const set = (k: string, v: string) => setA((x) => ({ ...x, [k]: v }))
  const create = async (body: Record<string, string>) => {
    setBusy(true)
    try { onCreated(await api.foryouCreate({ ...body, accounts: splitAccounts(accounts) })) } catch (e) { toast.error(T('No pude crear el perfil', 'Could not create the profile'), (e as Error).message) } finally { setBusy(false) }
  }
  const chip = (on: boolean) => `rounded-full border px-3 py-1.5 text-[12.5px] transition ${on ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent'}`
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[19px] font-bold text-ink">{T('¿Para qué querés anuncios?', 'What do you want ads for?')}</h3>
          <p className="mt-1 text-[13px] text-ink-2">{T('Armamos el perfil de tu negocio y con eso te mostramos los anuncios del catálogo que te sirven y buscamos anuncios reales de tu rubro y tu país.', 'We build your business profile and use it to show you the catalogue ads that fit and to find real ads from your sector and country.')}</p>
        </div>
        {onCancel && <button onClick={onCancel} className="text-[12.5px] text-ink-3 underline">{T('Cancelar', 'Cancel')}</button>}
      </div>
      <div className="mt-4"><span className={LABEL}>{T('¿Dónde vas a publicar los anuncios?', 'Where will the ads run?')}</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">{Object.entries(PLACEMENT_LABEL).map(([k, [es, e2, ds, de]]) => <button type="button" key={k} onClick={() => set('placement', k)} className={chip(a.placement === k)}>{T(es, e2)} <span className="opacity-75">· {T(ds, de)}</span></button>)}</div></div>
      <div className="mt-4"><AccountsInput value={accounts} onChange={setAccounts} /></div>
      {mode === 'pick' && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button onClick={() => setMode('tably')} className="flex flex-col items-start gap-1 rounded-xl border border-line bg-paper p-4 text-left transition hover:border-accent">
            <Layers size={20} className="text-accent" />
            <span className="text-[15px] font-semibold text-ink">{T('Un proyecto que hice en Tably', 'A project I built in Tably')}</span>
            <span className="text-[12.5px] text-ink-3">{T('Lo leemos solos (brief, README y pantallas) y armamos el perfil. No tenés que contestar nada.', 'We read it ourselves (brief, README and screens) and build the profile. Nothing to answer.')}</span>
          </button>
          <button onClick={() => setMode('form')} className="flex flex-col items-start gap-1 rounded-xl border border-line bg-paper p-4 text-left transition hover:border-accent">
            <Building2 size={20} className="text-accent" />
            <span className="text-[15px] font-semibold text-ink">{T('Mi empresa o un proyecto fuera de Tably', 'My company or a project outside Tably')}</span>
            <span className="text-[12.5px] text-ink-3">{T('Contestás unas preguntas: a qué se dedica, el sector, el país. Podés sumar tu web o un documento.', 'You answer a few questions: what it does, the sector, the country. You can add your website or a document.')}</span>
          </button>
        </div>
      )}
      {mode === 'tably' && (
        <div className="mt-4 flex flex-col gap-2">
          <button onClick={() => setMode('pick')} className="self-start text-[12.5px] text-ink-3 underline">← {T('Volver', 'Back')}</button>
          {home.projects.map((p) => (
            <button key={p.session_id} disabled={busy} onClick={() => create({ session_id: p.session_id, build_id: p.build_id, placement: a.placement })} className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2.5 text-left transition hover:border-accent disabled:opacity-50">
              <Layers size={16} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{p.title || T('Proyecto sin título', 'Untitled project')}</span>
              <span className="shrink-0 text-[11.5px] text-ink-3">{new Date(p.updated * 1000).toLocaleDateString()}</span>
            </button>
          ))}
          {busy && <p className="flex items-center gap-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {T('Muse está leyendo el proyecto y armando el perfil…', 'Muse is reading the project and building the profile…')}</p>}
        </div>
      )}
      {mode === 'form' && (
        <div className="mt-4 grid gap-4">
          {home.projects.length > 0 && <button onClick={() => setMode('pick')} className="self-start text-[12.5px] text-ink-3 underline">← {T('Volver', 'Back')}</button>}
          <div className="grid gap-4 sm:grid-cols-2">
            <label><span className={LABEL}>{T('Nombre de la empresa o proyecto', 'Company or project name')}</span><input value={a.name ?? ''} onChange={(e) => set('name', e.target.value)} className={`${INPUT} mt-1`} placeholder={T('Ej.: Pizzería Don Carlo', 'E.g. Don Carlo Pizza')} /></label>
            <label><span className={LABEL}>{T('País', 'Country')}</span>
              <select value={a.country} onChange={(e) => set('country', e.target.value)} className={`${INPUT} mt-1`}><option value="">{T('Elegí el país', 'Pick the country')}</option>{COUNTRIES.map(([c, es, e2]) => <option key={c} value={c}>{en ? e2 : es}</option>)}</select></label>
          </div>
          <label><span className={LABEL}>{T('¿A qué se dedica?', 'What does it do?')}</span>
            <textarea value={a.description ?? ''} onChange={(e) => set('description', e.target.value)} rows={3} className={`${INPUT} mt-1`} placeholder={T('Ej.: Pizzería con delivery en Córdoba, masa madre, abierta de noche. Vendemos sobre todo por WhatsApp y apps de delivery.', 'E.g. A pizza place with delivery in Córdoba, sourdough, open at night. We sell mostly through WhatsApp and delivery apps.')} /></label>
          <div><span className={LABEL}>{T('Sector', 'Sector')}</span>
            <select value={a.sector} onChange={(e) => set('sector', e.target.value)} className={`${INPUT} mt-1`}><option value="">{T('Elegí el sector', 'Pick the sector')}</option>{home.sectors.map((s) => <option key={s.id} value={s.id}>{en ? s.en : s.es}</option>)}</select></div>
          <div><span className={LABEL}>{T('Tipo de negocio', 'Kind of business')}</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">{home.kinds.map((k) => <button type="button" key={k} onClick={() => set('kind', k)} className={chip(a.kind === k)}>{T(...(KIND_LABEL[k] ?? [k, k]))}</button>)}</div></div>
          <div><span className={LABEL}>{T('¿Qué querés lograr con los anuncios?', 'What do you want the ads to achieve?')}</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">{home.goals.map((k) => <button type="button" key={k} onClick={() => set('goal', k)} className={chip(a.goal === k)}>{T(...(GOAL_LABEL[k] ?? [k, k]))}</button>)}</div></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label><span className={LABEL}>{T('¿A quién le vendés? (opcional)', 'Who do you sell to? (optional)')}</span><input value={a.audience ?? ''} onChange={(e) => set('audience', e.target.value)} className={`${INPUT} mt-1`} placeholder={T('Ej.: familias y estudiantes del barrio', 'E.g. families and students nearby')} /></label>
            <label><span className={LABEL}>{T('Tu web o Instagram (opcional)', 'Your website or Instagram (optional)')}</span><input value={a.website ?? ''} onChange={(e) => set('website', e.target.value)} className={`${INPUT} mt-1`} placeholder="www.tuempresa.com" /></label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${PILL} cursor-pointer`}><Upload size={14} /> {doc ? doc.name : T('Subir un documento del proyecto (PDF o texto)', 'Upload a project document (PDF or text)')}
              <input type="file" accept=".pdf,.md,.txt" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setDoc(await api.foryouDoc(f)) } catch (err) { toast.error(T('No pude leer el documento', 'Could not read the document'), (err as Error).message) } }} />
            </label>
            {doc && <span className="text-[12px] text-ink-3">{doc.text.length.toLocaleString()} {T('caracteres leídos', 'characters read')} · <button onClick={() => setDoc(null)} className="underline">{T('quitar', 'remove')}</button></span>}
          </div>
          <button disabled={busy || (!a.description?.trim() && !doc && !a.website?.trim())} onClick={() => create({ ...a, docs: doc?.text ?? '' })} className={`${PRIMARY} self-start`}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} {busy ? T('Armando tu perfil…', 'Building your profile…') : T('Armar mi perfil y buscar anuncios', 'Build my profile and find ads')}
          </button>
        </div>
      )}
    </div>
  )
}

function ProfileView({ id, home, onOpen, onDeleted }: { id: string; home: ForYouHome; onOpen: (id: string) => void; onDeleted: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [m, setM] = useState<ForYouMatches | null>(null)
  const [edit, setEdit] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const load = () => api.foryouGet(id).then(setM).catch((e) => toast.error(T('No pude leer el perfil', 'Could not read the profile'), (e as Error).message))
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  // while the search runs or the found ads are analysed, the list fills in by itself
  useEffect(() => {
    if (!m || !(m.searching || m.ideating || m.profile.data.uploads?.some((u) => u.status === 'reading') || m.found.some((v) => WORKING.includes(v.stage ?? '')))) return
    const t = window.setTimeout(load, 5000)
    return () => window.clearTimeout(t)
  }, [m]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return <div className="flex items-center gap-2 py-10 text-ink-3"><Loader2 size={16} className="animate-spin" /> {T('Cargando…', 'Loading…')}</div>
  const p = m.profile.data
  const sector = home.sectors.find((s) => s.id === p.sector)
  const country = COUNTRIES.find((c) => c[0] === p.country)
  const save = async () => {
    try {
      setM(await api.foryouEdit(id, { ...draft, keywords: (draft.keywords ?? p.keywords.join(', ')).split(',').map((x) => x.trim()).filter(Boolean) }))
      setEdit(false)
    } catch (e) { toast.error(T('No pude guardar', 'Could not save'), (e as Error).message) }
  }
  const working = m.found.filter((v) => WORKING.includes(v.stage ?? '')).length
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-accent">{m.profile.source === 'tably' ? T('Perfil armado desde tu proyecto en Tably', 'Profile built from your Tably project') : T('Perfil de tu negocio', 'Your business profile')}</div>
            <h3 className="mt-0.5 text-[20px] font-bold leading-tight text-ink">{p.name}</h3>
            {p.summary && <p className="mt-1 max-w-[760px] text-[13.5px] text-ink-2">{p.summary}</p>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => { setDraft({}); setEdit((x) => !x) }} className={PILL}>{T('Corregir el perfil', 'Fix the profile')}</button>
            <button disabled={m.searching} onClick={() => api.foryouSearch(id).then(setM).catch((e) => toast.error(T('No pude buscar', 'Could not search'), (e as Error).message))} className={PRIMARY}>
              {m.searching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {m.searching ? T('Buscando…', 'Searching…') : T('Buscar más anuncios', 'Find more ads')}
            </button>
            <button onClick={() => { if (confirm(T('¿Borrar este perfil? Los anuncios encontrados quedan en el catálogo.', 'Delete this profile? The ads found stay in the catalogue.'))) api.foryouDelete(id).then(onDeleted) }} className={PILL} aria-label={T('Borrar el perfil', 'Delete the profile')}><Trash2 size={14} /></button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
          {sector && <span className="rounded-full bg-accent-soft px-2.5 py-1 font-semibold text-accent">{en ? sector.en : sector.es}</span>}
          {p.kind && <span className="rounded-full border border-line px-2.5 py-1 text-ink-2">{T(...(KIND_LABEL[p.kind] ?? [p.kind, p.kind]))}</span>}
          {country && <span className="rounded-full border border-line px-2.5 py-1 text-ink-2">{en ? country[2] : country[1]}</span>}
          {p.placement && <span className="rounded-full border border-accent/50 px-2.5 py-1 text-accent">{T(PLACEMENT_LABEL[p.placement][0], PLACEMENT_LABEL[p.placement][1])} · {T(PLACEMENT_LABEL[p.placement][2], PLACEMENT_LABEL[p.placement][3])}</span>}
          {p.goal && <span className="rounded-full border border-line px-2.5 py-1 text-ink-2">{T(...(GOAL_LABEL[p.goal] ?? [p.goal, p.goal]))}</span>}
          {p.audience && <span className="rounded-full border border-line px-2.5 py-1 text-ink-2">{T('Para', 'For')}: {p.audience}</span>}
        </div>
        {p.keywords.length > 0 && <p className="mt-2 text-[12px] text-ink-3">{T('Palabras clave', 'Keywords')}: {p.keywords.join(' · ')}</p>}
        {p.why && <p className="mt-1 text-[12.5px] text-ink-2">💡 {p.why}</p>}
        {edit && (
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <label><span className={LABEL}>{T('Sector', 'Sector')}</span><select defaultValue={p.sector} onChange={(e) => setDraft((d) => ({ ...d, sector: e.target.value }))} className={`${INPUT} mt-1`}>{home.sectors.map((s) => <option key={s.id} value={s.id}>{en ? s.en : s.es}</option>)}</select></label>
            <label><span className={LABEL}>{T('País', 'Country')}</span><select defaultValue={p.country} onChange={(e) => setDraft((d) => ({ ...d, country: e.target.value }))} className={`${INPUT} mt-1`}><option value="">—</option>{COUNTRIES.map(([c, es, e2]) => <option key={c} value={c}>{en ? e2 : es}</option>)}</select></label>
            <label className="sm:col-span-2"><span className={LABEL}>{T('Dónde se publican', 'Where they run')}</span><select defaultValue={p.placement ?? 'reels'} onChange={(e) => setDraft((d) => ({ ...d, placement: e.target.value }))} className={`${INPUT} mt-1`}>{Object.entries(PLACEMENT_LABEL).map(([k, [es, e2, ds, de]]) => <option key={k} value={k}>{T(`${es} · ${ds}`, `${e2} · ${de}`)}</option>)}</select></label>
            <label className="sm:col-span-2"><span className={LABEL}>{T('Qué hace', 'What it does')}</span><input defaultValue={p.summary} onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))} className={`${INPUT} mt-1`} /></label>
            <label className="sm:col-span-2"><span className={LABEL}>{T('Palabras clave (separadas por coma)', 'Keywords (comma-separated)')}</span><input defaultValue={p.keywords.join(', ')} onChange={(e) => setDraft((d) => ({ ...d, keywords: e.target.value }))} className={`${INPUT} mt-1`} /></label>
            <button onClick={save} className={`${PRIMARY} self-start`}><CheckCircle2 size={14} /> {T('Guardar', 'Save')}</button>
          </div>
        )}
      </div>

      <ReelIdeas m={m} home={home} onChange={setM} />

      <section>
        <h4 className="text-[15px] font-bold text-ink">{T('Del catálogo, para vos', 'From the catalogue, for you')}</h4>
        <p className="text-[12.5px] text-ink-3">{T('Anuncios premiados ordenados por cuánto se parecen a tu negocio: rubro, país, idioma y formato. Solo los de un largo que te sirve.', 'Award-winning ads ranked by how close they are to your business: sector, country, language and format. Only the ones of a useful length.')}</p>
        {m.catalog.length ? (
          <div className="mt-3 grid grid-cols-1 gap-3 min-[460px]:grid-cols-2 lg:grid-cols-4">
            {m.catalog.map((v) => (
              <div key={v.id} className="flex flex-col gap-1.5">
                <Thumb v={v} onOpen={onOpen} big />
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-3"><span className="rounded bg-accent-soft px-1.5 py-0.5 font-semibold text-accent">{v.match}%</span>{v.why.join(' · ')}</div>
              </div>
            ))}
          </div>
        ) : <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-3">{T('Todavía no hay anuncios del catálogo de tu rubro. Los que buscamos para vos aparecen abajo.', 'No catalogue ads from your sector yet. The ones we search for you show up below.')}</p>}
      </section>

      <section>
        <h4 className="text-[15px] font-bold text-ink">{T('Anuncios reales de tu rubro y tu país', 'Real ads from your sector and country')}</h4>
        <p className="text-[12.5px] text-ink-3">{T('Los buscamos en YouTube con tu perfil y los analizamos con Muse igual que al catálogo: tier por score, hook, estructura y CTA. No tienen premio verificado, así que llegan como «sin revisar».', 'We search YouTube with your profile and analyse them with Muse like the catalogue: score tier, hook, structure and CTA. They have no verified award, so they arrive as «not reviewed».')}</p>
        {!!m.other_length && <p className="mt-1 text-[12px] text-ink-4">{T(`Hay ${m.other_length} más de otro largo: no se muestran porque elegiste ${PLACEMENT_LABEL[p.placement ?? 'reels'][2]}.`, `There are ${m.other_length} more of another length: hidden because you picked ${PLACEMENT_LABEL[p.placement ?? 'reels'][3]}.`)}</p>}
        {(m.searching || working > 0) && <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {m.searching ? T('Buscando anuncios con: ', 'Searching ads with: ') + p.queries.map((q) => `«${q}»`).join(', ') : T(`Analizando ${working} anuncios con Muse: aparecen a medida que terminan.`, `Analysing ${working} ads with Muse: they show up as they finish.`)}</p>}
        {m.found.length ? (
          <div className="mt-3 grid grid-cols-1 gap-3 min-[460px]:grid-cols-2 lg:grid-cols-4">
            {m.found.map((v) => (
              <div key={v.id} className="flex flex-col gap-1.5">
                <Thumb v={v} onOpen={onOpen} big />
                <div className={`text-[11px] ${v.stage === 'error' ? 'text-danger' : 'text-ink-3'}`}>{v.reviewed ? T('revisado y publicado', 'reviewed and published') : T(...(STAGE_LABEL[v.stage ?? ''] ?? ['', '']))}{v.stage === 'error' && v.error ? ` · ${v.error.slice(0, 90)}` : ''}</div>
              </div>
            ))}
          </div>
        ) : !m.searching && <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-3">{m.profile.searched ? T('No encontramos anuncios con estas búsquedas. Corregí el perfil (palabras clave o sector) y buscá de nuevo.', 'We found no ads with these searches. Fix the profile (keywords or sector) and search again.') : T('Tocá «Buscar más anuncios» para empezar.', 'Tap «Find more ads» to start.')}</p>}
      </section>
    </div>
  )
}

const splitAccounts = (text: string) => text.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /[a-z0-9]/i.test(x)).slice(0, 5)
const PLATFORM_LABEL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube Shorts' }
const num = (n?: number | null) => (n == null ? '' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 100) / 10} k` : String(n))

function AccountsInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const T = useT()
  return (
    <label className="block">
      <span className={LABEL}>{T('Cuentas que te gustan (opcional)', 'Accounts you like (optional)')}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} className={`${INPUT} mt-1 font-mono text-[12.5px]`}
        placeholder={T('instagram.com/tu_competencia\nfacebook.com/tu_pagina · tiktok.com/@una_marca · @otra_cuenta', 'instagram.com/a_competitor\nfacebook.com/your_page · tiktok.com/@a_brand · @another_account')} />
      <span className="mt-1 block text-[11.5px] text-ink-3">{T('Hasta 5 cuentas de Instagram, Facebook, TikTok o YouTube (la tuya o de marcas que admirás). Miramos sus reels y te escribimos 5 reels para grabar.', 'Up to 5 Instagram, Facebook, TikTok or YouTube accounts (yours or brands you admire). We look at their reels and write you 5 reels to shoot.')}</span>
    </label>
  )
}

/** «5 reels para hacer»: the reference accounts, what was read from each one and the five reels Muse writes from them. */
function ReelIdeas({ m, home, onChange }: { m: ForYouMatches; home: ForYouHome; onChange: (m: ForYouMatches) => void }) {
  const T = useT()
  const p = m.profile.data
  const id = m.profile.id
  const [text, setText] = useState((p.accounts ?? []).join('\n'))
  const [open, setOpen] = useState(!p.accounts?.length)
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState(false)
  const [ups, setUps] = useState<{ name: string; p: number }[]>([])
  const [drag, setDrag] = useState(false)
  const [meta, setMeta] = useState(home.meta)  // changes here when the admin enables Meta or the person connects it
  const refs = p.refs ?? []
  const run = async (accounts?: string[]) => {
    setBusy(true)
    try { onChange(await api.foryouIdeas(id, accounts)); setOpen(false) } catch (e) { toast.error(T('No pude leer esas cuentas', 'Could not read those accounts'), (e as Error).message) } finally { setBusy(false) }
  }
  // connecting Meta (with Instagram) happens in a popup; when it says «ok», read the accounts again
  useEffect(() => {
    const on = (e: MessageEvent) => { if (e.data?.tablyMetaAds === 'ok') { setMeta((x) => x && { ...x, connected: true, instagram: true }); run() } else if (e.data?.tablyMetaAds === 'error') toast.error(T('No se conectó Meta', 'Meta was not connected'), String(e.data.message || '')) }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const connect = async () => {
    try {
      const { url } = await api.metaAdsStart('instagram')
      const w = window.open(url, 'tably-meta-ads', 'width=620,height=760')
      if (!w) location.href = url
    } catch (e) { toast.error(T('No se pudo conectar Meta', 'Could not connect Meta'), (e as Error).message) }
  }
  const working = busy || !!m.ideating
  const uploads = p.uploads ?? []
  const readyUps = uploads.filter((u) => u.status === 'ready')
  const reading = uploads.some((u) => u.status === 'reading') || ups.length > 0
  const upload = async (files: File[]) => {
    for (const f of files.slice(0, 6)) {
      setUps((u) => [...u, { name: f.name, p: 0 }])
      try { onChange(await api.foryouUpload(id, f, (x) => setUps((u) => u.map((it) => (it.name === f.name ? { ...it, p: x } : it))))) }
      catch (e) { toast.error(T(`No pude subir ${f.name}`, `Could not upload ${f.name}`), (e as Error).message) }
      finally { setUps((u) => u.filter((it) => it.name !== f.name)) }
    }
  }
  // what each idea's «inspired by #n» points to: the uploaded reels first (as they were when the ideas were written), then the accounts' reels
  const sources = [...(p.ideas_ups ?? []).map((rid) => { const u = uploads.find((x) => x.id === rid); return { label: T('tu reel', 'your reel') + (u ? ` «${u.name.slice(0, 24)}»` : ''), url: null as string | null } }),
    ...refs.map((r) => ({ label: `@${r.account}`, url: r.url as string | null }))]
  // what an account that Meta did not let us read needs now (the note was written when it was read; Meta may be on since)
  const act = (n: NonNullable<typeof p.notes>[number]) => {
    if (n.via === n.platform || !['instagram', 'facebook'].includes(n.platform)) return null
    if (!meta?.ready) return 'enable_meta'
    return !meta.connected || (n.platform === 'instagram' && !meta.instagram) ? 'connect_meta' : null
  }
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-[15px] font-bold text-ink"><Sparkles size={15} className="text-accent" /> {T('5 reels para hacer', '5 reels to make')}</h4>
          <p className="text-[12.5px] text-ink-3">{T('Pegá cuentas que te gusten o subí reels de otras marcas: miramos qué les funciona y te escribimos 5 reels para tu negocio, con gancho, tomas, texto en pantalla y cierre.', 'Paste accounts you like or upload reels from other brands: we see what works for them and write 5 reels for your business, with hook, shots, on-screen text and close.')}</p>
        </div>
        {!open && <button onClick={() => setOpen(true)} className={PILL}><Link2 size={14} /> {p.accounts?.length ? T('Cambiar cuentas', 'Change accounts') : T('Agregar cuentas', 'Add accounts')}</button>}
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <AccountsInput value={text} onChange={setText} />
        </div>
      )}
      <div className="mt-4">
        <div className={LABEL}>{T('Reels que te gustan', 'Reels you like')}</div>
        <p className="mt-0.5 text-[12px] text-ink-3">{T('Guardá o grabá la pantalla de reels de otras marcas y subilos (o capturas). Los miramos cuadro por cuadro, escuchamos lo que dicen y te escribimos reels iguales para tu negocio. El video no se guarda: quedan solo los cuadros y la transcripción.', 'Save or screen-record reels from other brands and upload them (or screenshots). We look at them frame by frame, listen to what is said and write you the same reels for your business. The video is not kept: only the frames and the transcript.')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {uploads.map((u) => (
            <div key={u.id} className="relative w-[96px] shrink-0">
              <div className="relative aspect-[9/16] overflow-hidden rounded-lg bg-black">
                {u.status === 'ready' && <img src={api.foryouUploadUrl(id, u.id, 'thumb.jpg')} alt={u.name} className="h-full w-full object-cover" />}
                {u.status === 'reading' && <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[10px] text-white/80"><Loader2 size={16} className="animate-spin" /> {T('mirando…', 'looking…')}</span>}
                {u.status === 'error' && <span className="absolute inset-0 flex items-center justify-center p-1.5 text-center text-[10px] text-[#FF8A8A]">{u.error}</span>}
                <button onClick={() => api.foryouUploadDelete(id, u.id).then(onChange).catch(() => {})} aria-label={T('Quitar', 'Remove')} className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white hover:bg-black"><X size={12} /></button>
              </div>
              <div className="mt-0.5 truncate text-[10.5px] text-ink-3" title={u.name}>{u.status === 'ready' ? (u.kind === 'image' ? T('captura', 'screenshot') : `${Math.round(u.duration ?? 0)} s · ${u.heard ? T('con voz', 'with voice') : T('sin voz', 'no voice')}`) : u.name}</div>
            </div>
          ))}
          {ups.map((u) => (
            <div key={u.name} className="flex aspect-[9/16] w-[96px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-[10.5px] text-ink-3"><Loader2 size={14} className="animate-spin text-accent" /> {Math.round(u.p * 100)}%</div>
          ))}
          {uploads.length + ups.length < 6 && (
            <label onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]) }}
              className={`flex aspect-[9/16] w-[96px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center text-[10.5px] transition ${drag ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-3 hover:border-accent hover:text-accent'}`}>
              <Upload size={16} /> {T('Subir reel o captura', 'Upload reel or screenshot')}
              <input type="file" multiple accept="video/*,image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = '' }} />
            </label>
          )}
        </div>
        {((open && (splitAccounts(text).length > 0 || readyUps.length > 0)) || (!open && readyUps.length > 0)) && (
          <button disabled={working || reading} onClick={() => run(open ? splitAccounts(text) : undefined)} className={`${PRIMARY} mt-3`}>
            {working ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {readyUps.length ? T('Escribir 5 reels como estos', 'Write 5 reels like these') : T('Mirar sus reels y escribir 5 ideas', 'Look at their reels and write 5 ideas')}
          </button>
        )}
        {reading && <p className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-2"><Loader2 size={13} className="animate-spin text-accent" /> {T('Mirando los reels y escuchando lo que dicen…', 'Looking at the reels and listening to what they say…')}</p>}
      </div>
      {!!p.notes?.length && (
        <div className="mt-3 flex flex-col gap-1.5">
          {p.notes.map((n) => (
            <div key={n.account} className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${n.count ? 'border-line text-ink-2' : 'border-[#C28A12]/40 bg-[#C28A12]/10 text-ink-2'}`}>
              <span className="font-semibold text-ink">@{n.handle}</span>
              <span className="min-w-0 flex-1">
                {n.count ? T(`${n.count} reels leídos de ${PLATFORM_LABEL[n.via ?? ''] ?? n.via}`, `${n.count} reels read from ${PLATFORM_LABEL[n.via ?? ''] ?? n.via}`) : ''}
                {n.count && n.via !== n.platform ? T(` (en ${PLATFORM_LABEL[n.platform]} no se pudo: ${n.problem ?? 'sin reels públicos'})`, ` (${PLATFORM_LABEL[n.platform]} could not be read: ${n.problem ?? 'no public reels'})`) : ''}
                {!n.count && n.problem}
              </span>
              {act(n) === 'connect_meta' && <button onClick={connect} className={PRIMARY}><Link2 size={14} /> {T('Conectar Meta', 'Connect Meta')}</button>}
              {act(n) === 'enable_meta' && meta?.admin && !setup && <button onClick={() => setSetup(true)} className={PRIMARY}><KeyRound size={14} /> {T('Habilitar Meta', 'Enable Meta')}</button>}
              {!n.count && !(act(n) === 'enable_meta' && meta?.admin) && act(n) !== 'connect_meta' && <button onClick={() => setOpen(true)} className={PILL}><Link2 size={14} /> {T('Cambiar la cuenta', 'Change the account')}</button>}
            </div>
          ))}
          {setup && <MetaSetup onDone={() => { setSetup(false); setMeta((x) => x && { ...x, ready: true }) }} onCancel={() => setSetup(false)} />}
          {!home.model && <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2"><AlertTriangle size={14} className="text-[#C28A12]" /> {T('Para escribir las ideas hace falta la clave de Meta Muse.', 'Writing the ideas needs the Meta Muse key.')} <button onClick={() => useArena.getState().set({ view: 'settings' })} className={PILL}><KeyRound size={14} /> {T('Agregar clave', 'Add key')}</button></div>}
        </div>
      )}
      {working && <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {T('Mirando los reels de esas cuentas y escribiendo tus 5 reels con Muse…', 'Looking at those accounts’ reels and writing your 5 reels with Muse…')}</p>}
      {p.ideas_error && !working && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-danger">{p.ideas_error} <button onClick={() => run()} className={PILL}><RefreshCw size={14} /> {T('Probar de nuevo', 'Try again')}</button></div>
      )}
      {refs.length > 0 && (
        <div className="mt-4">
          <div className={LABEL}>{T('Sus reels que más funcionaron', 'Their best-performing reels')}</div>
          <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1 scroll-thin">
            {refs.slice(0, 12).map((r, i) => (
              <a key={r.url + i} href={r.url} target="_blank" rel="noreferrer" title={r.caption} className="relative aspect-[9/16] w-[92px] shrink-0 overflow-hidden rounded-lg bg-black">
                {r.thumb && <img src={r.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover opacity-90" />}
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9.5px] font-semibold text-white">{i + 1}</span>
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] leading-tight text-white">
                  @{r.account}<br />{r.views ? <><Eye size={9} className="inline" /> {num(r.views)} </> : null}{r.likes ? <><Heart size={9} className="inline" /> {num(r.likes)}</> : null}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
      {!!p.ideas?.length && !working && (() => {
        // say plainly where the ideas come from: an account whose reels could not be read gave nothing to them
        const read = [...((p.ideas_ups ?? []).length ? [T('los reels que subiste', 'the reels you uploaded')] : []), ...(p.notes ?? []).filter((n) => n.count > 0).map((n) => T(`los reels de @${n.handle}`, `the reels of @${n.handle}`))]
        const missed = (p.notes ?? []).filter((n) => !n.count).map((n) => `@${n.handle}`)
        if (!missed.length) return null
        return (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#C28A12]/40 bg-[#C28A12]/10 px-3 py-2 text-[12.5px] text-ink-2">
            <AlertTriangle size={14} className="shrink-0 text-[#C28A12]" />
            <span className="min-w-0 flex-1">{read.length
              ? T(`Estas ideas salen de ${read.join(' y ')}. De ${missed.join(', ')} no pudimos leer nada, así que no las inspiró.`, `These ideas come from ${read.join(' and ')}. Nothing could be read from ${missed.join(', ')}, so it did not inspire them.`)
              : T(`Estas ideas salen de tu rubro (anuncios que encontramos para tu perfil), no de ${missed.join(', ')}: no pudimos leer sus reels.`, `These ideas come from your sector (ads we found for your profile), not from ${missed.join(', ')}: we could not read their reels.`)}</span>
            <button onClick={() => setOpen(true)} className={PILL}><Link2 size={14} /> {T('Pegar su TikTok o YouTube', 'Paste their TikTok or YouTube')}</button>
          </div>
        )
      })()}
      {p.patterns && <p className="mt-3 text-[12.5px] text-ink-2">💡 {p.patterns}</p>}
      {!!p.ideas?.length && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {p.ideas.map((it, i) => <IdeaCard key={i} n={i + 1} it={it} sources={sources} goal={p.goal} />)}
        </div>
      )}
      {!!p.ideas?.length && !working && <button onClick={() => run()} className={`${PILL} mt-3`}><RefreshCw size={14} /> {T('Escribir otras 5', 'Write 5 more')}</button>}
    </section>
  )
}

function IdeaCard({ n, it, sources, goal }: { n: number; it: ReelIdea; sources: { label: string; url: string | null }[]; goal: string }) {
  const T = useT()
  const [making, setMaking] = useState(false)
  const script = [`${it.title} (${it.duration_s} s)`, `Gancho: ${it.hook}`, ...it.beats.map((b) => `${b.t}: ${b.shot}${b.text ? ` · texto: «${b.text}»` : ''}${b.voice ? ` · voz: «${b.voice}»` : ''}`),
    `Cierre: ${it.cta}`, it.audio ? `Audio: ${it.audio}` : ''].filter(Boolean).join('\n')
  const make = async () => {
    setMaking(true)
    try {
      const sp = await api.studioCreate({ title: it.title.slice(0, 80), instructions: script.slice(0, 2000), link: '', goal: goal === 'awareness' ? 'awareness' : goal === 'signups' || goal === 'leads' || goal === 'downloads' ? 'signup' : 'sell', lang: T('es', 'en') })
      useArena.getState().set({ studioOpen: sp.id, view: 'studio' })
    } catch (e) { toast.error(T('No se pudo crear el anuncio', 'Could not create the ad'), (e as Error).message) } finally { setMaking(false) }
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-3.5">
      <div className="flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-white">{n}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-snug text-ink">{it.title}</div>
          <div className="text-[11.5px] text-ink-3">{it.duration_s} s{it.based_on.length ? ' · ' + T('inspirado en', 'inspired by') + ' ' : ''}
            {it.based_on.map((k, j) => { const src = sources[k - 1]; if (!src) return null; const label = `${j ? ', ' : ''}${src.label}`
              return src.url ? <a key={k} href={src.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{label}</a> : <span key={k} className="text-accent">{label}</span> })}</div>
        </div>
      </div>
      {it.why && <p className="text-[12.5px] text-ink-2">{it.why}</p>}
      <p className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12.5px] text-ink"><b className="text-accent">{T('Gancho', 'Hook')}:</b> {it.hook}</p>
      <ol className="flex flex-col gap-1 text-[12.5px] text-ink-2">
        {it.beats.map((b, j) => (
          <li key={j} className="flex gap-2"><span className="w-[52px] shrink-0 font-mono text-[11px] text-ink-3">{b.t}</span>
            <span className="min-w-0">{b.shot}{b.text && <span className="text-ink"> · «{b.text}»</span>}{b.voice && <span className="italic text-ink-3"> · {b.voice}</span>}</span></li>
        ))}
      </ol>
      <p className="text-[12.5px] text-ink-2"><b className="text-ink">{T('Cierre', 'Close')}:</b> {it.cta}</p>
      {it.audio && <p className="text-[12px] text-ink-3">🎵 {it.audio}</p>}
      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        <button onClick={make} disabled={making} className={PRIMARY}>{making ? <Loader2 size={14} className="animate-spin" /> : <Clapperboard size={14} />} {T('Hacer este reel', 'Make this reel')}</button>
        <button onClick={() => navigator.clipboard.writeText(`${script}\n\n${it.caption}`).then(() => toast.ok(T('Guion copiado', 'Script copied')))} className={PILL}><Copy size={14} /> {T('Copiar guion y texto', 'Copy script and caption')}</button>
      </div>
    </div>
  )
}

/** The admin turns on the connection with Meta once for the whole installation: the Meta app's ID and secret, and the
 *  address Meta has to send people back to. Then «Conectar Meta» works for everyone. */
function MetaSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const T = useT()
  const [st, setSt] = useState<MetaApp | null>(null)
  const [aid, setAid] = useState('')
  const [sec, setSec] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.metaApp().then((s) => { setSt(s); setAid(s.app_id ?? '') }).catch(() => {}) }, [])
  const save = async () => {
    setBusy(true)
    try {
      const s = await api.metaAppSet({ app_id: aid.trim(), app_secret: sec.trim() || undefined })
      setSt(s)
      if (s.configured) { toast.ok(T('Meta quedó habilitado', 'Meta is enabled'), T('Ahora tocá «Conectar Meta» para leer Instagram con tu cuenta.', 'Now tap «Connect Meta» to read Instagram with your account.')); onDone() }
    } catch (e) { toast.error(T('No pude guardar', 'Could not save'), (e as Error).message) } finally { setBusy(false) }
  }
  if (!st) return <div className="flex items-center gap-2 py-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin" /></div>
  const step = 'flex gap-2 text-[12.5px] text-ink-2'
  return (
    <div className="mt-1 flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-soft/40 p-3.5">
      <div className="text-[13.5px] font-semibold text-ink">{T('Habilitar la conexión con Meta (una sola vez, para todo Tably)', 'Enable the Meta connection (once, for all of Tably)')}</div>
      <ol className="flex flex-col gap-1.5">
        <li className={step}><b>1.</b><span>{T('Entrá a ', 'Go to ')}<a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer" className="text-accent underline">developers.facebook.com/apps</a>{T(' y creá una app de tipo «Empresa» (o abrí la que ya tengas).', ' and create a «Business» app (or open the one you have).')}</span></li>
        <li className={step}><b>2.</b><span>{T('Agregale «Inicio de sesión con Facebook para empresas», «API de marketing» e «API de Instagram». En Inicio de sesión → Configuración, pegá esta dirección en «URI de redireccionamiento de OAuth válidos»:', 'Add «Facebook Login for Business», «Marketing API» and «Instagram API». In Login → Settings, paste this address under «Valid OAuth redirect URIs»:')}</span></li>
        <li className="flex items-center gap-2 pl-5"><code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[12px] text-ink">{st.redirect_uri}</code>
          <button onClick={() => navigator.clipboard.writeText(st.redirect_uri).then(() => toast.ok(T('Dirección copiada', 'Address copied')))} className={PILL}><Copy size={14} /> {T('Copiar', 'Copy')}</button></li>
        <li className={step}><b>3.</b><span>{T('En Configuración → Básica copiá el «Identificador de la app» y la «Clave secreta» y pegalos acá:', 'In Settings → Basic copy the «App ID» and «App secret» and paste them here:')}</span></li>
      </ol>
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={aid} onChange={(e) => setAid(e.target.value)} placeholder={T('Identificador de la app (App ID)', 'App ID')} className={INPUT} inputMode="numeric" />
        <input value={sec} onChange={(e) => setSec(e.target.value)} placeholder={st.has_secret ? T('Clave secreta (ya cargada; dejala vacía para no cambiarla)', 'App secret (already set; leave empty to keep it)') : T('Clave secreta de la app', 'App secret')} className={INPUT} type="password" autoComplete="off" />
      </div>
      <p className="text-[11.5px] text-ink-3">{T('Mientras Meta no apruebe la app (revisión de la app), solo funciona con las cuentas que sean administradoras o testers de esa app. La clave se guarda cifrada y nunca vuelve al navegador.', 'Until Meta approves the app (App Review), it only works with accounts that are admins or testers of that app. The secret is stored encrypted and never goes back to the browser.')}</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || !aid.trim() || (!sec.trim() && !st.has_secret)} onClick={save} className={PRIMARY}>{busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {T('Guardar', 'Save')}</button>
        <button onClick={onCancel} className={PILL}>{T('Cancelar', 'Cancel')}</button>
      </div>
    </div>
  )
}

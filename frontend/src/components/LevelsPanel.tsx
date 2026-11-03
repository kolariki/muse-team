import { motion } from 'framer-motion'
import { ArrowRight, BarChart3, Check, CloudUpload, Wand2, Copy, ExternalLink, Gavel, Globe, HardHat, Loader2, Lock, Send, Store, Trophy, User, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { reconnectBuild, useBuild } from '../buildStore'
import { api, type LevelsInfo, type LevelsPayload, type MarketListing } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { toast } from './Toast'
import { useArena } from '../store'
import { PanelLoader } from './HomeLoader'

const CARD = 'rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'
const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'

export const LEVEL_COLORS = ['#9aa39e', '#0082FB', '#7c3aed', '#d97706', '#059669']

/** «Nivel 2 · 60 % → 3» — the badge the header and the home cards show. */
export function LevelBadge({ level, pct, next, compact = false }: { level: number; pct: number; next: number | null; compact?: boolean }) {
  const T = useT()
  const color = LEVEL_COLORS[Math.min(level, LEVEL_COLORS.length - 1)]
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold" style={{ borderColor: `${color}55`, background: `${color}14`, color }} title={next ? T(`${pct}% para llegar al nivel ${next}`, `${pct}% towards level ${next}`) : T('Nivel máximo', 'Top level')}>
      <Trophy size={11} /> {compact ? `N${level}` : `${T('Nivel', 'Level')} ${level}`}
      {next && (
        <span className="flex items-center gap-1 font-mono font-semibold opacity-90">
          <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-black/10"><span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} /></span>
          {pct}% <ArrowRight size={9} /> {next}
        </span>
      )}
    </span>
  )
}

function Who({ who }: { who: 'team' | 'user' | 'world' }) {
  const T = useT()
  const map = { team: [HardHat, T('equipo', 'team')], user: [User, T('vos', 'you')], world: [Globe, T('uso real', 'real use')] } as const
  const [Icon, label] = map[who]
  return <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3"><Icon size={9} /> {label}</span>
}

/** The project's growth ladder: where it is, what the next level needs (with evidence), analytics and the marketplace listing. */
export default function LevelsPanel() {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const b = useBuild()
  const [data, setData] = useState<LevelsPayload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pitch, setPitch] = useState('')
  const [price, setPrice] = useState('')
  const [email, setEmail] = useState('')
  const [copied, setCopied] = useState(false)

  const load = async () => {
    if (!b.sessionId || !b.id) return
    try {
      const d = await api.levels(b.sessionId, b.id)
      setData(d)
      useBuild.getState().set({ levels: d.levels })
      if (d.listing && !pitch) { setPitch(d.listing.pitch ?? ''); setPrice(d.listing.price_usd != null ? String(d.listing.price_usd) : '') }
    } catch (e) {
      toast.error(tr('No pude leer los niveles', 'Could not read the levels'), (e as Error).message)
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [b.sessionId, b.id, b.status, b.cloudApp?.status, b.cloudApp?.version, b.versions.length])
  // live visitors: refresh every 30 s while the panel is open (the snippet pings every 30 s from each open tab)
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load() }, 30000)
    return () => window.clearInterval(t)
  }, [b.sessionId, b.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const lv: LevelsInfo | null = data?.levels ?? b.levels
  if (!lv) return <PanelLoader caption={T('Midiendo el nivel del proyecto…', 'Measuring the project level…')} />
  const next = lv.levels.find((l) => l.n === lv.next) ?? null
  const teamPending = (lv.pending ?? []).filter((c) => c.who === 'team' && c.id !== 'approved')  // approval is the council's verdict, not something to build
  const userPending = (lv.pending ?? []).filter((c) => c.who === 'user')
  const running = b.status === 'running' || b.status === 'reviewing' || b.status === 'design_review'

  // one item at a time: the builder resolves just this check (works for any team item, not only the whole level)
  const resolveOne = async (id: string, label: string) => {
    if (!b.id || !b.sessionId) return
    setBusy(`one:${id}`)
    try {
      await api.buildLevelPending(b.sessionId, b.id, { ids: [id] })
      reconnectBuild(b.id)
      toast.ok(T('El constructor lo está resolviendo', 'The builder is on it'), label)
    } catch (e) {
      toast.error(T('No se pudo arrancar', 'Could not start'), (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const buildPending = async () => {
    if (!b.id || !next || teamPending.length === 0) return
    setBusy('build')
    try {
      await api.councilApply(b.id, b.sessionId, teamPending.map((c) => ({ severity: 'bloqueante', role: `${T('Nivel', 'Level')} ${next.n}`, text: `(${T('nivel', 'level')} ${next.n}) ${en ? c.label_en : c.label}` })), 0, '')
      reconnectBuild(b.id)
      toast.ok(T(`El constructor está subiendo el proyecto al nivel ${next.n}`, `The builder is taking the project to level ${next.n}`), T('Cuando termine, el consejo lo revisa y vos lo publicás.', 'When it is done, the council reviews it and you publish it.'))
    } catch (e) {
      toast.error(T('No se pudo arrancar', 'Could not start'), (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const council = async () => {
    if (!b.id) return
    setBusy('council')
    try {
      const r = await api.buildCouncil(b.id, b.sessionId, 1, '', [], false, 'production')
      if (r.session_id) useBuild.getState().set({ councilSession: r.session_id })
    } catch (e) {
      toast.error(T('El consejo no pudo abrir', 'The council could not open'), (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const list = async () => {
    if (!b.sessionId || !b.id) return
    setBusy('list')
    try {
      await api.marketList(b.sessionId, b.id, { pitch, price_usd: price.trim() ? Number(price) : null })
      toast.ok(T('Publicado en el marketplace', 'Listed on the marketplace'), T('Cualquier usuario de Muse Team puede verlo y hacerte una oferta.', 'Any Muse Team user can see it and make you an offer.'))
      await load()
    } catch (e) {
      toast.error(T('No se pudo publicar', 'Could not list'), (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const withdraw = async () => {
    if (!b.sessionId || !b.id) return
    setBusy('withdraw')
    try { await api.marketWithdraw(b.sessionId, b.id); await load() } catch (e) { toast.error(T('No se pudo retirar', 'Could not withdraw'), (e as Error).message) } finally { setBusy(null) }
  }
  const transfer = async () => {
    if (!data?.listing || !email.trim()) return
    if (!window.confirm(T(`¿Transferir «${b.title}» a ${email.trim()}? El proyecto, sus versiones y su app publicada pasan a esa cuenta y dejan de ser tuyos.`, `Transfer "${b.title}" to ${email.trim()}? The project, its versions and its published app move to that account and stop being yours.`))) return
    setBusy('transfer')
    try {
      const r = await api.marketTransfer(data.listing.id, email.trim())
      toast.ok(T('Transferido', 'Transferred'), T(`Ahora es de ${r.to.name} (${r.to.email}).`, `It now belongs to ${r.to.name} (${r.to.email}).`))
      useArena.getState().set({ view: 'setup' })
    } catch (e) {
      toast.error(T('No se pudo transferir', 'Could not transfer'), (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const an = data?.analytics
  const maxDay = Math.max(1, ...(an?.days ?? []).map((d) => d.n))

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-paper px-3 py-4 sm:px-6 sm:py-5">
      <div className="mx-auto flex max-w-[980px] flex-col gap-4">
        {/* the ladder */}
        <div className={CARD}>
          <div className="flex flex-wrap items-center gap-3">
            <LevelBadge level={lv.level} pct={lv.pct} next={lv.next} />
            <div className="min-w-[220px] flex-1 text-sm text-ink-2">
              {next ? (
                <>{T('Para subir al nivel', 'To reach level')} <b className="text-ink">{next.n} · {en ? next.label_en : next.label}</b>: {en ? next.goal_en : next.goal}</>
              ) : (
                <>{T('Nivel máximo: el proyecto es un negocio completo.', 'Top level: the project is a full business.')}</>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {lv.levels.map((l) => {
              const reached = lv.level >= l.n
              const climbing = lv.next === l.n
              const color = LEVEL_COLORS[l.n]
              return (
                <div key={l.n} className="relative overflow-hidden rounded-xl border px-3 py-2.5" style={{ borderColor: reached || climbing ? `${color}66` : 'var(--color-line)', background: reached ? `${color}12` : 'var(--color-surface)' }}>
                  <div className="flex items-center justify-between text-[11px] font-bold" style={{ color: reached || climbing ? color : 'var(--color-ink-3)' }}>
                    <span className="flex items-center gap-1">{reached ? <Check size={11} /> : climbing ? <Trophy size={11} /> : <Lock size={10} />} {T('Nivel', 'Level')} {l.n}</span>
                    <span className="font-mono">{l.done}/{l.total}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold text-ink">{en ? l.label_en : l.label}</div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10"><motion.div initial={false} animate={{ width: `${l.pct}%` }} className="h-full rounded-full" style={{ background: color }} /></div>
                  <div className="mt-1.5 text-[11px] text-ink-3">{en ? l.unlocks_en : l.unlocks}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* the next level's checks, with who does each one and the evidence found */}
        {next && (
          <div className={CARD}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Trophy size={15} style={{ color: LEVEL_COLORS[next.n] }} /> {T('Qué falta para el nivel', 'What level')} {next.n} {T('', 'needs')} · {next.pct}%</h3>
              <div className="flex flex-wrap items-center gap-2">
                {teamPending.length > 0 && (
                  <button onClick={buildPending} disabled={running || !!busy} className={PRIMARY} title={T('El constructor aplica los pendientes del equipo, en orden, y después el consejo verifica', 'The builder applies the team items, in order, and then the council verifies')}>
                    {busy === 'build' ? <Loader2 size={14} className="animate-spin" /> : <HardHat size={14} />} {T('Construir lo pendiente', 'Build what is pending')}
                  </button>
                )}
                <button onClick={council} disabled={running || !!busy || Object.keys(b.files).length === 0} className={teamPending.length ? PILL : PRIMARY} title={T('El consejo revisa el proyecto contra los requisitos del nivel', 'The council reviews the project against the level requirements')}>
                  {busy === 'council' ? <Loader2 size={14} className="animate-spin" /> : <Gavel size={14} />} {T('Que el consejo verifique', 'Have the council verify')}
                </button>
              </div>
            </div>
            <ol className="mt-3 flex list-none flex-col divide-y divide-line">
              {next.checks.map((c, i) => (
                <li key={c.id} className="flex items-start gap-3 py-2.5">
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${c.ok ? 'bg-ok text-white' : 'border border-line bg-surface-2 text-ink-3'}`}>{c.ok ? <Check size={11} /> : i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] ${c.ok ? 'text-ink-3 line-through decoration-ink-3/40' : 'text-ink'}`}>{en ? c.label_en : c.label}</div>
                    {c.evidence && <div className={`mt-0.5 font-mono text-[11px] ${c.ok ? 'text-ok' : 'text-ink-3'}`}>{c.ok ? '✓ ' : ''}{c.evidence}</div>}
                    {!c.ok && c.who === 'team' && c.id !== 'approved' && (
                      <button onClick={() => resolveOne(c.id, en ? c.label_en : c.label)} disabled={running || !!busy} className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40" title={T('El constructor resuelve este punto ahora', 'The builder resolves this item now')}>
                        {busy === `one:${c.id}` ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} {T('Resolver', 'Resolve')}
                      </button>
                    )}
                    {!c.ok && c.id === 'approved' && (
                      <button onClick={council} disabled={running || !!busy || Object.keys(b.files).length === 0} className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">
                        {busy === 'council' ? <Loader2 size={13} className="animate-spin" /> : <Gavel size={13} />} {T('Enviar a revisión', 'Send for review')}
                      </button>
                    )}
                    {!c.ok && (c.id === 'published' || c.id === 'republished') && (
                      <>
                        <div className="mt-0.5 text-[11px] text-ink-3">{c.id === 'published' ? T('Un clic y queda en una URL pública de Muse Cloud.', 'One click and it is on a public Muse Cloud URL.') : T('Publicá la última versión para que la URL muestre lo nuevo.', 'Publish the latest version so the URL shows what is new.')}</div>
                        <button onClick={() => useBuild.getState().set({ pane: 'cloud', paneOpen: true })} disabled={running || Object.keys(b.files).length === 0} className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">
                          <CloudUpload size={13} /> {c.id === 'published' ? T('Publicar', 'Publish') : T('Volver a publicar', 'Publish again')}
                        </button>
                      </>
                    )}
                    {!c.ok && c.id === 'visits' && data?.app?.url && (
                      <>
                        <div className="mt-0.5 text-[11px] text-ink-3">{T('Compartí la URL: cada visita cuenta.', 'Share the URL: every visit counts.')} <a href={data.app.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{data.app.url}</a></div>
                        <button onClick={async () => { try { await navigator.clipboard.writeText(data.app!.url!); toast.ok(T('Link copiado', 'Link copied'), T('Pegalo donde quieras compartirlo.', 'Paste it wherever you want to share it.')) } catch { /* ignore */ } }} className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110">
                          <Copy size={13} /> {T('Copiar el link', 'Copy the link')}
                        </button>
                      </>
                    )}
                  </div>
                  <Who who={c.who} />
                </li>
              ))}
            </ol>
            {userPending.length > 0 && teamPending.length === 0 && <div className="mt-2 text-[12px] text-ink-2">{T('Lo que queda es tuyo: un clic en «Publicar».', 'What is left is yours: one click on "Publish".')}</div>}
          </div>
        )}

        {/* analytics (level 2) */}
        <div className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><BarChart3 size={15} className="text-accent" /> Muse Team Analytics</h3>
            {an?.site && <span className="font-mono text-[11px] text-ink-3">site: {an.site}</span>}
          </div>
          {an?.site ? (
            <>
              <LiveNow n={an.live} pages={an.live_pages} last30={an.last_30m} />
              <div className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-3">
                {[[T('Páginas vistas', 'Page views'), an.pageviews], [T('Eventos', 'Events'), an.events], [T('Errores', 'Errors'), an.errors]].map(([l, v]) => (
                  <div key={String(l)} className="rounded-xl border border-line bg-surface-2 px-3 py-2"><div className="text-[11px] text-ink-3">{l}</div><div className="font-mono text-xl font-semibold text-ink">{v}</div></div>
                ))}
              </div>
              <div className="mt-3 flex h-16 items-end gap-1" title={T('Últimos 14 días', 'Last 14 days')}>
                {(an.days.length ? an.days : [{ day: '', n: 0 }]).map((d) => (
                  <div key={d.day} className="flex-1 rounded-t bg-accent/70" style={{ height: `${Math.max(4, (100 * d.n) / maxDay)}%` }} title={`${d.day}: ${d.n}`} />
                ))}
              </div>
              {(an.pages.length > 0 || an.top_events.length > 0) && (
                <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
                  <div>{an.pages.map((p) => <div key={p.path} className="flex justify-between gap-2 py-0.5"><span className="truncate font-mono text-ink-2">{p.path}</span><span className="font-mono text-ink-3">{p.n}</span></div>)}</div>
                  <div>{an.top_events.map((p) => <div key={p.name} className="flex justify-between gap-2 py-0.5"><span className="truncate font-mono text-ink-2">{p.name}</span><span className="font-mono text-ink-3">{p.n}</span></div>)}</div>
                </div>
              )}
            </>
          ) : (
            <div className="mt-2 text-[12.5px] text-ink-2">{T('Las métricas aparecen cuando la app está publicada con el snippet de analytics (nivel 2).', 'Metrics show up once the app is published with the analytics snippet (level 2).')}</div>
          )}
          {data?.snippet && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{data.snippet}</code>
              <button onClick={async () => { try { await navigator.clipboard.writeText(data.snippet); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { /* ignore */ } }} className={PILL + ' h-7 px-2.5 text-[11px]'}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? T('Copiado', 'Copied') : T('Copiar', 'Copy')}</button>
            </div>
          )}
        </div>

        {/* marketplace (from level 1) */}
        <div className={CARD}>
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Store size={15} className="text-accent" /> Marketplace</h3>
          {!lv.market_ready ? (
            <div className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-2"><Lock size={13} className="text-ink-3" /> {T('Se desbloquea en el nivel 1: construida, aprobada por el consejo y en línea.', 'Unlocks at level 1: built, approved by the council and live.')}</div>
          ) : (
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{T('Pitch para compradores', 'Pitch for buyers')}</label>
                <textarea value={pitch} onChange={(e) => setPitch(e.target.value)} rows={4} placeholder={T('Qué hace, para quién, qué tracción tiene y qué incluye la venta.', 'What it does, for whom, its traction and what the sale includes.')} className="rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent" />
                <div className="flex items-center gap-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{T('Precio USD', 'Price USD')}</label>
                  <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder={T('a convenir', 'negotiable')} className="w-28 rounded-xl border border-line bg-surface px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent" />
                  <button onClick={list} disabled={!!busy} className={PRIMARY + ' ml-auto whitespace-nowrap'}>{busy === 'list' ? <Loader2 size={14} className="animate-spin" /> : <Store size={14} />} {data?.listing ? T('Actualizar', 'Update') : T('Publicar en venta', 'List for sale')}</button>
                </div>
              </div>
              <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3">
                {data?.listing ? (
                  <>
                    <div className="flex items-center justify-between text-[12px]"><span className="flex items-center gap-1.5 font-semibold text-ok"><Check size={13} /> {T('En venta', 'For sale')}</span><button onClick={withdraw} disabled={!!busy} className="flex items-center gap-1 text-ink-3 hover:text-danger"><X size={12} /> {T('Retirar', 'Withdraw')}</button></div>
                    <div className="text-[12px] text-ink-2">{T('Nivel', 'Level')} {data.listing.level} · {lv.visits} {T('visitas', 'visits')} · {data.listing.price_usd != null ? `USD ${data.listing.price_usd}` : T('precio a convenir', 'negotiable')}</div>
                    {data.app?.url && <a href={data.app.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-[12px] text-accent hover:underline"><ExternalLink size={12} /> {data.app.url}</a>}
                    <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{T('Transferir la propiedad', 'Transfer ownership')}</div>
                    <div className="flex items-center gap-2">
                      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={T('email del comprador (cuenta de Muse Team)', "buyer's email (Muse Team account)")} className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent" />
                      <button onClick={transfer} disabled={!!busy || !email.trim()} className={PILL + ' h-8'}>{busy === 'transfer' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} {T('Transferir', 'Transfer')}</button>
                    </div>
                    <div className="text-[11px] text-ink-3">{T('El proyecto, sus versiones, el repo y la app publicada pasan a esa cuenta. La URL no cambia.', 'The project, its versions, the repo and the published app move to that account. The URL does not change.')}</div>
                  </>
                ) : (
                  <div className="text-[12.5px] text-ink-2">{T('Tu app aparece en el marketplace con su nivel, su URL y sus visitas reales. Los compradores te escriben; cuando cerrás, transferís la propiedad desde acá.', 'Your app shows on the marketplace with its level, URL and real visits. Buyers write to you; when you close, you transfer ownership from here.')}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export type { MarketListing }

/** Amplitude-style «live now»: tabs that signalled in the last 2 minutes, the page each is on, and visits in the last 30 min. */
export function LiveNow({ n, pages, last30 }: { n: number; pages: { path: string; n: number }[]; last30: number }) {
  const T = useT()
  return (
    <div className={`mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border px-3 py-2.5 ${n ? 'border-ok/30 bg-ok/5' : 'border-line bg-surface-2'}`}>
      <span className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          {n > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${n ? 'bg-ok' : 'bg-ink-4'}`} />
        </span>
        <span className="font-mono text-[20px] font-semibold leading-none text-ink tabular-nums">{n}</span>
        <span className="text-[12.5px] text-ink-2">{n === 1 ? T('persona en vivo ahora', 'person live now') : T('personas en vivo ahora', 'people live now')}</span>
      </span>
      {pages.length > 0 && <span className="flex min-w-0 flex-wrap gap-1.5">{pages.map((p) => <span key={p.path} className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-2">{p.path} · {p.n}</span>)}</span>}
      <span className="ml-auto text-[11.5px] text-ink-3">{last30} {T('visitas en los últimos 30 min · se actualiza cada 30 s', 'visits in the last 30 min · refreshes every 30 s')}</span>
    </div>
  )
}

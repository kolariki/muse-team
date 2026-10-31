import { motion } from 'framer-motion'
import { ChevronDown, Download, Gavel, HardHat, Loader2, MonitorPlay, Pencil, Plus, Search, Trash2, Users, Video } from 'lucide-react'
import { LevelBadge } from './LevelsPanel'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken, type DashboardData } from '../lib/api'
import { fmtDur } from '../lib/duration'
import { downloadBlob, slug } from '../lib/recorder'
import { readCache, writeCache } from '../lib/cache'
import { fmtUsd } from '../lib/parse'
import { BrandLogoRow, BrandStripes } from './ProviderLogo'
import TeamEditor from './TeamEditor'
import { toast, useConfirm } from './Toast'
import { tr, useT } from '../lib/i18n'

interface Props {
  onOpen: (id: string, mode?: 'arena' | 'builder' | 'run') => void | Promise<unknown>
  onCouncil: (id: string) => void
  onReplay: (id: string) => void
  onSettings: () => void
  onAudit: () => void
  refreshKey?: number
  onLoaded?: () => void  // first data in: the home can drop its loader
  onCreate?: () => void  // empty state: «crear el primer proyecto» (the home asks direct or team)
}

const STATUS: Record<string, { es: string; en: string; cls: string }> = {
  running: { es: 'en curso', en: 'running', cls: 'bg-accent-soft text-accent' },
  paused: { es: 'en pausa · modelo caído', en: 'paused · model down', cls: 'bg-gold/15 text-gold' },
  completed: { es: 'terminada', en: 'completed', cls: 'bg-ok/10 text-ok' },
  stopped: { es: 'detenida', en: 'stopped', cls: 'bg-surface-2 text-ink-3' },
  error: { es: 'error', en: 'error', cls: 'bg-danger/10 text-danger' },
  audit: { es: 'auditoría', en: 'audit', cls: 'bg-gold/15 text-gold' },
  approved: { es: 'aprobada', en: 'approved', cls: 'bg-ok/15 text-ok' },
  audited: { es: 'auditada', en: 'audited', cls: 'bg-gold/15 text-gold' },
  reviewing: { es: 'en revisión', en: 'under review', cls: 'bg-gold/15 text-gold' },
}

const ACT = 'flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] font-medium text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-2'
const ACT_PRIMARY = 'flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'

/** Home: everything the user owns (sessions, audits, builds), spend, and a setup checklist. */
/** The project's own animated scene: a model draws it from the brief the first time the row is shown (a few seconds,
 * in the background); meanwhile the procedural keyword scene stands in. */
function SceneThumb({ sessionId }: { sessionId: string }) {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    let tries = 0
    const check = () => {
      api.sceneStatus(sessionId).then((st) => {
        if (!alive) return
        if (st.ready) setReady(true)
        else if (st.pending && tries++ < 10) setTimeout(check, 8000)
        else setReady(false)
      }).catch(() => alive && setReady(false))
    }
    check()
    return () => { alive = false }
  }, [sessionId])
  // one URL: the server answers the procedural scene until the model-drawn one exists; `v` forces a refetch when it is ready
  const src = `/api/sessions/${sessionId}/scene.svg?token=${encodeURIComponent(getToken() ?? '')}&v=${ready ? 'own' : 'tmp'}`
  return (
    <span className="relative w-12 h-12 overflow-hidden rounded-xl ring-1 ring-black/10 shadow-sm shrink-0" title={ready ? tr('Escena dibujada para este proyecto', 'Scene drawn for this project') : undefined}>
      <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" onError={(e) => { const el = e.currentTarget; if (!el.dataset.retried) { el.dataset.retried = '1'; el.src = `${el.src.split('&r=')[0]}&r=${Date.now()}` } }} />
    </span>
  )
}

export default function Dashboard({ onOpen, onCouncil, onReplay, onAudit, refreshKey, onLoaded, onCreate }: Props) {
  const T = useT()
  const statusLabel = (code: string) => (STATUS[code] ? T(STATUS[code].es, STATUS[code].en) : code)
  const [data, setData] = useState<DashboardData | null>(() => readCache<DashboardData>('dashboard'))
  // which card action is loading (the build is several MB: the button says so until the screen opens)
  const [busyAct, setBusyAct] = useState<string | null>(null)
  const go = async (id: string, mode: 'arena' | 'builder' | 'run') => {
    setBusyAct(`${id}:${mode}`)
    try {
      await onOpen(id, mode)
    } finally {
      setBusyAct(null)
    }
  }
  const actLabel = (id: string, mode: 'arena' | 'builder' | 'run', icon: ReactNode, label: string) => (busyAct === `${id}:${mode}` ? <><Loader2 size={13} className="animate-spin" /> {T('Abriendo…', 'Opening…')}</> : <>{icon} {label}</>)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({}) // rows with "Ver más info" expanded
  const { confirm, dialog } = useConfirm()

  const load = () => {
    api.dashboard().then((d) => { if (writeCache('dashboard', d)) setData(d); onLoaded?.() }).catch(() => onLoaded?.())
  }
  useEffect(load, [refreshKey])
  useEffect(() => {
    const id = setInterval(() => data?.active_jobs && load(), 8000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.active_jobs])

  type Row = DashboardData['sessions'][number] & { runs: DashboardData['sessions'] }
  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    const hit = (s: DashboardData['sessions'][number]) => !needle || `${s.title ?? ''} ${s.topic} ${s.agents.map((a) => a.name).join(' ')}`.toLowerCase().includes(needle)
    // the same experiment run several times is ONE project: the newest run leads the row, the older runs sit inside it
    const key = (s: DashboardData['sessions'][number]) => (s.mode === 'audit' ? `audit:${s.id}` : (s.title || s.topic).toLowerCase().replace(/\s+/g, ' ').trim())
    const groups = new Map<string, DashboardData['sessions']>()
    for (const s of [...data.sessions].sort((a, b) => b.created - a.created)) groups.set(key(s), [...(groups.get(key(s)) ?? []), s])
    return [...groups.values()].map(([lead, ...older]) => ({ ...lead, runs: older })).filter((r) => hit(r) || r.runs.some(hit))
  }, [data, q])
  const isEngine = (p?: string) => p === 'claude-code' || p === 'codex' || p === 'muse-code'
  const apiCost = (s: DashboardData['sessions'][number]) => (s.cost_usd ?? 0) + (s.council_cost_usd ?? 0) + (s.builds ?? []).reduce((a, b) => a + (isEngine(b.provider) ? 0 : b.cost_usd ?? 0) + (b.fees_usd ?? 0), 0)

  if (!data) return null

  return (
    <section className="mt-10">
      {dialog}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="panel rounded-2xl p-4">
          <div className="text-[11px] uppercase tracking-widest text-ink-3">{T('Gasto en API', 'API spend')}</div>
          <div className="mt-1 font-mono text-3xl">{fmtUsd(data.spend.month_usd)}</div>
          <div className="text-[12px] text-ink-3">{T('este mes', 'this month')} · total {fmtUsd(data.spend.total_usd)}</div>
          <div className="mt-2 text-[11px] text-ink-4">{T('Estimado con precios de lista; las construcciones con Claude Code por suscripción no suman.', 'Estimated at list prices; builds with Claude Code by subscription do not count.')}</div>
        </div>
        <div className="panel rounded-2xl p-4">
          <div className="text-[11px] uppercase tracking-widest text-ink-3">{T('Trabajos en curso', 'Jobs running')}</div>
          <div className="mt-1 font-mono text-3xl">{data.active_jobs}<span className="text-base text-ink-3"> / {data.max_jobs}</span></div>
          <div className="text-[12px] text-ink-3">{T('debates, construcciones y revisiones corriendo ahora', 'debates, builds and reviews running now')}</div>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <h2 className="font-sans text-xs uppercase tracking-widest text-ink-3">{T('Mis proyectos', 'My projects')} ({rows.length})</h2>
        <div className="ml-auto flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
          <Search size={14} className="text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={T('buscar…', 'search…')} className="bg-transparent text-sm outline-none w-28 sm:w-44" />
        </div>
        <button onClick={onAudit} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm hover:bg-surface-2"><Gavel size={14} />{T(' Auditar proyecto', ' Audit project')}</button>
      </div>
      {rows.length === 0 && (
        <div className="mt-3 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line p-10 text-center">
          <div className="text-[15px] text-ink-2">{q ? tr('Nada coincide con la búsqueda.', 'Nothing matches the search.') : tr('Todavía no hay proyectos.', 'No projects yet.')}</div>
          {!q && onCreate && (
            <button type="button" onClick={onCreate} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-sm transition hover:brightness-110"><Plus size={15} /> {tr('Crear el primer proyecto', 'Create your first project')}</button>
          )}
        </div>
      )}
      <div className="mt-3 grid gap-2">
        {rows.map((s, i) => {
          const st = { label: statusLabel(s.status), cls: STATUS[s.status]?.cls ?? 'bg-surface-2 text-ink-3' }
          const isAudit = s.mode === 'audit'
          const builds = s.builds ?? []
          const latest = builds[0]
          const cost = apiCost(s) + s.runs.reduce((a, r) => a + apiCost(r), 0)
          const engineCost = builds.reduce((a, b) => a + (isEngine(b.provider) ? b.cost_usd ?? 0 : 0), 0)
          const buildTime = builds.reduce((a, b) => a + (b.build_seconds ?? 0), 0)
          const providers = s.agents.map((a) => a.provider)
          const expanded = !!open[s.id]
          const councils = s.councils ?? []
          const readinessColor = (r: number) => (r >= 80 ? 'var(--color-ok)' : r >= 50 ? 'var(--color-gold)' : 'var(--color-danger)')
          const info: { label: string; value: ReactNode }[] = [
            { label: tr('Creado', 'Created'), value: new Date(s.created * 1000).toLocaleString() },
            { label: tr('Estado', 'Status'), value: st.label },
            ...(!isAudit && s.turns ? [{ label: tr('Turnos del debate', 'Debate turns'), value: `${s.turns}` }] : []),
            { label: 'Brief', value: s.has_brief ? tr('generado', 'generated') : tr('todavía no', 'not yet') },
            ...(builds.length ? [{ label: tr('Construcciones', 'Builds'), value: `${builds.length} · ${T('última', 'latest')} ${statusLabel(latest.status)}${latest.files ? ` · ${latest.files} ${T('archivos', 'files')}` : ''}` }] : []),
            ...(buildTime > 0 ? [{ label: tr('Tiempo de construcción', 'Build time'), value: `${fmtDur(buildTime)}${builds.length > 1 ? ` · ${T('última', 'latest')} ${fmtDur(latest.build_seconds ?? 0)}` : ''}` }] : []),
            ...(latest?.version ? [{ label: tr('Versión', 'Version'), value: <span>v{latest.version}{latest.readiness != null ? <span style={{ color: readinessColor(latest.readiness) }}> · {latest.readiness}% {T('listo para producción', 'production-ready')}</span> : <span className="text-ink-3">{T(' · sin revisar', ' · not reviewed')}</span>}</span> }] : []),
            ...(councils.length ? [{ label: tr('Rondas de consejo', 'Council rounds'), value: (
              <span className="inline-flex flex-wrap items-center gap-1">
                {councils.length}
                {councils.map((c) => (
                  <button key={c.id} onClick={() => onCouncil(c.id)} className={`rounded px-1.5 font-sans ${c.live ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-2 hover:text-ink'}`} title={`${T('Ronda', 'Round')} ${c.round} · v${c.version ?? ''} · ${c.live ? T('en vivo', 'live') : c.status}`}>r{c.round}</button>
                ))}
              </span>
            ) }] : []),
            ...(cost > 0 ? [{ label: tr('Costo en API', 'API cost'), value: fmtUsd(cost) }] : []),
            ...(engineCost > 0 ? [{ label: tr('Construcción por suscripción', 'Build by subscription'), value: <span>{fmtUsd(engineCost)} <span className="text-ink-3">{T('equivalente a precio de lista; no se cobra', 'list-price equivalent; not billed')}</span></span> }] : []),
            ...(s.runs.length ? [{ label: tr('Corridas anteriores', 'Earlier runs'), value: (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {s.runs.map((r, ri) => (
                  <span key={r.id} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-[12px]">
                    <span className="text-ink-3">#{s.runs.length - ri} · {new Date(r.created * 1000).toLocaleDateString()}</span>
                    <button onClick={() => onOpen(r.id)} className="text-accent hover:underline">{T('abrir', 'open')}</button>
                    <button onClick={() => onCouncil(r.id)} className="text-accent hover:underline">{T('consejo', 'council')}</button>
                  </span>
                ))}
              </span>
            ) }] : []),
            { label: tr('Equipo', 'Team'), value: s.agents.map((a) => `${a.name} · ${a.provider}${a.model ? ` (${a.model})` : ''}`).join(' · ') },
          ]
          return (
            <motion.div key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }} className="panel relative overflow-hidden rounded-2xl">
              {/* the companies that worked on this project, as soft bands with their logos behind the row */}
              <BrandStripes providers={providers} opacity={0.9} logos={false} />
              <div className="absolute inset-0 bg-surface/55" aria-hidden />
              {/* the row follows the card's own width (a tablet-width window squeezed the title to nothing) */}
              <div className="@container relative px-4 py-3">
                <div className="flex flex-wrap items-center gap-3 @3xl:flex-nowrap @3xl:gap-4">
                  {/* mini animated scene of what the project is about (same generator as the experiment cards) */}
                  <SceneThumb sessionId={s.id} />
                  <div className="min-w-0 flex-1">
                    {editing === s.id ? (
                      <input
                        autoFocus
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter') {
                            await api.renameSession(s.id, title).catch((er) => toast.error(tr('No se pudo renombrar', 'Could not rename'), (er as Error).message))
                            setEditing(null)
                            load()
                          }
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="w-full rounded-lg border border-accent bg-surface px-2 py-1 text-sm"
                      />
                    ) : (
                      <div className="font-medium truncate">{s.title || s.topic}</div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
                      <span className={`rounded-full px-2 py-0.5 font-sans font-semibold ${st.cls}`}>{st.label}</span>
                      {latest?.version ? <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-sans font-semibold text-ink">v{latest.version}</span> : null}
                      {latest?.level != null && <LevelBadge level={latest.level} pct={latest.level_pct ?? 0} next={latest.level_next ?? null} />}
                      {s.runs.length > 0 && <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-sans text-ink-2" title={T('Este experimento se corrió varias veces; las corridas anteriores están en «Ver más info»', 'This experiment ran several times; the earlier runs are under "More info"')}>{s.runs.length + 1} {T('corridas', 'runs')}</span>}
                      <button onClick={() => setOpen({ ...open, [s.id]: !expanded })} className="flex items-center gap-1 text-ink-3 hover:text-ink" aria-expanded={expanded}>
                        {expanded ? tr('Menos info', 'Less info') : tr('Ver más info', 'More info')} <ChevronDown size={12} className={`transition ${expanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {/* the team's logos and shares live in their own column, between the title and the buttons, so nothing covers them */}
                  <div className="hidden @4xl:block w-[34%] max-w-[420px] shrink-0 self-stretch min-h-[44px]">
                    <BrandLogoRow providers={providers} compact />
                  </div>
                  <div className="flex w-full flex-wrap items-center justify-start gap-1.5 @3xl:w-auto @3xl:shrink-0 @3xl:justify-end">
                    {isAudit ? (
                      <button onClick={() => go(s.id, 'builder')} disabled={!!busyAct} className={ACT_PRIMARY} title={T('Abrir el informe de auditoría', 'Open the audit report')}>{actLabel(s.id, 'builder', <HardHat size={13} />, T('Abrir', 'Open'))}</button>
                    ) : (
                      <>
                        <button onClick={() => go(s.id, 'arena')} disabled={!!busyAct} className={builds.length ? ACT : ACT_PRIMARY} title={T('El debate del equipo en la arena', 'The team debate in the arena')}>{actLabel(s.id, 'arena', <Users size={13} />, T('Equipo', 'Team'))}</button>
                        <button onClick={() => go(s.id, 'builder')} disabled={!builds.length || !!busyAct} className={ACT} title={builds.length ? T('Código, diseño, versiones y publicación', 'Code, design, versions and publishing') : T('Todavía no hay construcción', 'No build yet')}>{actLabel(s.id, 'builder', <HardHat size={13} />, T('Constructor', 'Builder'))}</button>
                        <button onClick={() => go(s.id, 'run')} disabled={!latest?.files || !!busyAct} className={builds.length ? ACT_PRIMARY : ACT} title={latest?.files ? T('Levanta la app en esta máquina y la muestra', 'Starts the app on this machine and shows it') : T('Todavía no hay archivos para correr', 'No files to run yet')}>{actLabel(s.id, 'run', <MonitorPlay size={13} />, T('Correr app', 'Run app'))}</button>
                      </>
                    )}
                    {latest?.files ? (
                      <button
                        disabled={busyAct === `${s.id}:zip`}
                        onClick={async () => {
                          setBusyAct(`${s.id}:zip`)
                          try {
                            downloadBlob(await api.buildZip(s.id, latest.id), `${slug(s.title || s.topic) || 'proyecto'}.zip`)
                          } finally {
                            setBusyAct(null)
                          }
                        }}
                        className="rounded-lg border border-line bg-surface/70 px-2 py-1.5 text-ink-3 hover:text-ink disabled:opacity-50"
                        title={T('Descargar el proyecto (.zip con el código, el BRIEF y el README)', 'Download the project (.zip with the code, the BRIEF and the README)')}
                      >
                        {busyAct === `${s.id}:zip` ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                      </button>
                    ) : null}
                    {!isAudit && <button onClick={() => onReplay(s.id)} className="rounded-lg border border-line bg-surface/70 px-2 py-1.5 text-ink-3 hover:text-ink" title={T('Reproducir como video', 'Play as video')}><Video size={13} /></button>}
                    <button onClick={() => { setEditing(s.id); setTitle(s.title || s.topic) }} className="rounded-lg border border-line bg-surface/70 px-2 py-1.5 text-ink-3 hover:text-ink" title={T('Renombrar', 'Rename')}><Pencil size={13} /></button>
                    <button
                      onClick={async () => {
                        if (!(await confirm(`${tr('¿Borrar «', 'Delete «')}${s.title || s.topic}${tr('» con sus construcciones, exportaciones y secretos? No se puede deshacer.', '» with its builds, exports and secrets? This cannot be undone.')}`))) return
                        await api.deleteSession(s.id).then(() => toast.ok(tr('Proyecto borrado', 'Project deleted'))).catch((er) => toast.error(tr('No se pudo borrar', 'Could not delete'), (er as Error).message))
                        load()
                      }}
                      className="rounded-lg border border-line bg-surface/70 px-2 py-1.5 text-ink-3 hover:text-danger"
                      title={T('Borrar', 'Delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {expanded && (
                  <motion.ol initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-3 grid gap-1 sm:ml-14 text-[12.5px] sm:grid-cols-2">
                    {info.map((it, k) => (
                      <li key={k} className="flex gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5">
                        <span className="font-mono text-ink-3 shrink-0">{k + 1}.</span>
                        <span className="text-ink-3 shrink-0">{it.label}:</span>
                        <span className="min-w-0 text-ink font-medium break-words">{it.value}</span>
                      </li>
                    ))}
                  </motion.ol>
                )}
                {expanded && !isAudit && (
                  <div className="mt-3 sm:ml-14"><TeamEditor sessionId={s.id} onSaved={load} /></div>
                )}
              </div>
            </motion.div>
          )
        })}
      </div>
    </section>
  )
}

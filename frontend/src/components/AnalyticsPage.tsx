import { AlertTriangle, BarChart3, CloudUpload, ExternalLink, Hammer, Loader2, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type AnalyticsApp } from '../lib/api'
import { reconnectBuild } from '../buildStore'
import { tr, useT } from '../lib/i18n'
import { toast } from './Toast'
import { useArena } from '../store'
import AnalyticsDetail from './AnalyticsDetail'
import { ConnectSite, ExternalSetup } from './ExternalSite'
import { LiveNow } from './LevelsPanel'
import PageHeader from './PageHeader'
import HomeLoader from './HomeLoader'
import { AnimatePresence } from 'framer-motion'

/** Muse Team Analytics for every published app: visits, events and errors, read from the `/a.js` snippet each app carries. */
export default function AnalyticsPage({ onBack }: { onBack: () => void }) {
  const T = useT()
  const [data, setData] = useState<{ apps: AnalyticsApp[]; collector: string; collector_public: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = () => api.analytics().then(setData).catch((e) => setError((e as Error).message))
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') reload() }
    load()
    const t = window.setInterval(load, 30000)
    return () => window.clearInterval(t)
  }, [])
  const [open, setOpen] = useState<string | null>(null)
  const openApp = data?.apps.find((a) => a.slug === open) ?? null
  const total = (data?.apps ?? []).reduce((n, a) => n + a.stats.pageviews, 0)
  const live = (data?.apps ?? []).reduce((n, a) => n + a.stats.live, 0)
  return (
    <div className="h-full overflow-y-auto scroll-thin arena-bg">
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader onBack={onBack} kicker="Muse Team Analytics" title={T('Analíticas', 'Analytics')}
          subtitle={T('Visitas, eventos y errores reales de cada app que publicaste con Muse Team o que conectaste desde tu hosting. Sin cookies ni datos personales: cada app carga el script /a.js y las visitas llegan acá.', 'Real visits, events and errors of every app you published with Muse Team or connected from your own host. No cookies or personal data: each app loads the /a.js script and the visits land here.')}
          right={data && <span className="flex h-9 items-center gap-3 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-2 shadow-sm"><span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${live ? 'bg-ok animate-pulse' : 'bg-ink-4'}`} /> {live} {T('en vivo', 'live')}</span><span className="h-4 w-px bg-line" /><span className="flex items-center gap-1.5"><BarChart3 size={15} /> {total} {T('visitas en total', 'visits in total')}</span></span>} />
        {data && !data.collector_public && (
          <div className="mt-6 flex items-start gap-3 rounded-2xl border border-gold/40 bg-gold/10 px-4 py-3 text-[13px] text-ink-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-gold" />
            <div>{T('Esta instalación recibe las visitas en', 'This installation receives visits at')} <code className="font-mono">{data.collector}</code>{T(', que no se alcanza desde internet: las visitas a tus apps publicadas no van a llegar acá. En la versión online funciona solo; corriendo local, configurá TABLY_CLOUD_URL con una URL pública del backend.', ', which cannot be reached from the internet: visits to your published apps will not land here. In the online version it just works; running locally, set TABLY_CLOUD_URL to a public URL of the backend.')}</div>
          </div>
        )}
        {error && <div className="mt-6 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[13px] text-danger">{error}</div>}
        <AnimatePresence>{!data && !error && <HomeLoader key="loader" caption={T('Midiendo tus apps…', 'Measuring your apps…')} />}</AnimatePresence>
        {data && !openApp && <div data-tour="analytics" className="mt-6 flex flex-wrap items-center gap-3"><ConnectSite onDone={() => reload()} /></div>}
        {data && !data.apps.length && <div className="mt-6 rounded-2xl border border-dashed border-line px-6 py-12 text-center text-[14px] text-ink-3">{T('Todavía no hay apps acá. Publicá una con Muse Cloud o conectá un sitio que ya tengas online (en tu GitHub y tu hosting).', 'No apps here yet. Publish one with Muse Cloud or connect a site you already have online (on your GitHub and host).')}</div>}
        {openApp ? <div className="mt-8"><AnalyticsDetail app={openApp} onBack={() => setOpen(null)} /></div>
          : <div data-tour="apps" className="mt-8 space-y-5">{data?.apps.map((a) => <AppCard key={a.slug} a={a} onDetail={() => setOpen(a.slug)} onChange={reload} />)}</div>}
      </div>
    </div>
  )
}

function last14(days: { day: string; n: number }[]) {
  const by = new Map(days.map((d) => [d.day, d.n]))
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10)
    return { day: d, n: by.get(d) ?? 0 }
  })
}

function AppCard({ a, onDetail, onChange }: { a: AnalyticsApp; onDetail: () => void; onChange: () => void }) {
  const T = useT()
  const days = last14(a.stats.days)
  const max = Math.max(1, ...days.map((d) => d.n))
  const open = () => a.session_id && useArena.getState().set({ pendingBuild: { buildId: a.build_id, sessionId: a.session_id } })
  const [installing, setInstalling] = useState(false)
  const [publishing, setPublishing] = useState(false)
  // the snippet is in the project but not online yet: publish the current version from here
  const publish = async () => {
    if (!a.session_id) return
    setPublishing(true)
    try {
      await api.cloudPublish(a.session_id, a.build_id)
      toast.ok(tr('Publicando la versión con analíticas', 'Publishing the version with analytics'), tr('En unos minutos está en línea y empiezan a llegar las visitas.', 'In a few minutes it is live and visits start coming in.'))
    } catch (e) {
      toast.error(tr('No se pudo publicar', 'Could not publish'), (e as Error).message)
    } finally {
      setPublishing(false)
    }
  }
  // one click: the builder installs the snippet (and the rest of level 2), and the user lands in the builder to watch it
  const install = async () => {
    if (!a.session_id) return
    setInstalling(true)
    try {
      await api.buildLevelPending(a.session_id, a.build_id, { focus: 'analytics' })
      toast.ok(tr('El equipo está instalando las analíticas', 'The team is installing analytics'), tr('Cuando termine, tocá «Publicar» para que la versión con analíticas quede en línea.', 'When it is done, tap "Publish" so the version with analytics goes live.'))
      open()
      setTimeout(() => reconnectBuild(a.build_id), 1500)
    } catch (e) {
      toast.error(tr('No se pudo arrancar', 'Could not start'), (e as Error).message)
      setInstalling(false)
    }
  }
  return (
    <div className="panel rounded-2xl p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[min(100%,220px)] flex-1">
          <div className="serif truncate text-[20px] leading-tight">{a.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-ink-3">
            {a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-accent hover:underline">{a.url.replace(/^https?:\/\//, '')} <ExternalLink size={11} /></a> : <span>{T('sin URL', 'no URL')}</span>}
            <span>· {a.external ? T('en tu hosting', 'on your host') : a.status === 'live' ? T('en línea', 'live') : a.status === 'deploying' ? T('desplegando', 'deploying') : a.status}</span>
          </div>
        </div>
        <button onClick={onDetail} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110"><BarChart3 size={13} /> {T('Ver detalle', 'See details')}</button>
        {a.session_id && <button onClick={open} className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-ink-2 transition hover:border-accent hover:text-accent"><Hammer size={13} /> {T('Abrir en el constructor', 'Open in the builder')}</button>}
      </div>
      {a.needs_republish && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-3.5 py-2.5 text-[12.5px] text-ink-2">
          <span className="min-w-[min(100%,220px)] flex-1">{a.status === 'building' || a.status === 'deploying' ? T('Publicando la versión con analíticas… en unos minutos empiezan a llegar las visitas.', 'Publishing the version with analytics… visits start coming in within a few minutes.') : T('Las analíticas ya están instaladas en el proyecto, pero la versión en línea es anterior. Publicala para empezar a medir.', 'Analytics are already installed in the project, but the version online is older. Publish it to start measuring.')}</span>
          {a.session_id && a.status !== 'building' && a.status !== 'deploying' && (
            <button onClick={publish} disabled={publishing} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50">
              {publishing ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />} {T('Publicar ahora', 'Publish now')}
            </button>
          )}
        </div>
      )}
      {a.external && <ExternalSetup a={a} onChange={onChange} />}
      {!a.installed && !a.external && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-3.5 py-2.5 text-[12.5px] text-ink-2">
          <span className="min-w-[min(100%,220px)] flex-1">{T('Esta app todavía no tiene las analíticas instaladas, así que no registra visitas. Un clic y el equipo las instala; después la publicás de nuevo.', 'This app does not have analytics installed yet, so it records no visits. One click and the team installs them; then you publish it again.')}</span>
          {a.session_id && (
            <button onClick={install} disabled={installing} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50">
              {installing ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} {T('Instalar analíticas', 'Install analytics')}
            </button>
          )}
        </div>
      )}
      <LiveNow n={a.stats.live} pages={a.stats.live_pages} last30={a.stats.last_30m} />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label={T('Visitas', 'Page views')} value={a.stats.pageviews} />
        <Tile label={T('Últimos 7 días', 'Last 7 days')} value={a.visits_7d} />
        <Tile label={T('Eventos', 'Events')} value={a.stats.events} />
        <Tile label={T('Errores', 'Errors')} value={a.stats.errors} warn={a.stats.errors > 0} />
      </div>
      <div className="mt-4">
        <div className="text-[11.5px] uppercase tracking-widest text-ink-3">{T('Visitas · últimos 14 días', 'Visits · last 14 days')}</div>
        <div className="mt-2 flex h-24 items-end gap-1">
          {days.map((d) => (
            <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${d.day}: ${d.n}`}>
              <div className="w-full rounded-t-[4px] bg-accent/80 transition group-hover:bg-accent" style={{ height: d.n ? `${Math.max(4, (d.n / max) * 100)}%` : '2px', opacity: d.n ? 1 : 0.25 }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10.5px] text-ink-4"><span>{days[0].day.slice(5)}</span><span>{days[13].day.slice(5)}</span></div>
      </div>
      {(a.stats.pages.length > 0 || a.stats.top_events.length > 0 || a.stats.last_errors.length > 0) && (
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <List title={T('Páginas más vistas', 'Top pages')} rows={a.stats.pages.map((p) => [p.path, p.n])} />
          <List title={T('Eventos', 'Events')} rows={a.stats.top_events.map((e) => [e.name, e.n])} />
          <List title={T('Últimos errores', 'Latest errors')} rows={a.stats.last_errors.map((e) => [e.name, new Date(e.ts * 1000).toLocaleDateString()])} />
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-[11.5px] text-ink-3">{label}</div>
      <div className={`mt-0.5 font-mono text-[22px] leading-tight tabular-nums ${warn ? 'text-danger' : 'text-ink'}`}>{value}</div>
    </div>
  )
}

function List({ title, rows }: { title: string; rows: [string, number | string][] }) {
  return (
    <div>
      <div className="text-[11.5px] uppercase tracking-widest text-ink-3">{title}</div>
      {rows.length ? (
        <ul className="mt-1.5 space-y-1">{rows.map(([k, v], i) => <li key={i} className="flex items-center justify-between gap-2 text-[12.5px]"><span className="truncate font-mono text-ink-2">{k}</span><span className="shrink-0 tabular-nums text-ink-3">{v}</span></li>)}</ul>
      ) : <div className="mt-1.5 text-[12px] text-ink-4">—</div>}
    </div>
  )
}

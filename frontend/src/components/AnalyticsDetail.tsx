import { ArrowLeft, ExternalLink, Loader2, Monitor, Smartphone, Tablet, UserRound, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { reconnectBuild } from '../buildStore'
import { api, type AnalyticsApp, type AnalyticsDetail as Detail, type AnalyticsRow } from '../lib/api'
import { getLang, tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { toast } from './Toast'
import { PanelLoader } from './HomeLoader'
import { AiTab, ErrorsTab, ExperimentsTab } from './AnalyticsObserve'
import PersonPanel from './AnalyticsPerson'

/** One published app, in depth: who visits, from where, on what device, what they tap and who the signed-in users are. */
export default function AnalyticsDetail({ app, onBack }: { app: AnalyticsApp; onBack: () => void }) {
  const T = useT()
  const [days, setDays] = useState(30)
  const [d, setD] = useState<Detail | null>(null)
  const [metric, setMetric] = useState<'visitors' | 'pageviews' | 'sessions'>('visitors')
  const [asking, setAsking] = useState(false)
  const [tab, setTab] = useState<'overview' | 'errors' | 'ai' | 'ab'>('overview')
  useEffect(() => {
    let alive = true
    const load = () => { if (document.visibilityState === 'visible') api.analyticsDetail(app.slug, days).then((x) => alive && setD(x)).catch(() => {}) }
    load()
    const t = window.setInterval(load, 30000)
    return () => { alive = false; window.clearInterval(t) }
  }, [app.slug, days])

  const [idPr, setIdPr] = useState<string | null>(null)
  const identify = async () => {
    if (app.provider === 'external') {  // a site outside Muse Team: a PR on its repo, where the app knows who signed in
      setAsking(true)
      try {
        const r = await api.siteIdentifyPr(app.slug)
        setIdPr(r.url)
        toast.ok(tr('PR abierto', 'PR opened'), tr('Revisalo y mergealo: cuando se despliegue, acá ves el email y el nombre de quienes inician sesión.', 'Review and merge it: once deployed, you see the email and name of those who sign in here.'))
      } catch (e) { toast.error(tr('No se pudo abrir el PR', 'Could not open the PR'), (e as Error).message) } finally { setAsking(false) }
      return
    }
    if (!app.session_id) return
    setAsking(true)
    try {
      await api.buildLevelPending(app.session_id, app.build_id, { focus: 'identify' })
      toast.ok(tr('El constructor está sumando la identificación de usuarios', 'The builder is adding user identification'), tr('Cuando termine, publicá: desde ahí ves email y nombre de quienes inician sesión.', 'When it is done, publish: from then on you see the email and name of those who sign in.'))
      useArena.getState().set({ pendingBuild: { buildId: app.build_id, sessionId: app.session_id } })
      setTimeout(() => reconnectBuild(app.build_id), 1500)
    } catch (e) {
      toast.error(tr('No se pudo arrancar', 'Could not start'), (e as Error).message)
      setAsking(false)
    }
  }

  const k = d?.kpis
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-ink-2 shadow-sm transition hover:border-accent hover:text-accent"><ArrowLeft size={15} /> {T('Todas las apps', 'All apps')}</button>
        <div className="min-w-[min(100%,220px)] flex-1">
          <div className="serif truncate text-[24px] leading-tight">{app.title}</div>
          {app.url && <a href={app.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-accent hover:underline">{app.url.replace(/^https?:\/\//, '')} <ExternalLink size={11} /></a>}
        </div>
        <span className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-2 shadow-sm"><span className={`h-2 w-2 rounded-full ${k?.live ? 'animate-pulse bg-ok' : 'bg-ink-4'}`} /> {k?.live ?? 0} {T('en vivo', 'live')}</span>
        <div role="group" aria-label={T('Período', 'Period')} className="flex rounded-full border border-line bg-surface p-0.5 shadow-sm">
          {[7, 30, 90].map((n) => <button key={n} onClick={() => setDays(n)} aria-pressed={days === n} className={`rounded-full px-3 py-1.5 text-[12.5px] font-medium transition ${days === n ? 'bg-accent text-white' : 'text-ink-2 hover:text-accent'}`}>{n} {T('días', 'days')}</button>)}
        </div>
      </div>

      <div role="tablist" className="mt-5 flex flex-wrap gap-1 border-b border-line">
        {([['overview', T('Resumen', 'Overview')], ['errors', T('Errores', 'Errors')], ['ai', T('IA y costos', 'AI & costs')], ['ab', T('Experimentos A/B', 'A/B experiments')]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-[13px] font-medium transition ${tab === id ? 'border-accent text-accent' : 'border-transparent text-ink-3 hover:text-ink'}`}>
            {label}{id === 'errors' && !!d?.kpis.errors && <span className="rounded-full bg-danger/10 px-1.5 text-[10.5px] font-semibold text-danger">{d.kpis.errors}</span>}
          </button>
        ))}
      </div>
      {tab === 'errors' ? <ErrorsTab app={app} days={days} /> : tab === 'ai' ? <AiTab app={app} days={days} /> : tab === 'ab' ? <ExperimentsTab app={app} days={days} /> : !d ? <div className="mt-10 min-h-[420px]"><PanelLoader caption={T('Leyendo las visitas…', 'Reading the visits…')} /></div> : (
        <>
          {k && k.identified === 0 && d.people.length > 0 && (app.session_id || app.provider === 'external') && (
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-[13px] text-ink-2">
              <UserRound size={16} className="shrink-0 text-accent" />
              <span className="min-w-[min(100%,220px)] flex-1">{app.provider === 'external'
                ? (idPr ? T('Listo el PR: mergealo y, cuando se despliegue, acá aparecen el email y el nombre de quienes inician sesión.', 'The PR is ready: merge it and, once deployed, the email and name of those who sign in show up here.')
                  : T('Todavía no sabés quiénes son tus usuarios. Si tu sitio tiene inicio de sesión, Muse Team busca tu login en GitHub y abre un PR que manda el email y el nombre de quien entra (nunca contraseñas). Tarda alrededor de un minuto.', 'You do not know who your users are yet. If your site has a log in, Muse Team finds it on GitHub and opens a PR that sends the email and name of who signs in (never passwords). It takes about a minute.'))
                : T('Todavía no sabés quiénes son tus usuarios. Si tu app tiene registro o inicio de sesión, el constructor la conecta para ver su email y nombre acá.', 'You do not know who your users are yet. If your app has sign up or log in, the builder connects it so you see their email and name here.')}</span>
              {idPr ? <a href={idPr} target="_blank" rel="noreferrer" className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110"><ExternalLink size={13} /> {T('Ver el PR', 'See the PR')}</a> : <button onClick={identify} disabled={asking} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50">{asking ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} {asking && app.provider === 'external' ? T('Buscando tu login…', 'Finding your log in…') : app.provider === 'external' ? T('Abrir el PR', 'Open the PR') : T('Identificar usuarios', 'Identify users')}</button>}
            </div>
          )}
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            <Tile label={T('Visitantes', 'Visitors')} value={k!.visitors} />
            <Tile label={T('Sesiones', 'Sessions')} value={k!.sessions} />
            <Tile label={T('Páginas vistas', 'Page views')} value={k!.pageviews} />
            <Tile label={T('Páginas por sesión', 'Pages per session')} value={k!.pages_per_session} />
            <Tile label={T('Clics', 'Clicks')} value={k!.clicks} />
            <Tile label={T('Eventos', 'Events')} value={k!.events} />
            <Tile label={T('Errores', 'Errors')} value={k!.errors} warn={k!.errors > 0} />
          </div>
          <div className="panel mt-4 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[13px] font-semibold text-ink">{metric === 'visitors' ? T('Visitantes por día', 'Visitors per day') : metric === 'pageviews' ? T('Páginas vistas por día', 'Page views per day') : T('Sesiones por día', 'Sessions per day')}</div>
              <div role="group" className="flex rounded-full border border-line p-0.5">
                {(['visitors', 'pageviews', 'sessions'] as const).map((m) => <button key={m} onClick={() => setMetric(m)} aria-pressed={metric === m} className={`rounded-full px-2.5 py-1 text-[12px] transition ${metric === m ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:text-ink'}`}>{m === 'visitors' ? T('Visitantes', 'Visitors') : m === 'pageviews' ? T('Páginas vistas', 'Page views') : T('Sesiones', 'Sessions')}</button>)}
              </div>
            </div>
            <TrendChart points={d.series.map((p) => ({ x: p.day, y: p[metric] }))} />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <BarList title={T('Países', 'Countries')} rows={d.countries} render={countryLabel} empty={T('Sin datos de país todavía', 'No country data yet')} />
            <BarList title={T('Dispositivos', 'Devices')} rows={d.devices} render={deviceLabel} />
            <BarList title={T('De dónde vienen', 'Where they come from')} rows={d.referrers} />
            <BarList title={T('Sistemas operativos', 'Operating systems')} rows={d.os} />
            <BarList title={T('Navegadores', 'Browsers')} rows={d.browsers} />
            <BarList title={T('Páginas más vistas', 'Top pages')} rows={d.pages} mono />
            <BarList title={T('Qué tocan', 'What they tap')} rows={d.clicks} empty={T('Los clics aparecen cuando la app tiene el snippet nuevo (volvé a publicar)', 'Clicks show up once the app has the new snippet (publish again)')} />
            <BarList title={T('Eventos', 'Events')} rows={d.events} mono />
            <BarList title={T('Errores', 'Errors')} rows={d.errors} mono empty={T('Sin errores', 'No errors')} />
          </div>
          <People d={d} slug={app.slug} days={days} />
        </>
      )}
    </div>
  )
}

export function Tile({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="truncate text-[11.5px] text-ink-3">{label}</div>
      <div className={`mt-0.5 font-mono text-[22px] leading-tight tabular-nums ${warn ? 'text-danger' : 'text-ink'}`}>{value}</div>
    </div>
  )
}

export const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐')
export function countryName(cc: string) {
  try { return new Intl.DisplayNames([getLang() === 'en' ? 'en' : 'es'], { type: 'region' }).of(cc) ?? cc } catch { return cc }
}
const countryLabel = (key: string) => (key === '—' ? tr('Desconocido', 'Unknown') : <><span className="mr-1.5">{flag(key)}</span>{countryName(key)}</>)
const DEVICE: Record<string, [string, string, typeof Monitor]> = { desktop: ['Computadora', 'Desktop', Monitor], mobile: ['Celular', 'Mobile', Smartphone], tablet: ['Tablet', 'Tablet', Tablet] }
export const deviceLabel = (key: string) => { const x = DEVICE[key]; if (!x) return key; const Icon = x[2]; return <span className="inline-flex items-center gap-1.5"><Icon size={13} className="text-ink-3" />{tr(x[0], x[1])}</span> }

function BarList({ title, rows, render, mono, empty }: { title: string; rows: AnalyticsRow[]; render?: (key: string) => React.ReactNode; mono?: boolean; empty?: string }) {
  const T = useT()
  const max = Math.max(1, ...rows.map((r) => r.n))
  const total = rows.reduce((n, r) => n + r.n, 0)
  return (
    <div className="panel rounded-2xl p-4">
      <div className="text-[11.5px] uppercase tracking-widest text-ink-3">{title}</div>
      {rows.length ? (
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="group relative" title={`${r.key}: ${r.n} (${Math.round((100 * r.n) / Math.max(1, total))}%)`}>
              <div className="absolute inset-y-0 left-0 rounded-[4px] bg-accent/20 transition group-hover:bg-accent/30" style={{ width: `${Math.max(2, (100 * r.n) / max)}%` }} />
              <div className="relative flex items-center justify-between gap-2 px-2 py-1 text-[12.5px]">
                <span className={`min-w-0 truncate text-ink-2 ${mono ? 'font-mono text-[12px]' : ''}`}>{render ? render(r.key) : r.key}</span>
                <span className="shrink-0 tabular-nums text-ink">{r.n}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : <div className="mt-2 text-[12px] text-ink-4">{empty ?? T('Sin datos todavía', 'No data yet')}</div>}
    </div>
  )
}

/** Single-series daily trend: area + 2px line, recessive grid, crosshair with tooltip on hover. */
export function TrendChart({ points }: { points: { x: string; y: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 800, H = 180, P = { l: 32, r: 8, t: 10, b: 22 }
  const max = Math.max(1, ...points.map((p) => p.y))
  const nice = max <= 4 ? max : Math.ceil(max / 4) * 4
  const x = (i: number) => P.l + (i * (W - P.l - P.r)) / Math.max(1, points.length - 1)
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / nice)
  const line = useMemo(() => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(''), [points, nice]) // eslint-disable-line react-hooks/exhaustive-deps
  const area = `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`
  const ticks = [0, nice / 2, nice].map((v) => Math.round(v))
  const fmt = (s: string) => s.slice(5).split('-').reverse().join('/')
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (points.length - 1)))))
  }
  const h = hover !== null ? points[hover] : null
  return (
    <div className="relative mt-3 text-accent">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[200px] w-full" preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="trend">
        {ticks.map((t) => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth="1" /><text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--color-ink-3)">{t}</text></g>)}
        <path d={area} fill="currentColor" opacity="0.12" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} fontSize="10" fill="var(--color-ink-3)">{points[i] ? fmt(points[i].x) : ''}</text>)}
        {h && hover !== null && <><line x1={x(hover)} x2={x(hover)} y1={P.t} y2={y(0)} stroke="var(--color-ink-3)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" /><circle cx={x(hover)} cy={y(h.y)} r="4" fill="currentColor" stroke="var(--color-surface)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></>}
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-md" style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 50px), calc(100% - 110px))` }}>
          <div className="text-ink-3">{fmt(h.x)}</div><div className="font-mono text-[14px] font-semibold text-ink">{h.y}</div>
        </div>
      )}
    </div>
  )
}

export function ago(ts: number) {
  const s = Math.max(1, Math.round(Date.now() / 1000 - ts))
  if (s < 90) return tr('recién', 'just now')
  const m = Math.round(s / 60)
  if (m < 60) return tr(`hace ${m} min`, `${m} min ago`)
  const h = Math.round(m / 60)
  if (h < 36) return tr(`hace ${h} h`, `${h} h ago`)
  return tr(`hace ${Math.round(h / 24)} días`, `${Math.round(h / 24)} days ago`)
}

function People({ d, slug, days }: { d: Detail; slug: string; days: number }) {
  const T = useT()
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const shown = all ? d.people : d.people.slice(0, 15)
  return (
    <div className="panel mt-4 rounded-2xl p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold text-ink">{T('Quiénes te visitan', 'Who visits you')}</div>
          <div className="mt-0.5 text-[12px] text-ink-3">{T('Tocá a alguien para ver qué hizo y pedirle a una IA que lo analice.', 'Tap someone to see what they did and have an AI analyse it.')}</div>
        </div>
        <div className="text-[12px] text-ink-3">{d.kpis.identified} {T('identificados', 'identified')} · {d.people.length} {T('visitantes en el período', 'visitors in the period')}</div>
      </div>
      {d.live.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="mr-1 flex items-center gap-1.5 text-ok"><span className="h-2 w-2 animate-pulse rounded-full bg-ok" /> {T('Ahora', 'Now')}:</span>
          {d.live.map((l, i) => <span key={i} className="rounded-full border border-line bg-surface px-2 py-0.5 text-ink-2">{l.country ? flag(l.country) + ' ' : ''}{l.path}</span>)}
        </div>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[12.5px]">
          <thead className="text-[11px] uppercase tracking-widest text-ink-3">
            <tr className="border-b border-line"><th className="py-2 pr-3 font-medium">{T('Persona', 'Person')}</th><th className="py-2 pr-3 font-medium">{T('País', 'Country')}</th><th className="py-2 pr-3 font-medium">{T('Dispositivo', 'Device')}</th><th className="py-2 pr-3 text-right font-medium">{T('Páginas', 'Pages')}</th><th className="py-2 pr-3 text-right font-medium">{T('Acciones', 'Actions')}</th><th className="py-2 pr-3 text-right font-medium">{T('Sesiones', 'Sessions')}</th><th className="py-2 font-medium">{T('Última vez', 'Last seen')}</th></tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} data-person onClick={() => setOpen(p.id)} className="cursor-pointer border-b border-line/60 transition last:border-0 hover:bg-accent-soft/50">
                <td className="py-2 pr-3">{p.email || p.name ? <div><div className="font-medium text-ink">{p.name || p.email}</div>{p.name && p.email && <div className="text-[11.5px] text-ink-3">{p.email}</div>}</div> : <span className="text-ink-3">{T('Visitante anónimo', 'Anonymous visitor')} <span className="font-mono text-[11px] text-ink-4">{p.id.slice(0, 6)}</span></span>}</td>
                <td className="py-2 pr-3 text-ink-2">{p.country ? <>{flag(p.country)} {countryName(p.country)}</> : '—'}</td>
                <td className="py-2 pr-3 text-ink-2">{p.device ? deviceLabel(p.device) : '—'}<div className="text-[11px] text-ink-4">{[p.os, p.browser].filter(Boolean).join(' · ')}</div></td>
                <td className="py-2 pr-3 text-right tabular-nums">{p.pageviews}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{p.actions}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{p.sessions}</td>
                <td className="py-2 text-ink-3">{ago(p.last_seen)}</td>
              </tr>
            ))}
            {!d.people.length && <tr><td colSpan={7} className="py-6 text-center text-ink-4">{T('Todavía no hay visitantes en este período', 'No visitors in this period yet')}</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <PersonPanel slug={slug} who={open} days={days} onClose={() => setOpen(null)} />}
      {d.people.length > 15 && <button onClick={() => setAll(!all)} className="mt-2 text-[12.5px] font-medium text-accent hover:underline">{all ? T('Ver menos', 'Show less') : T(`Ver todos (${d.people.length})`, `Show all (${d.people.length})`)}</button>}
      <p className="mt-3 text-[11.5px] text-ink-4">{T('Sin cookies ni IP: el país sale de la zona horaria del navegador y el email/nombre solo cuando tu app identifica a sus usuarios registrados. Mencionalo en tu política de privacidad.', 'No cookies or IP: the country comes from the browser time zone and email/name only when your app identifies its registered users. Mention it in your privacy policy.')}</p>
    </div>
  )
}

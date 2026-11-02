import DOMPurify from 'dompurify'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Sparkles, Check, ChevronDown, ExternalLink, GitPullRequest, Hammer, Loader2, Search, Settings2, Users, X } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'
import { api, type ClassifyJob, type ProjectMapEntry, type DashboardSession, type GroupableProp, type Ticket, type TicketRun, type TicketsConfig } from '../lib/api'
import { useT } from '../lib/i18n'
import { useArena } from '../store'
import PageHeader from './PageHeader'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'

const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string)
const PILL = 'flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const SELECT = 'h-9 rounded-xl border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent'
const CARD = 'rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'

type Bucket = 'urgent' | 'high' | 'medium' | 'low' | 'none'
const BUCKETS: { id: Bucket; es: string; en: string; color: string }[] = [
  { id: 'urgent', es: 'Urgente', en: 'Urgent', color: '#dc2626' },
  { id: 'high', es: 'Alta', en: 'High', color: '#d97706' },
  { id: 'medium', es: 'Media', en: 'Medium', color: '#0082FB' },
  { id: 'low', es: 'Baja', en: 'Low', color: '#059669' },
  { id: 'none', es: 'Sin prioridad', en: 'No priority', color: '#9aa39e' },
]
const RUN_LABEL: Record<string, [string, string, string]> = {
  building: ['Construyendo', 'Building', 'text-accent'],
  reviewing: ['El consejo revisa', 'Council reviewing', 'text-accent'],
  built: ['Construido · falta el consejo', 'Built · council pending', 'text-gold'],
  changes: ['Cambios pedidos por el consejo', 'Council asked for changes', 'text-gold'],
  pr: ['PR abierto · code review', 'PR open · code review', 'text-ok'],
  approved: ['Aprobado · sin PR', 'Approved · no PR', 'text-gold'],
  queued: ['En cola', 'Queued', 'text-ink-3'],
}

const NOTION_COLOR: Record<string, string> = { default: '#9aa39e', gray: '#9aa39e', brown: '#92400e', orange: '#ea580c', yellow: '#ca8a04', green: '#059669', blue: '#0082FB', purple: '#7c3aed', pink: '#db2777', red: '#dc2626' }

type Group = { key: string; label: string; color: string; items: Ticket[] }

function dayDiff(due: string) {
  const d = new Date(due.slice(0, 10) + 'T12:00:00')
  const today = new Date(); today.setHours(12, 0, 0, 0)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

/** Groups in a meaningful order: urgency buckets, due-date horizons, or the property's own options in Notion's order. */
function groupTickets(tickets: Ticket[], by: string, groupable: GroupableProp[], en: boolean): Group[] {
  const sorted = [...tickets].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (b.edited ?? '').localeCompare(a.edited ?? ''))
  const mk = (defs: { key: string; label: string; color: string }[], keyOf: (t: Ticket) => string, other: { key: string; label: string; color: string }) => {
    const map = new Map<string, Ticket[]>()
    sorted.forEach((t) => { const k = keyOf(t); map.set(k, [...(map.get(k) ?? []), t]) })
    const out: Group[] = defs.filter((d) => map.has(d.key)).map((d) => ({ ...d, items: map.get(d.key)! }))
    const known = new Set(defs.map((d) => d.key))
    for (const [k, items] of map) if (!known.has(k) && k !== other.key) out.push({ key: k, label: k, color: '#9aa39e', items })
    if (map.has(other.key)) out.push({ ...other, items: map.get(other.key)! })
    return out
  }
  if (by === 'urgency') return mk(BUCKETS.map((b) => ({ key: b.id, label: en ? b.en : b.es, color: b.color })).filter((b) => b.key !== 'none'), (t) => t.bucket, { key: 'none', label: en ? 'No priority' : 'Sin prioridad', color: '#9aa39e' })
  if (by === 'due') {
    const defs = [
      { key: 'overdue', label: en ? 'Overdue' : 'Vencidos', color: '#dc2626' }, { key: 'today', label: en ? 'Today' : 'Hoy', color: '#ea580c' },
      { key: 'week', label: en ? 'This week' : 'Esta semana', color: '#d97706' }, { key: 'month', label: en ? 'This month' : 'Este mes', color: '#0082FB' },
      { key: 'later', label: en ? 'Later' : 'Más adelante', color: '#059669' },
    ]
    return mk(defs, (t) => { if (!t.due) return 'none'; const d = dayDiff(t.due); return d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 7 ? 'week' : d <= 31 ? 'month' : 'later' }, { key: 'none', label: en ? 'No date' : 'Sin fecha', color: '#9aa39e' })
  }
  if (by === 'assignee') return mk([], (t) => t.assignee || 'none', { key: 'none', label: en ? 'Unassigned' : 'Sin asignar', color: '#9aa39e' })
  const prop = groupable.find((g) => `prop:${g.name}` === by || (by === 'status' && g.type === 'status') || (by === 'priority' && /priorit|priorid|urgen/i.test(g.name)))
  if (prop) {
    const defs = prop.options.map((o) => ({ key: o.name, label: o.name, color: NOTION_COLOR[o.color ?? 'default'] ?? '#9aa39e' }))
    return mk(defs, (t) => t.fields?.[prop.name] || 'none', { key: 'none', label: en ? 'Empty' : 'Vacío', color: '#9aa39e' })
  }
  return mk([], () => 'all', { key: 'all', label: en ? 'All' : 'Todos', color: '#9aa39e' })
}

function overdue(due: string | null | undefined) {
  if (!due) return false
  const d = new Date(due.slice(0, 10) + 'T23:59:59')
  return d.getTime() < Date.now()
}

/** Tickets from Notion, grouped by urgency; «Resolver ticket» hands each one to the team of the linked project. */
export default function Tickets({ onBack }: { onBack: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [notion, setNotion] = useState<{ set: boolean; last4: string | null; me: { name: string; workspace: string | null } | null; error: string | null; oauth?: boolean } | null>(null)
  const [tok, setTok] = useState('')
  const [cfg, setCfg] = useState<TicketsConfig | null>(null)
  const [dbs, setDbs] = useState<{ id: string; title: string }[] | null>(null)
  const [projects, setProjects] = useState<DashboardSession[]>([])
  const [data, setData] = useState<{ tickets: Ticket[]; runs: Record<string, TicketRun>; groupable: GroupableProp[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [setup, setSetup] = useState(false)
  const [q, setQ] = useState('')
  const [who, setWho] = useState<string>('')
  const [groupBy, setGroupBy] = useState<string>(() => { try { return localStorage.getItem('tickets.groupBy') || 'urgency' } catch { return 'urgency' } })
  const [showAll, setShowAll] = useState(false)
  const [job, setJob] = useState<ClassifyJob | null>(null)
  // which project's tickets to show: 'mine' = every Feature value with an assigned project, a value, or 'all'
  const [projFilter, setProjFilter] = useState<string>(() => { try { return localStorage.getItem('tickets.project') || 'mine' } catch { return 'mine' } })
  const [open, setOpen] = useState<Record<string, { markdown: string; fields: Record<string, string> } | 'loading' | undefined>>({})

  const loadStatus = () => api.notionStatus().then(setNotion).catch(() => {})
  const loadCfg = () => api.ticketsConfig().then(setCfg).catch(() => {})
  const loadTickets = () => api.tickets(showAll).then((d) => { setData({ tickets: d.tickets, runs: d.runs, groupable: d.groupable ?? [] }); if (d.classify) setJob(d.classify); setErr(null) }).catch((e) => setErr((e as Error).message))
  useEffect(() => {
    loadStatus(); loadCfg()
    api.dashboard().then((d) => setProjects(d.sessions.filter((s) => (s.builds ?? []).length > 0))).catch(() => {})
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projKey = JSON.stringify(cfg?.link?.projects ?? null)  // the per-feature mapping changes which tickets are resolvable
  useEffect(() => { if (cfg?.link?.database_id && notion?.set) loadTickets() }, [cfg?.link?.database_id, cfg?.link?.build_id, projKey, notion?.set, showAll])
  useEffect(() => { try { localStorage.setItem('tickets.groupBy', groupBy) } catch { /* ignore */ } }, [groupBy])
  useEffect(() => { try { localStorage.setItem('tickets.project', projFilter) } catch { /* ignore */ } }, [projFilter])
  useEffect(() => { if (notion?.set && (setup || !cfg?.link?.database_id)) api.notionDatabases().then((d) => setDbs(d.databases)).catch((e) => setErr((e as Error).message)) }, [notion?.set, setup, cfg?.link?.database_id])
  const active = useMemo(() => Object.values(data?.runs ?? {}).some((r) => r.status === 'building' || r.status === 'reviewing'), [data])
  useEffect(() => {
    if (!active) return
    const t = setInterval(loadTickets, 8000)
    return () => clearInterval(t)
  }, [active])
  // detection runs in the background: poll it, then reload the tickets with their detected projects
  useEffect(() => {
    if (job?.status !== 'running') return
    const t = setInterval(() => api.ticketsClassifyStatus().then((j) => { setJob(j); if (j.status !== 'running') loadTickets() }).catch(() => {}), 2500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status])
  const detect = async () => {
    try { setJob(await api.ticketsClassify()) } catch (e) { toast.error(T('No se pudo detectar', 'Could not detect'), (e as Error).message) }
  }
  const setProject = async (t: Ticket, value: string) => {
    const [sid, bid] = value.split('|')
    try { await api.ticketSetProject(t.id, { session_id: sid || null, build_id: bid || null }); loadTickets() } catch (e) { toast.error(T('No se pudo guardar', 'Could not save'), (e as Error).message) }
  }

  const link = cfg?.link
  const schema = cfg?.schema && !('error' in cfg.schema) ? cfg.schema : null
  const ready = !!(notion?.set && link?.database_id)  // tickets show as soon as the database is set
  // the project property (Feature, Repo, …): with one set, each value of it needs its own Tably project and tickets go strictly there
  const projProp = link?.projects?.prop ?? schema?.props?.project ?? ''
  const projMap = link?.projects?.map ?? {}
  const projOptions = useMemo(() => {
    const fromSchema = schema?.project_props?.find((p) => p.name === projProp)?.options ?? []
    const seen = new Set((data?.tickets ?? []).flatMap((x) => (x.project_value ?? '').split(',').map((v) => v.trim()).filter(Boolean)))
    return [...new Set([...fromSchema, ...seen, ...Object.keys(projMap)])]
  }, [schema, projProp, data, projMap])
  const strict = !!link?.projects?.prop
  const anyDetected = (data?.tickets ?? []).some((x) => x.project?.ok)
  const canResolve = anyDetected || (strict ? Object.values(projMap).some((m) => m.build_id) : !!link?.build_id)
  const multi = projects.reduce((n, p) => n + (p.builds ?? []).length, 0) > 1  // several uploaded projects: tickets must be told apart
  const saveProjects = (prop: string | null, map: Record<string, ProjectMapEntry>) => saveCfg({ projects: { prop, map } })
  const showSetup = setup || !ready

  const saveToken = async () => {
    setBusy('token')
    try { setNotion(await api.saveNotionToken(tok.trim())); setTok(''); toast.ok(T('Notion conectado', 'Notion connected')) } catch (e) { toast.error(T('No se pudo conectar Notion', 'Could not connect Notion'), (e as Error).message) } finally { setBusy(null) }
  }
  const saveCfg = async (body: Record<string, unknown>) => {
    setBusy('cfg')
    try { setCfg(await api.saveTicketsConfig(body)) } catch (e) { toast.error(T('No se pudo guardar', 'Could not save'), (e as Error).message) } finally { setBusy(null) }
  }
  const resolve = async (t: Ticket) => {
    setBusy(t.id)
    try {
      const r = await api.ticketResolve(t.id)
      toast.ok(T('El equipo tomó el ticket', 'The team took the ticket'), T(`Construyendo en la rama ${r.branch}. Cuando el consejo apruebe, abre el PR.`, `Building on branch ${r.branch}. When the council approves, it opens the PR.`), { label: T('Ver al equipo', 'Watch the team'), onClick: () => useArena.getState().set({ pendingBuild: { buildId: r.build_id, sessionId: r.session_id } }) })
      loadTickets()
    } catch (e) {
      toast.error(T('No se pudo resolver', 'Could not resolve'), (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const expand = async (t: Ticket) => {
    if (open[t.id]) { setOpen((o) => ({ ...o, [t.id]: undefined })); return }
    setOpen((o) => ({ ...o, [t.id]: 'loading' }))
    try { const d = await api.ticket(t.id); setOpen((o) => ({ ...o, [t.id]: { markdown: d.markdown, fields: d.fields } })) } catch (e) { toast.error(T('No pude leer el ticket', 'Could not read the ticket'), (e as Error).message); setOpen((o) => ({ ...o, [t.id]: undefined })) }
  }

  const people = useMemo(() => [...new Set((data?.tickets ?? []).map((t) => t.assignee).filter(Boolean) as string[])], [data])
  const mapped = Object.entries(projMap).filter(([, m]) => m.build_id)
  const filtering = strict || (multi && anyDetected)
  const inProject = (t: Ticket) => !filtering || projFilter === 'all' || (projFilter === 'mine' ? !!t.project?.ok : t.project?.key === projFilter)
  const hidden = filtering ? (data?.tickets ?? []).filter((t) => !inProject(t)).length : 0
  const visible = (data?.tickets ?? []).filter((t) => inProject(t) && (!q || t.title.toLowerCase().includes(q.toLowerCase())) && (!who || (t.assignee ?? '').includes(who)))
  const project = projects.find((p) => p.id === link?.session_id)
  const build = project?.builds?.find((b) => b.id === link?.build_id)

  return (
    <div className="min-h-full bg-paper">
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader onBack={onBack} kicker="Notion" title="Tickets" subtitle={T('Tus tickets de Notion, por urgencia. «Resolver ticket» se lo da al equipo: lo construye, el consejo lo verifica contra el ticket y, si aprueba, abre el pull request y lo pasa a code review.', 'Your Notion tickets, by urgency. "Resolve ticket" hands it to the team: it builds it, the council verifies it against the ticket and, if it approves, opens the pull request and moves it to code review.')}
          right={ready ? <button onClick={() => setSetup((v) => !v)} className={PILL}><Settings2 size={14} /> {T('Configurar', 'Set up')}</button> : undefined} />

        {/* the link: Notion token → database → Tably project → status mapping → GitHub */}
        <AnimatePresence initial={false}>
          {showSetup && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className={`${CARD} mt-6`}>
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider="notion" size={12} /></span> 1 · Notion</div>
                  {notion?.set ? (
                    <div className="mt-2 flex items-center gap-2 text-[13px]"><span className="flex items-center gap-1 text-ok"><Check size={13} /> {T('Conectado', 'Connected')}</span><span className="text-ink-2">{notion.me?.workspace ?? notion.me?.name ?? ''}</span>{notion.error && <span className="text-danger">{notion.error}</span>}<button onClick={async () => { await api.saveNotionToken(null, true); loadStatus(); setCfg(null); setData(null) }} className="ml-auto text-[12px] text-ink-3 hover:text-danger">{T('Desconectar', 'Disconnect')}</button></div>
                  ) : (
                    <>
                      {notion?.oauth && (
                        <button onClick={async () => { setBusy('oauth'); try { const r = await api.notionOauthUrl(); if (r.url) location.href = r.url } catch (e) { toast.error(T('No se pudo abrir Notion', 'Could not open Notion'), (e as Error).message); setBusy(null) } }} disabled={busy === 'oauth'} className={`${PRIMARY} mt-2`}>
                          {busy === 'oauth' ? <Loader2 size={14} className="animate-spin" /> : <ProviderLogo provider="notion" size={14} />} {T('Conectar con Notion', 'Connect with Notion')}
                        </button>
                      )}
                      {!notion?.oauth && <p className="mt-2 text-[12.5px] text-ink-2">{T('Para que todos conecten con un clic, quien administra la app carga el client ID y el secret de Notion en', 'So everyone can connect with one click, the app admin sets the Notion client ID and secret in')} <button onClick={() => useArena.getState().set({ view: 'settings' })} className="text-accent hover:underline">{T('Modelos y API keys', 'Models & API keys')}</button>.</p>}
                      <p className="mt-2 text-[12.5px] text-ink-2">{notion?.oauth ? T('O con una integración interna: creala en', 'Or with an internal integration: create it at') : T('Mientras tanto, con una integración interna: creala en', 'Meanwhile, with an internal integration: create it at')} <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer" className="text-accent hover:underline">notion.so/my-integrations</a>{T(', pegá el token acá y compartí la base de tickets con la integración (··· → Conexiones).', ', paste the token here and share the tickets database with the integration (··· → Connections).')}</p>
                      <div className="mt-2 flex gap-2"><input type="password" autoComplete="off" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="ntn_… / secret_…" className="h-9 flex-1 rounded-xl border border-line bg-paper px-3 text-[13px] outline-none focus:border-accent" /><button onClick={saveToken} disabled={!tok.trim() || busy === 'token'} className={PRIMARY}>{busy === 'token' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {T('Conectar', 'Connect')}</button></div>
                    </>
                  )}
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">2 · {T('Base de tickets', 'Tickets database')}</div>
                  <select disabled={!notion?.set} value={link?.database_id ?? ''} onChange={(e) => saveCfg({ database_id: e.target.value })} className={`${SELECT} mt-2 w-full`}>
                    <option value="">{dbs ? T('Elegí la base…', 'Pick the database…') : T('Cargando bases…', 'Loading databases…')}</option>
                    {(dbs ?? (link?.database_id ? [{ id: link.database_id, title: link.database_title ?? link.database_id }] : [])).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </select>
                  {schema && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {(['todo', 'in_progress', 'review', 'done'] as const).map((k) => (
                        <label key={k} className="text-[11px] text-ink-3">
                          {{ todo: T('Por hacer', 'To do'), in_progress: T('En curso', 'In progress'), review: 'Code review', done: T('Hecho', 'Done') }[k]}
                          <select value={link?.status_map?.[k] ?? ''} onChange={(e) => saveCfg({ status_map: { ...(link?.status_map ?? {}), [k]: e.target.value || null } })} className={`${SELECT} mt-0.5 h-8 w-full text-[12px]`}>
                            <option value="">—</option>
                            {schema.status_options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  )}
                  {cfg?.schema && 'error' in cfg.schema && <div className="mt-1 text-[12px] text-danger">{cfg.schema.error}</div>}
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">3 · {T('Qué proyecto de Tably resuelve cada ticket', 'Which Tably project resolves each ticket')}</div>
                  {(schema?.project_props?.length ?? 0) > 0 && (
                    <label className="mt-2 block text-[12px] text-ink-2">{T('Propiedad que dice de qué proyecto es el ticket', 'Property that says which project a ticket belongs to')}
                      <select value={projProp} onChange={(e) => saveProjects(e.target.value || null, projMap)} className={`${SELECT} mt-1 w-full`}>
                        <option value="">{T('Ninguna: un solo proyecto para todos', 'None: one project for every ticket')}</option>
                        {schema!.project_props!.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                      </select>
                    </label>
                  )}
                  {projProp ? (
                    <div className="mt-2 overflow-hidden rounded-xl border border-line">
                      {projOptions.map((opt) => {
                        const m = projMap[opt]
                        return (
                          <div key={opt} className="grid grid-cols-[1fr_1.4fr_1.2fr] items-center gap-2 border-b border-line bg-paper px-3 py-1.5 last:border-b-0">
                            <span className="truncate text-[12.5px] font-medium text-ink">{opt}</span>
                            <select value={m?.build_id ? `${m.session_id}|${m.build_id}` : ''} onChange={(e) => { const [sid, bid] = e.target.value.split('|'); saveProjects(projProp, { ...projMap, [opt]: { session_id: sid || null, build_id: bid || null, repo_url: m?.repo_url ?? null } }) }} className={`${SELECT} h-8 w-full text-[12px]`}>
                              <option value="">{T('Sin proyecto: no se resuelve', 'No project: not resolvable')}</option>
                              {projects.map((p) => (p.builds ?? []).map((b) => <option key={b.id} value={`${p.id}|${b.id}`}>{p.title || p.topic} · v{b.version ?? 1}</option>))}
                            </select>
                            <input defaultValue={m?.repo_url ?? ''} key={`${opt}-${m?.repo_url ?? ''}`} onBlur={(e) => { if ((e.target.value || '') !== (m?.repo_url ?? '')) saveProjects(projProp, { ...projMap, [opt]: { session_id: m?.session_id ?? null, build_id: m?.build_id ?? null, repo_url: e.target.value.trim() || null } }) }} placeholder={T('repo en GitHub (vacío: Tably lo crea)', 'GitHub repo (empty: Tably creates it)')} className="h-8 w-full rounded-lg border border-line bg-surface px-2 font-mono text-[11px] outline-none focus:border-accent" />
                          </div>
                        )
                      })}
                      {projOptions.length === 0 && <div className="px-3 py-2 text-[12px] text-ink-3">{T('Esa propiedad no tiene valores todavía.', 'That property has no values yet.')}</div>}
                      {projOptions.some((o) => !projMap[o]?.build_id) && (
                        <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-1.5 text-[12px] text-ink-2">
                          <span>{T('Los que siguen sin proyecto →', 'The ones still without a project →')}</span>
                          <select value="" onChange={(e) => { const [sid, bid] = e.target.value.split('|'); if (!bid) return; const next = { ...projMap }; for (const o of projOptions) if (!next[o]?.build_id) next[o] = { session_id: sid, build_id: bid, repo_url: next[o]?.repo_url ?? null }; saveProjects(projProp, next) }} className={`${SELECT} h-8 text-[12px]`}>
                            <option value="">{T('elegir proyecto…', 'pick a project…')}</option>
                            {projects.map((p) => (p.builds ?? []).map((b) => <option key={b.id} value={`${p.id}|${b.id}`}>{p.title || p.topic} · v{b.version ?? 1}</option>))}
                          </select>
                        </div>
                      )}
                    </div>
                  ) : (
                    <select value={link?.build_id ? `${link.session_id}|${link.build_id}` : ''} onChange={(e) => { const [s, b] = e.target.value.split('|'); saveCfg({ session_id: s || null, build_id: b || null }) }} className={`${SELECT} mt-2 w-full`}>
                      <option value="">{T('Elegí el proyecto…', 'Pick the project…')}</option>
                      {projects.map((p) => (p.builds ?? []).map((b) => <option key={b.id} value={`${p.id}|${b.id}`}>{p.title || p.topic} · v{b.version ?? 1}</option>))}
                    </select>
                  )}
                  <div className="mt-1 text-[11.5px] text-ink-3">{projProp
                    ? T(`Cada ticket va al proyecto de su «${projProp}». Un valor sin proyecto asignado no se puede resolver: así un ticket del Codifier nunca cae en el Preprocessor.`, `Each ticket goes to the project of its "${projProp}". A value without an assigned project cannot be resolved, so a Codifier ticket never lands on the Preprocessor.`)
                    : T('El equipo trabaja sobre el código de ese proyecto. Para un repo tuyo: auditá el proyecto primero («Auditar un proyecto») y elegilo acá. Si la base mezcla tickets de varios repos, elegí arriba la propiedad que los distingue y asigná un proyecto a cada valor: así solo ves los tickets del proyecto en el que estás.', 'The team works on that project\'s code. For a repo of yours: audit it first ("Audit a project") and pick it here. If the database mixes tickets from several repos, pick the property that tells them apart above and assign a project to each value: then you only see the tickets of the project you are on.')}</div>
                </div>
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider="github" size={12} /></span> 4 · GitHub</div>
                  <div className="mt-2 text-[13px]">{cfg?.github?.set ? <span className="flex items-center gap-1 text-ok"><Check size={13} /> {T('Token cargado: el PR se abre solo', 'Token set: the PR opens by itself')}</span> : <span className="text-ink-2">{T('Sin token: el ticket se construye y se revisa, pero no hay PR.', 'No token: the ticket is built and reviewed, but no PR.')} <button onClick={() => useArena.getState().set({ view: 'settings' })} className="text-accent hover:underline">{T('Cargar en Modelos y API keys', 'Add it in Models & API keys')}</button></span>}</div>
                  {!projProp && <input value={link?.repo_url ?? ''} onChange={(e) => setCfg((c) => (c ? { ...c, link: { ...(c.link ?? {}), repo_url: e.target.value } as TicketsConfig['link'] } : c))} onBlur={(e) => saveCfg({ repo_url: e.target.value })} placeholder={T('https://github.com/usuario/repo (vacío: Tably lo crea)', 'https://github.com/user/repo (empty: Tably creates it)')} className="mt-2 h-9 w-full rounded-xl border border-line bg-paper px-3 font-mono text-[12px] outline-none focus:border-accent" />}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {ready && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.25em] text-ink-3">{link?.database_title}</span>
              {filtering ? (
                <label className="flex items-center gap-1.5 text-[12px] text-ink-3"><Hammer size={11} />
                  <select value={projFilter} onChange={(e) => setProjFilter(e.target.value)} className={SELECT}>
                    <option value="mine">{T('Mis proyectos', 'My projects')} · {mapped.length}</option>
                    {mapped.map(([k, m]) => { const p = projects.find((x) => x.id === m.session_id); return <option key={k} value={k}>{k} → {p?.title || p?.topic || '…'}</option> })}
                    <option value="all">{T('Todos los tickets de la base', 'Every ticket in the database')}</option>
                  </select>
                </label>
              ) : build && <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-2"><Hammer size={11} className="mr-1 inline" />{project?.title || project?.topic} · v{build.version ?? 1}</span>}
              <div className="ml-auto flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[12px] text-ink-3">{T('Agrupar por', 'Group by')}
                  <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={SELECT}>
                    <option value="urgency">{T('Urgencia', 'Urgency')}</option>
                    <option value="due">{T('Fecha de vencimiento', 'Due date')}</option>
                    <option value="assignee">{T('Asignado', 'Assignee')}</option>
                    {(data?.groupable ?? []).filter((g) => g.type !== 'people' && g.type !== 'date').map((g) => <option key={g.name} value={`prop:${g.name}`}>{g.name}</option>)}
                  </select>
                </label>
                {people.length > 0 && (
                  <select value={who} onChange={(e) => setWho(e.target.value)} className={SELECT}><option value="">{T('Todos', 'Everyone')}</option>{people.map((p) => <option key={p} value={p}>{p}</option>)}</select>
                )}
                <label className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {T('incluir cerrados', 'include closed')}</label>
                <label className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-[13px]"><Search size={13} className="text-ink-3" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={T('buscar…', 'search…')} className="w-36 bg-transparent outline-none" /></label>
                {multi && (
                  <button onClick={detect} disabled={job?.status === 'running'} className={PILL} title={T('Lee cada ticket y detecta a cuál de tus proyectos pertenece por los archivos, carpetas y repos que nombra; si no alcanza, pregunta al modelo', 'Reads every ticket and detects which of your projects it belongs to from the files, folders and repos it names; the model decides when that is not enough')}>
                    {job?.status === 'running' ? <><Loader2 size={13} className="animate-spin" /> {T(`Detectando ${job.done ?? 0}/${job.total ?? '…'}`, `Detecting ${job.done ?? 0}/${job.total ?? '…'}`)}</> : <><Sparkles size={13} /> {T('Detectar proyectos', 'Detect projects')}</>}
                  </button>
                )}
                <button onClick={loadTickets} className={PILL}>{T('Actualizar', 'Refresh')}</button>
              </div>
            </div>
            {job && !job.quiet && job.status !== 'running' && job.status !== 'idle' && (
              <div className={`mt-3 text-[11.5px] ${job.status === 'error' ? 'text-danger' : 'text-ink-3'}`}>
                {job.status === 'error' ? job.error : T(`Detección lista: ${job.detected ?? 0} ticket(s) con proyecto, ${job.undecided ?? 0} sin evidencia suficiente (elegilo a mano en la card).`, `Detection done: ${job.detected ?? 0} ticket(s) with a project, ${job.undecided ?? 0} without enough evidence (pick it by hand on the card).`)}
                <button onClick={() => setJob(null)} className="ml-2 text-accent hover:underline">{T('ok', 'ok')}</button>
              </div>
            )}
            {!canResolve && !showSetup && <div className="mt-4 flex items-center gap-2 rounded-xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-[13px] text-ink-2"><Hammer size={14} className="text-gold" /> {T('Para resolver tickets falta elegir el proyecto de Tably que los trabaja.', 'To resolve tickets, pick the Tably project that works on them.')} <button onClick={() => setSetup(true)} className="ml-auto text-accent hover:underline">{T('Elegir proyecto', 'Pick project')}</button></div>}
            {err && <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{err}</div>}
            {!data && !err && <div className="mt-10 flex justify-center text-ink-3"><Loader2 size={18} className="animate-spin" /></div>}
            {data && visible.length === 0 && <div className="mt-8 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-sm text-ink-2">{hidden > 0 ? T(`No hay tickets abiertos de este proyecto. Hay ${hidden} de otros proyectos o sin proyecto asignado.`, `No open tickets for this project. ${hidden} belong to other projects or have none assigned.`) : T('No hay tickets abiertos en esta base.', 'No open tickets in this database.')} {hidden > 0 && <button onClick={() => setProjFilter('all')} className="text-accent hover:underline">{T('Ver todos', 'Show all')}</button>}</div>}
            {data && visible.length > 0 && hidden > 0 && <div className="mt-3 text-[11.5px] text-ink-3">{T(`${hidden} ticket(s) de otros proyectos o sin proyecto asignado no se muestran.`, `${hidden} ticket(s) from other projects or without a project are hidden.`)} <button onClick={() => setProjFilter('all')} className="text-accent hover:underline">{T('Ver todos', 'Show all')}</button></div>}
            {groupTickets(visible, groupBy, data?.groupable ?? [], en).map((bk) => {
              const items = bk.items
              return (
                <section key={bk.key} className="mt-6">
                  <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: bk.color }} /><h2 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: bk.color }}>{bk.label}</h2><span className="font-mono text-[11px] text-ink-3">{items.length}</span></div>
                  <div className="mt-2 flex flex-col gap-2">
                    {items.map((t) => {
                      const run = data!.runs[t.id]
                      const working = run && (run.status === 'building' || run.status === 'reviewing')
                      const tp = t.project
                      const tproj = tp?.ok ? projects.find((p) => p.id === tp.session_id) : undefined
                      const tbuild = tproj?.builds?.find((b) => b.id === tp?.build_id)
                      const noProject = tp ? !tp.ok : !canResolve
                      const noProjectMsg = !tp || tp.reason === 'sin_proyecto' ? T('Elegí primero el proyecto de Tably', 'Pick the Tably project first')
                        : tp.reason === 'ticket_sin_valor' ? T(`El ticket no tiene «${tp.prop}» en Notion`, `The ticket has no "${tp.prop}" in Notion`)
                        : T(`«${tp.key}» no tiene proyecto asignado`, `"${tp.key}" has no project assigned`)
                      const lbl = run ? RUN_LABEL[run.status] : null
                      const detail = open[t.id]
                      return (
                        <motion.div key={t.id} layout className="panel relative overflow-hidden rounded-2xl px-4 py-3">
                          <div className="absolute inset-y-0 left-0 w-1" style={{ background: bk.color }} />
                          <div className="flex items-start gap-3 pl-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <button onClick={() => expand(t)} className="text-left text-[14.5px] font-semibold text-ink hover:text-accent">{t.title}</button>
                                {t.status && <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2">{t.status}</span>}
                                {t.priority && <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: `${bk.color}18`, color: bk.color }}>{t.priority}</span>}
                                {t.due && <span className={`flex items-center gap-1 text-[11px] ${overdue(t.due) ? 'font-semibold text-danger' : 'text-ink-3'}`}>{overdue(t.due) && <AlertTriangle size={11} />}{t.due.slice(0, 10)}</span>}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-3">
                                {t.assignee && <span className="flex items-center gap-1"><Users size={11} /> {t.assignee}</span>}
                                {Object.entries(t.extra ?? {}).map(([k, v]) => <span key={k}>{k}: <span className="text-ink-2">{v}</span></span>)}
                                {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-accent"><ExternalLink size={11} /> Notion</a>}
                                {lbl && <span className={`flex items-center gap-1 font-semibold ${lbl[2]}`}>{working && <Loader2 size={11} className="animate-spin" />}{run.status === 'pr' && <GitPullRequest size={11} />}{en ? lbl[1] : lbl[0]}{run.error && run.status !== 'pr' ? ` · ${run.error}` : ''}</span>}
                                {run?.pr_url && <a href={run.pr_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent hover:underline"><GitPullRequest size={11} /> {T('Ver PR', 'View PR')}</a>}
                                {(strict || multi) && (tp?.ok
                                  ? <span className="flex items-center gap-1 text-ink-2" title={tp.evidence ?? undefined}><Hammer size={11} /> {tp.method === 'feature' ? `${tp.key} → ` : tp.method === 'manual' ? T('a mano → ', 'by hand → ') : tp.method === 'auto' || tp.method === 'llm' ? T('detectado → ', 'detected → ') : ''}{tproj?.title || tproj?.topic || '…'}{tbuild ? ` · v${tbuild.version ?? 1}` : ''}{(tp.method === 'auto' || tp.method === 'llm') && tp.evidence ? <span className="text-ink-3"> · {tp.evidence.slice(0, 90)}</span> : null}</span>
                                  : <span className="flex items-center gap-1 text-danger"><AlertTriangle size={11} /> {noProjectMsg}{strict && <button onClick={() => setSetup(true)} className="text-accent hover:underline">{T('asignar', 'assign')}</button>}</span>)}
                                {(strict || multi) && !working && (
                                  <select value={tp?.method === 'manual' && tp.build_id ? `${tp.session_id}|${tp.build_id}` : ''} onChange={(e) => setProject(t, e.target.value)} className="h-6 rounded-md border border-line bg-surface px-1 text-[11px] text-ink-2 outline-none focus:border-accent" title={T('Elegir el proyecto de este ticket a mano', 'Pick this ticket\'s project by hand')}>
                                    <option value="">{tp?.method === 'manual' ? T('quitar elección', 'clear choice') : T('cambiar proyecto…', 'change project…')}</option>
                                    {projects.map((p) => (p.builds ?? []).map((b) => <option key={b.id} value={`${p.id}|${b.id}`}>{p.title || p.topic} · v{b.version ?? 1}</option>))}
                                  </select>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {run && run.build_id && run.session_id && (run.status === 'changes' || working || run.status === 'built') && (
                                <button onClick={() => useArena.getState().set({ pendingBuild: { buildId: run.build_id!, sessionId: run.session_id! } })} className={PILL}>{run.status === 'changes' ? T('Ver veredicto', 'See verdict') : T('Ver al equipo', 'Watch the team')}</button>
                              )}
                              {run?.status !== 'pr' && (
                                <button onClick={() => resolve(t)} disabled={!!busy || !!working || active || noProject} className={PRIMARY} title={noProject ? noProjectMsg : active ? T('El equipo ya está con otro ticket', 'The team is already on another ticket') : undefined}>
                                  {busy === t.id ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} />} {run?.status === 'changes' || run?.status === 'approved' ? T('Resolver de nuevo', 'Resolve again') : T('Resolver ticket', 'Resolve ticket')}
                                </button>
                              )}
                              <button onClick={() => expand(t)} className="rounded-md p-1 text-ink-3 hover:text-ink"><ChevronDown size={14} className={`transition ${detail ? 'rotate-180' : ''}`} /></button>
                            </div>
                          </div>
                          <AnimatePresence initial={false}>
                            {detail && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                                <div className="mt-3 border-t border-line pl-2 pt-3">
                                  {detail === 'loading' ? <Loader2 size={14} className="animate-spin text-ink-3" /> : (
                                    <>
                                      {Object.keys(detail.fields).length > 0 && <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">{Object.entries(detail.fields).map(([k, v]) => <span key={k}>{k}: <span className="text-ink-2">{v}</span></span>)}</div>}
                                      {detail.markdown.trim() ? <article className="md text-[13px]" dangerouslySetInnerHTML={{ __html: md(detail.markdown) }} /> : <div className="text-[12.5px] text-ink-3">{T('El ticket no tiene descripción: el equipo trabaja solo con el título.', 'The ticket has no description: the team works from the title alone.')}</div>}
                                    </>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </>
        )}
        {!ready && notion?.set && !link?.database_id && dbs && dbs.length === 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3 text-[13px] text-ink-2"><X size={14} className="mt-0.5 text-gold" /> {T('La integración no ve ninguna base. En Notion, abrí la base de tickets → ··· → Conexiones → agregá tu integración.', 'The integration sees no database. In Notion, open the tickets database → ··· → Connections → add your integration.')}</div>
        )}
      </div>
    </div>
  )
}

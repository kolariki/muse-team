import { AnimatePresence, motion } from 'framer-motion'
import { Check, Loader2, Minus, Pencil, Trash2, TrendingDown, TrendingUp, Users, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api, type RoleInsight, type RoleScore, type TeamMemory } from '../lib/api'
import { getLang, tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import AgentAvatar from './AgentAvatar'
import PageHeader from './PageHeader'
import { PageLoader, PanelLoader } from './HomeLoader'
import { Employees, loadEmployees, useEmployees } from './MyTeam'
import { toast } from './Toast'

/**
 * Team memory: after each council round the roles learn from what the user kept and dropped. The lessons arrive as insights
 * the user accepts, edits or dismisses; the accepted ones are each role's memory and go into its prompt from then on.
 */
const useMemory = create<{ data: TeamMemory | null; open: boolean; tab: 'team' | 'review' | 'memory' | 'score'; set: (p: Partial<{ data: TeamMemory | null; open: boolean; tab: 'team' | 'review' | 'memory' | 'score' }>) => void }>((set) => ({
  data: null,
  open: false,
  tab: 'team',
  set: (p) => set(p),
}))

const load = () => api.teamMemory().then((data) => { useMemory.getState().set({ data }); return data }).catch(() => null)
const label = (i: { role_label: string; role_label_en: string }) => (getLang() === 'en' ? i.role_label_en : i.role_label) || i.role_label
const agentOf = (i: { role: string; role_label: string }) => ({ name: i.role_label, role: i.role.startsWith('custom:') ? null : i.role })

/** Polls for new insights while signed in and tells the user once when some arrive. */
export function TeamMemoryWatcher() {
  const user = useArena((s) => s.user)
  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (!user) return
    loadEmployees()  // the faces designed in «Mi equipo» show everywhere (arena, builder, council)
    const tick = async () => {
      const d = await load()
      if (!d) return
      const n = d.insights.length
      if (seen.current !== null && n > seen.current) {
        toast.info(tr(`Tu equipo aprendió ${n - seen.current} cosa${n - seen.current === 1 ? '' : 's'}`, `Your team learned ${n - seen.current} thing${n - seen.current === 1 ? '' : 's'}`),
          tr('De lo que aceptaste y descartaste del consejo. Revisalas antes de que entren en su memoria.', 'From what you kept and dropped from the council. Review them before they go into its memory.'),
          { label: tr('Revisar', 'Review'), onClick: () => openTeam('review') })
      }
      seen.current = n
    }
    tick()
    const t = setInterval(tick, 30000)
    const onFocus = () => tick()
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
  }, [user])
  return <TeamMemoryModal />
}

/** Header pill: opens the user's team (employees, knowledge, memory, score), with the count of insights waiting for review. */
export function TeamMemoryButton({ className = '' }: { className?: string }) {
  const T = useT()
  const pending = useMemory((s) => s.data?.insights.length ?? 0)
  const n = useEmployees((s) => s.list?.length ?? 0)
  useEffect(() => { loadEmployees() }, [])
  return (
    <button onClick={() => openTeam()} title={T('Tus roles guardados: su conocimiento, lo que aprendieron y su puntaje', 'Your saved roles: their knowledge, what they learned and their score')} className={`relative flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink-2 shadow-sm transition hover:bg-accent-soft hover:border-accent hover:text-accent ${className}`}>
      <Users size={16} /> {T('Mi equipo', 'My team')}{n > 0 && pending === 0 && <span className="text-ink-4">{n}</span>}
      {pending > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{pending}</span>}
    </button>
  )
}

type Tab = 'team' | 'review' | 'memory' | 'score'

/** Opens «Mi equipo»: as its own screen from any section, as a window over the builder or a live council. */
export function openTeam(tab?: Tab) {
  const view = useArena.getState().view
  const t = tab ?? ((useMemory.getState().data?.insights.length ?? 0) > 0 ? 'review' : 'team')
  useMemory.getState().set({ tab: t })
  load()
  loadEmployees()
  // inside the builder or a live council it stays a window over the work; everywhere else it is its own screen
  if (view === 'builder' || view === 'arena') useMemory.getState().set({ open: true })
  else useArena.getState().set({ view: 'team' })
}

function TeamTabs() {
  const T = useT()
  const { data, tab } = useMemory()
  return (
    <div className="flex flex-wrap gap-1">
      {(['team', 'review', 'memory', 'score'] as const).map((k) => (
        <button key={k} onClick={() => useMemory.getState().set({ tab: k })} className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${tab === k ? 'bg-accent text-white' : 'text-ink-2 hover:bg-surface-2'}`}>
          {k === 'team' ? T('Empleados', 'Employees') : k === 'review' ? T('Para revisar', 'To review') : k === 'memory' ? T('Memoria', 'Memory') : T('Puntaje', 'Score')}
          {(k === 'review' || k === 'memory') && <span className="opacity-70"> {k === 'review' ? data?.insights.length ?? 0 : data?.memory.length ?? 0}</span>}
        </button>
      ))}
    </div>
  )
}

function TeamContent() {
  const T = useT()
  const { data, tab } = useMemory()
  const [scores, setScores] = useState<RoleScore[] | null>(null)
  useEffect(() => { if (tab === 'score') api.teamScores().then((d) => setScores(d.roles)).catch(() => setScores([])) }, [tab])
  const pending = data?.insights ?? []
  const memory = data?.memory ?? []
  const byRole = memory.reduce<Record<string, RoleInsight[]>>((acc, i) => ((acc[i.role] ??= []).push(i), acc), {})
  return (
    <>
      {!data && (tab === 'review' || tab === 'memory') && <div className="min-h-[300px]"><PanelLoader caption={T('Leyendo lo que aprendió tu equipo…', 'Reading what your team learned…')} /></div>}
      {data && tab === 'review' && (pending.length ? (
        <div className="space-y-3">{pending.map((i) => <InsightCard key={i.id} item={i} />)}</div>
      ) : (
        <Empty text={T('No hay nada para revisar. Cuando apliques los cambios de un consejo, tu equipo saca lecciones de lo que aceptaste y descartaste.', 'Nothing to review. When you apply a council’s changes, your team draws lessons from what you kept and dropped.')} />
      ))}
      {data && tab === 'memory' && (memory.length ? (
        <div className="space-y-4">
          {Object.entries(byRole).map(([role, items]) => (
            <div key={role}>
              <div className="mb-2 flex items-center gap-2"><AgentAvatar agent={agentOf(items[0])} size={28} /><span className="font-semibold">{label(items[0])}</span><span className="text-[12px] text-ink-4">{items.length} {T(items.length === 1 ? 'lección' : 'lecciones', items.length === 1 ? 'lesson' : 'lessons')}</span></div>
              <div className="space-y-2">{items.map((i) => <MemoryRow key={i.id} item={i} />)}</div>
            </div>
          ))}
        </div>
      ) : (
        <Empty text={T('Todavía no aceptaste ninguna lección. Las que aceptes aparecen acá, por rol.', 'You have not accepted any lesson yet. The ones you accept show up here, by role.')} />
      ))}
      {tab === 'score' && <Scores roles={scores} />}
      {tab === 'team' && <Employees />}
    </>
  )
}

const INTRO: [string, string] = ['Tus roles quedan guardados con su prompt, su conocimiento y su memoria, y los usás en cada proyecto nuevo. Cada uno aprende de lo que aceptás y descartás del consejo; nada entra a su memoria sin tu OK.', 'Your roles are saved with their prompt, knowledge and memory, and you use them in every new project. Each one learns from what you keep and drop from the council; nothing enters its memory without your OK.']

/** «Mi equipo» as a section of its own, next to «Modelos y API keys». */
export function TeamPage({ onBack }: { onBack: () => void }) {
  const T = useT()
  const n = useEmployees((s) => s.list?.length ?? 0)
  const ready = useEmployees((s) => !!s.list)
  const [failed, setFailed] = useState(false)
  useEffect(() => { load(); loadEmployees().then((r) => { if (!r) setFailed(true) }) }, [])
  if (!ready && !failed) return <PageLoader caption={T('Reuniendo a tu equipo…', 'Gathering your team…')} />
  return (
    <div className="h-full overflow-y-auto scroll-thin arena-bg">
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader onBack={onBack} kicker={T('Tu equipo', 'Your team')} title={T('Mi equipo', 'My team')} subtitle={T(...INTRO)}
          right={<span className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-2 shadow-sm"><Users size={15} /> {n} {T(n === 1 ? 'empleado' : 'empleados', n === 1 ? 'employee' : 'employees')}</span>} />
        <div data-tour="team" className="mt-8"><TeamTabs /></div>
        <div data-tour="team-content" className="panel mt-4 rounded-2xl p-6"><TeamContent /></div>
      </div>
    </div>
  )
}

function TeamMemoryModal() {
  const T = useT()
  const open = useMemory((s) => s.open)
  const close = () => useMemory.getState().set({ open: false })
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[300] flex items-center justify-center bg-paper/70 p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <motion.div className="flex max-h-[86vh] min-h-[min(480px,86vh)] w-full max-w-[940px] flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(30,38,34,.55)]" initial={{ y: 14, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 10, opacity: 0 }}>
            <div className="flex items-start gap-3 border-b border-line px-6 py-5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-white"><Users size={20} /></span>
              <div className="min-w-0 flex-1">
                <div className="serif text-[22px] leading-tight">{T('Mi equipo', 'My team')}</div>
                <p className="mt-1 text-[13px] text-ink-3">{T(...INTRO)}</p>
              </div>
              <button onClick={close} className="rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={18} /></button>
            </div>
            <div className="px-6 pt-3"><TeamTabs /></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6 py-4"><TeamContent /></div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)

/** What each role is worth to this user, from what happened: changes kept, blockers that held, rounds to approval. */
function Scores({ roles }: { roles: RoleScore[] | null }) {
  const T = useT()
  if (!roles) return <div className="min-h-[300px]"><PanelLoader caption={T('Calculando el puntaje de cada rol…', 'Scoring each role…')} /></div>
  if (!roles.length) return <Empty text={T('Todavía no hay datos. El puntaje sale de las rondas del consejo que aplicaste y de cuántas rondas tardó en aprobarse cada construcción.', 'No data yet. The score comes from the council rounds you applied and how many rounds each build took to be approved.')} />
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ink-3">{T('Sale de lo que pasó de verdad: qué pedidos de cada rol te quedaste al aplicar un consejo (los bloqueantes pesan doble) y cuántas rondas tardó en aprobarse lo que revisó. Si una construcción sigue sin aprobarse tras varias rondas, cuenta en contra.', 'It comes from what actually happened: which requests of each role you kept when applying a council (blocking ones weigh double) and how many rounds it took to approve what it reviewed. A build still unapproved after several rounds counts against it.')}</p>
      {roles.map((r) => (
        <div key={r.role} className="rounded-2xl border border-line p-4">
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agentOf(r)} size={36} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{label(r)}</div>
              <div className="text-[12px] text-ink-4">
                {T(`${r.rounds_reviewed} ronda${r.rounds_reviewed === 1 ? '' : 's'} de consejo`, `${r.rounds_reviewed} council round${r.rounds_reviewed === 1 ? '' : 's'}`)}
                {r.lessons > 0 && ` · ${r.lessons} ${T(r.lessons === 1 ? 'lección en memoria' : 'lecciones en memoria', r.lessons === 1 ? 'lesson in memory' : 'lessons in memory')}`}
              </div>
            </div>
            {r.trend && <span className="flex items-center gap-1 text-[12px] text-ink-3" title={T('Aceptación en sus rondas recientes contra las anteriores', 'Acceptance in its recent rounds vs. the earlier ones')}>
              {r.trend === 'up' ? <TrendingUp size={15} className="text-accent" /> : r.trend === 'down' ? <TrendingDown size={15} className="text-danger" /> : <Minus size={15} />}
              {r.trend === 'up' ? T('mejora', 'improving') : r.trend === 'down' ? T('empeora', 'worse') : T('estable', 'steady')}
            </span>}
            <div className="text-right">
              <div className="serif text-[28px] leading-none">{r.score ?? '—'}</div>
              {r.score !== null && r.provisional && <div className="mt-1 text-[10.5px] uppercase tracking-widest text-ink-4">{T('pocos datos', 'little data')}</div>}
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Stat title={T('Pedidos que te quedaste', 'Requests you kept')} value={r.asked ? `${r.kept}/${r.asked}` : '—'} bar={r.acceptance} hint={r.asked ? pct(r.acceptance) : T('no pidió cambios', 'asked no changes')} />
            <Stat title={T('Bloqueantes sostenidos', 'Blockers that held')} value={r.blocking ? `${Math.round((r.blocking_precision ?? 0) * r.blocking)}/${r.blocking}` : '—'} bar={r.blocking_precision} hint={r.blocking ? pct(r.blocking_precision) : T('sin bloqueantes', 'no blockers')} />
            <Stat title={T('Rondas hasta aprobar', 'Rounds to approval')} value={r.avg_rounds_to_approval !== null ? String(r.avg_rounds_to_approval) : '—'} bar={r.convergence}
              hint={r.open_builds ? T(`${r.open_builds} sin aprobar tras varias rondas`, `${r.open_builds} unapproved after several rounds`) : r.approvals ? T(`${r.approvals} aprobada${r.approvals === 1 ? '' : 's'}`, `${r.approvals} approved`) : T('ninguna aprobada aún', 'none approved yet')} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Stat({ title, value, bar, hint }: { title: string; value: string; bar: number | null; hint: string }) {
  return (
    <div className="rounded-xl bg-surface-2/50 px-3 py-2.5">
      <div className="text-[11.5px] text-ink-3">{title}</div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{value}</div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">{bar !== null && <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(bar * 100)}%` }} />}</div>
      <div className="mt-1 text-[11px] text-ink-4">{hint}</div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-line px-5 py-10 text-center text-[13.5px] text-ink-3">{text}</div>
}

async function decide(id: string, action: 'accept' | 'dismiss' | 'edit' | 'forget', text?: string) {
  try {
    useMemory.getState().set({ data: await api.teamMemoryDecide(id, action, text) })
    return true
  } catch (e) {
    toast.error(tr('No se pudo guardar', 'Could not save'), (e as Error).message)
    return false
  }
}

function InsightCard({ item }: { item: RoleInsight }) {
  const T = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  const [busy, setBusy] = useState(false)
  const run = async (action: 'accept' | 'dismiss') => { setBusy(true); await decide(item.id, action, action === 'accept' ? text : undefined); setBusy(false) }
  return (
    <div className="rounded-2xl border border-line bg-surface-2/40 p-4">
      <div className="flex items-center gap-2">
        <AgentAvatar agent={agentOf(item)} size={30} />
        <span className="font-semibold">{label(item)}</span>
        <span className="ml-auto text-[11px] uppercase tracking-widest text-ink-4">{T('aprendió', 'learned')}</span>
      </div>
      {editing ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="mt-3 w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent" autoFocus />
      ) : (
        <p className="mt-3 text-[14.5px] leading-snug text-ink">{text}</p>
      )}
      {item.evidence && <p className="mt-1.5 text-[12.5px] text-ink-3">{T('Por qué', 'Why')}: {item.evidence}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={busy || !text.trim()} onClick={() => run('accept')} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {editing ? T('Guardar en su memoria', 'Save to its memory') : T('Sumar a su memoria', 'Add to its memory')}
        </button>
        {!editing && <button disabled={busy} onClick={() => setEditing(true)} className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-ink-2 transition hover:border-accent hover:text-accent"><Pencil size={13} /> {T('Editar', 'Edit')}</button>}
        <button disabled={busy} onClick={() => run('dismiss')} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-3 transition hover:text-danger"><X size={13} /> {T('Descartar', 'Dismiss')}</button>
      </div>
    </div>
  )
}

function MemoryRow({ item }: { item: RoleInsight }) {
  const T = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  return (
    <div className="group flex items-start gap-2 rounded-xl border border-line px-3 py-2.5">
      {editing ? (
        <div className="flex-1">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13.5px] outline-none focus:border-accent" autoFocus />
          <div className="mt-1.5 flex gap-2">
            <button onClick={async () => { if (await decide(item.id, 'edit', text)) setEditing(false) }} className="rounded-full bg-accent px-3 py-1 text-[12.5px] font-semibold text-white">{T('Guardar', 'Save')}</button>
            <button onClick={() => { setText(item.text); setEditing(false) }} className="rounded-full px-3 py-1 text-[12.5px] text-ink-3 hover:text-ink">{T('Cancelar', 'Cancel')}</button>
          </div>
        </div>
      ) : (
        <p className="flex-1 text-[13.5px] leading-snug text-ink">{item.text}</p>
      )}
      {!editing && (
        <div className="flex shrink-0 gap-1 opacity-60 transition group-hover:opacity-100">
          <button onClick={() => setEditing(true)} className="rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-accent" title={T('Editar', 'Edit')}><Pencil size={13} /></button>
          <button onClick={() => decide(item.id, 'forget')} className="rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-danger" title={T('Olvidar', 'Forget')}><Trash2 size={13} /></button>
        </div>
      )}
    </div>
  )
}

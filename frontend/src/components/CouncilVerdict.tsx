import { visibleEngines, visibleProviders } from '../lib/flags'
import { motion } from 'framer-motion'
import { Check, CheckCircle2, ChevronDown, Hammer, HardHat, Link2, Loader2, Minus, Plus, RefreshCw, X, XCircle } from 'lucide-react'
import ReferencesField from './ReferencesField'
import { useBuild } from '../buildStore'
import { useEffect, useState } from 'react'
import { api, type EngineStatus } from '../lib/api'
import type { Provider } from '../types'
import ModelSelect from './ModelSelect'
import { tr, useT } from '../lib/i18n'
import { agentMap, useAgentColor, useArena } from '../store'
import ProviderLogo from './ProviderLogo'
import AgentAvatar from './AgentAvatar'
import { toast } from './Toast'
import { useAiConnect } from './AiConnect'

/** End of a review-mode session: the council's consolidated verdict + change list → "build again with these changes". */
export default function CouncilVerdict() {
  const T = useT()
  const council = useArena((s) => s.council)
  const show = useArena((s) => s.showVerdict)
  const config = useArena((s) => s.config)
  const turns = useArena((s) => s.turns)
  const judge = useArena((s) => s.judge)
  const set = useArena((s) => s.set)
  const colorOf = useAgentColor()
  const [picked, setPicked] = useState<Record<number, boolean>>({})
  const [rounds, setRounds] = useState(0) // after the builder applies the list, the user decides the next step (no automatic round)
  const [priorities, setPriorities] = useState('')
  const [busy, setBusy] = useState(false)
  const [redoing, setRedoing] = useState(false)
  const [refs, setRefs] = useState<string[]>([])
  const [deep, setDeep] = useState(false)
  const [refsOpen, setRefsOpen] = useState(false)
  // who builds the list: a local agent on the subscription or an API model (defaults to the build's current builder)
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [allProviders, setAllProviders] = useState<Provider[]>([])
  const ai = useAiConnect(allProviders, (np) => { setAllProviders((ps) => ps.map((x) => (x.id === np.id ? np : x))); setProviders((ps) => [np, ...ps.filter((x) => x.id !== np.id)]) })
  const [bProvider, setBProvider] = useState('')
  const [bModel, setBModel] = useState('')
  const buildProvider = useBuild((b) => b.provider)
  const buildModel = useBuild((b) => b.model)
  useEffect(() => {
    api.engines().then((es) => setEngines(visibleEngines(es))).catch(() => {})
    api.providers().then((all) => { const ps = visibleProviders(all); setAllProviders(ps); setProviders(ps.filter((p) => p.configured && p.id !== 'mock').concat(ps.filter((p) => p.id === 'mock' && p.configured))) }).catch(() => {})
  }, [])
  // the builder of the reviewed build, read from the build itself (the store may hold another build, or none after F5)
  const [reviewed, setReviewed] = useState<{ provider: string; model: string } | null>(null)
  const [userPicked, setUserPicked] = useState(false)
  const roBuild = config?.review_of?.build_id
  const roSession = config?.review_of?.session_id
  useEffect(() => {
    setReviewed(null)
    setUserPicked(false)
    if (!show || !roBuild || !roSession) return
    api.build(roSession, roBuild).then((b) => { if (b?.provider) setReviewed({ provider: String(b.provider), model: String(b.model || 'default') }) }).catch(() => {})
  }, [show, roBuild, roSession])
  // keeps the builder the user had; it only changes when the user picks another one here
  useEffect(() => {
    if (userPicked) return
    const visible = (id: string) => engines.some((e) => e.id === id) || providers.some((p) => p.id === id)
    const want = reviewed ?? (buildProvider ? { provider: buildProvider, model: buildModel || 'default' } : null)
    if (want && visible(want.provider)) {
      if (want.provider !== bProvider || want.model !== bModel) { setBProvider(want.provider); setBModel(want.model) }
      return
    }
    if (bProvider && visible(bProvider)) return
    const ok = engines.find((e) => e.ok)
    if (ok) { setBProvider(ok.id); setBModel('default') } else if (providers[0]) { setBProvider(providers[0].id); setBModel(providers[0].default_model) }
  }, [engines, providers, reviewed, buildProvider, buildModel, bProvider, bModel, userPicked])
  const isEngineSel = engines.some((e) => e.id === bProvider)
  if (!show || !config || config.mode !== 'review') return null
  const map = agentMap(config)
  const ro = config.review_of
  const closing = turns.filter((t) => t.phase === 'closing')
  const deliberating = !council

  const changes = council?.changes ?? []
  const chosen = changes.filter((_, i) => picked[i] ?? true)
  const blocking = changes.filter((c) => c.severity === 'bloqueante').length

  const build = async () => {
    if (!ro) return
    setBusy(true)
    try {
      const r = await api.councilApply(ro.build_id, ro.session_id, chosen, rounds, council?.session_id ?? useArena.getState().sessionId, rounds > 0 ? priorities.trim() : '', refs, deep, bProvider ? { provider: bProvider, model: bModel } : undefined)
      if (r.researching) useBuild.getState().set({ researching: { refs, hidden: refs.length === 0, started: Date.now(), visited: [], finished: false } })
      set({ showVerdict: false, pendingBuild: { buildId: ro.build_id, sessionId: ro.session_id } })
    } catch (e) {
      toast.error(tr('No se pudo lanzar la construcción', 'Could not start the build'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const openBuild = () => ro && set({ showVerdict: false, pendingBuild: { buildId: ro.build_id, sessionId: ro.session_id } })
  // the chairman's consolidation can come back short (cut output): redo just that step over the saved debate
  const redo = async () => {
    const sid = council?.session_id ?? useArena.getState().sessionId
    if (!sid) return
    setRedoing(true)
    try {
      const d = (await api.councilRedo(sid)) as unknown as { approved: boolean; headline: string; why: string; changes: typeof changes; priorities?: NonNullable<typeof council>['priorities']; judge_id: string; model: string }
      set({ council: { session_id: (d as { session_id?: string }).session_id ?? sid, approved: !!d.approved, headline: d.headline ?? '', why: d.why ?? '', changes: d.changes ?? [], priorities: d.priorities ?? [], judge_id: d.judge_id, model: d.model } })
      setPicked({})
      toast.ok(tr('Veredicto reconsolidado', 'Verdict re-consolidated'), `${(d.changes ?? []).length} ${tr('cambios en la lista.', 'changes on the list.')}`)
    } catch (e) {
      toast.error(tr('No se pudo reconsolidar', 'Could not re-consolidate'), (e as Error).message)
    } finally {
      setRedoing(false)
    }
  }

  const pill = 'flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
  const primary = 'flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-[15px] font-semibold text-white shadow-[0_12px_28px_-12px_rgba(47,107,93,.7)] transition hover:brightness-110 disabled:opacity-40'
  const label = 'text-[10.5px] uppercase tracking-[0.25em] text-ink-3'
  const tone = deliberating ? 'var(--color-ink-4)' : council.approved ? 'var(--color-ok)' : 'var(--color-gold)'

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px] @container" onClick={() => set({ showVerdict: false })}>
      <motion.div initial={{ opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }} className="relative flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(30,38,34,.6)]" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start gap-4 border-b border-line px-7 py-6" style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${tone} 10%, transparent) 0%, transparent 60%)` }}>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.35em] text-accent">{T('Veredicto del consejo', 'Council verdict')}{ro?.round ? ` · ${T('ronda', 'round')} ${ro.round}` : ''}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
              <h3 className="serif text-[34px] leading-tight @3xl:text-[40px]" style={{ color: deliberating ? 'var(--color-ink-3)' : council.approved ? 'var(--color-ok)' : 'var(--color-ink)' }}>
                {deliberating ? T('Deliberando…', 'Deliberating…') : council.approved ? T('Listo para producción', 'Ready for production') : T('Hay que cambiar cosas', 'Things need to change')}
              </h3>
              {!deliberating && (
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${council.approved ? 'border-ok/30 bg-ok/10 text-ok' : 'border-gold/40 bg-gold/10 text-gold'}`}>
                  <span className={`h-2 w-2 rounded-full ${council.approved ? 'bg-ok' : 'bg-gold'}`} /> {council.approved ? T('APROBADO', 'APPROVED') : `${changes.length} ${changes.length === 1 ? T('CAMBIO', 'CHANGE') : T('CAMBIOS', 'CHANGES')}${blocking ? ` · ${blocking} ${blocking === 1 ? T('BLOQUEANTE', 'BLOCKING') : T('BLOQUEANTES', 'BLOCKING')}` : ''}`}
                </span>
              )}
            </div>
            <div className="mt-1 truncate font-mono text-[12px] text-ink-3">{ro?.title ?? config.topic}</div>
          </div>
          <button onClick={() => set({ showVerdict: false })} className="rounded-full p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={18} strokeWidth={2.5} /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-4 sm:px-7 py-6">
          <div className="grid gap-6 @3xl:grid-cols-[1.2fr_1fr]">
            {/* the consolidated verdict + change list */}
            <div className="rounded-2xl border border-line bg-paper p-6 shadow-[0_12px_28px_-18px_rgba(30,38,34,.4)]" style={{ borderTop: `3px solid ${tone}` }}>
              {deliberating ? (
                <p className="flex items-center gap-2 text-ink-3"><Loader2 size={15} className="animate-spin text-accent" /> {T('El presidente del consejo consolida los veredictos de cada rol…', 'The council chair is consolidating each role’s verdict…')}</p>
              ) : (
                <>
                  {council.headline && <div className="serif text-[26px] leading-tight">{council.headline}</div>}
                  {council.why && <p className="mt-3 text-[14.5px] leading-relaxed text-ink">{council.why}</p>}
                  {(council.level?.status?.length ?? 0) > 0 && (
                    <div className="mt-4 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
                      <div className={`${label} text-ink-2`}>{T('Requisitos del nivel', 'Level requirements')} {council.level!.next} · {council.level!.label}</div>
                      <ul className="mt-1.5 space-y-1">
                        {council.level!.status.map((p) => (
                          <li key={p.id} className="flex items-start gap-2 text-[13px]">
                            {p.status === 'done' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={14} className={`${p.status === 'partial' ? 'text-gold' : 'text-danger'} mt-0.5 shrink-0`} />}
                            <span><span className={p.status === 'done' ? 'text-ink-3 line-through' : 'text-ink'}>{p.text}</span>{p.note && <span className="ml-1.5 text-[11px] text-ink-3">· {p.note}</span>}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(council.priorities?.length ?? 0) > 0 && (
                    <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3">
                      <div className={`${label} text-accent`}>{T('Lo que vos pediste', 'What you asked for')}</div>
                      <ul className="mt-1.5 space-y-1">
                        {council.priorities!.map((p) => (
                          <li key={p.id} className="flex items-start gap-2 text-[13px]">
                            {p.status === 'done' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={14} className={`${p.status === 'partial' ? 'text-gold' : 'text-danger'} mt-0.5 shrink-0`} />}
                            <span><span className={p.status === 'done' ? 'text-ink-3 line-through' : 'text-ink'}>{p.text}</span><span className={`ml-1.5 text-[11px] font-bold uppercase ${p.status === 'done' ? 'text-ok' : p.status === 'partial' ? 'text-gold' : 'text-danger'}`}>{p.status === 'done' ? T('cumplida', 'done') : p.status === 'partial' ? T('a medias', 'partial') : T('pendiente', 'pending')}</span>{p.note && <span className="block text-[11.5px] text-ink-3">{p.note}</span>}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-5 flex items-center justify-between gap-3">
                    <div className={label}>{T('Lo que hay que cambiar', 'What needs to change')} · {changes.length} {changes.length === 1 ? T('ítem', 'item') : T('ítems', 'items')}{blocking ? ` · ${blocking} ${blocking === 1 ? T('bloqueante', 'blocking') : T('bloqueantes', 'blocking')}` : ''}</div>
                    {changes.length > 0 && <button onClick={() => setPicked(Object.fromEntries(changes.map((_, i) => [i, chosen.length !== changes.length])))} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent">{chosen.length === changes.length ? T('desmarcar todo', 'uncheck all') : T('marcar todo', 'check all')}</button>}
                  </div>
                  {changes.length === 0 && <div className="mt-2 text-[13px] text-ink-2">{T('El consejo no pidió cambios.', 'The council asked for no changes.')}</div>}
                  <ul className="mt-2 space-y-2">
                    {changes.map((c, i) => {
                      const on = picked[i] ?? true
                      return (
                        <li key={i}>
                          <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 text-[13px] transition ${on ? 'border-line bg-surface shadow-sm' : 'border-dashed border-line/70 bg-transparent text-ink-3'}`}>
                            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${on ? 'border-accent bg-accent text-white' : 'border-ink-4 bg-surface'}`}><input type="checkbox" className="sr-only" checked={on} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} />{on && <Check size={13} strokeWidth={3} />}</span>
                            <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${c.severity === 'bloqueante' ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent'}`}>{c.severity}</span>
                            <span className="min-w-0 leading-relaxed"><span className={on ? 'text-ink' : ''}>{c.text}</span>{c.role && <span className="ml-1.5 text-[11px] text-ink-3">· {c.role}</span>}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  <div className="mt-4 flex items-center gap-3 border-t border-line pt-3">
                    {council.model && <span className="font-mono text-[10.5px] text-ink-4">{T('Presidente del consejo:', 'Council chair:')} {council.model}</span>}
                    <button disabled={redoing} onClick={redo} className={`ml-auto flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] shadow-sm transition disabled:opacity-50 ${changes.length === 0 && !council.approved ? 'border-danger/40 bg-danger/5 font-semibold text-danger' : 'border-line bg-surface text-ink-2 hover:border-accent hover:bg-accent-soft hover:text-accent'}`} title={T('Vuelve a correr solo al presidente sobre el mismo debate (una llamada, barato)', 'Re-runs only the chair over the same debate (one call, cheap)')}>
                      {redoing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} {changes.length === 0 && !council.approved ? T('La lista quedó vacía: reconsolidar', 'The list came back empty: re-consolidate') : T('reconsolidar la lista', 're-consolidate the list')}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* each role */}
            <div>
              <div className="rounded-2xl border border-line bg-paper p-5 shadow-[0_12px_28px_-18px_rgba(30,38,34,.4)]">
                <div className={label}>{T('Veredicto de cada rol', 'Verdict by role')}</div>
                <div className="mt-3 space-y-2">
                  {closing.length === 0 && <div className="text-[12.5px] text-ink-3">{T('Todavía no hubo ronda de cierre.', 'No closing round yet.')}</div>}
                  {closing.map((t) => {
                    const a = map[t.agent_id]
                    const ok = /^\s*aprueb/i.test(t.message)
                    return (
                      <motion.div key={t.turn} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[12.5px]" style={{ borderLeft: `3px solid ${colorOf(a)}` }}>
                        <div className="flex items-center gap-2">
                          <AgentAvatar agent={a} size={28} ring={false} className="shadow-sm" />
                          <span className="font-semibold" style={{ color: colorOf(a) }}>{a?.name}</span>
                          <span className={`ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-gold/40 bg-gold/10 text-gold'}`}>{ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {ok ? T('aprueba', 'approves') : T('pide cambios', 'requests changes')}</span>
                        </div>
                        <div className="mt-1.5 line-clamp-6 whitespace-pre-wrap leading-relaxed text-ink-2">{t.message.replace(/^\s*(APRUEBO|CAMBIOS)\s*/i, '')}</div>
                      </motion.div>
                    )
                  })}
                </div>
                {judge && deliberating && <div className="mt-3 font-mono text-[10.5px] text-ink-4">{T('preside:', 'chair:')} {judge.model}</div>}
              </div>
            </div>
          </div>
        </div>

        {/* footer: what to do with the list */}
        {!deliberating && ro && (
          <div className="border-t border-line bg-paper px-7 py-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 [&>*]:min-w-0">
              {chosen.length > 0 ? (
                <button disabled={busy} onClick={build} className={`${primary} w-full justify-center`}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Hammer size={16} />} {T('Construir con estos', 'Build with these')} {chosen.length} {chosen.length === 1 ? T('cambio', 'change') : T('cambios', 'changes')}
                </button>
              ) : council.approved ? (
                <button onClick={openBuild} className={`${primary} w-full justify-center`}><CheckCircle2 size={16} /> {T('Ver el proyecto aprobado', 'View the approved project')}</button>
              ) : (
                <button onClick={openBuild} className={`${primary} w-full justify-center`}><Hammer size={16} /> {T('Volver al constructor', 'Back to the builder')}</button>
              )}
              {chosen.length > 0 && (
                <div className="flex h-11 w-full min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-2 text-[12px] text-ink-2 shadow-sm transition hover:border-accent" title={T('Quién aplica los cambios: un agente local con tu suscripción o un modelo por API', 'Who applies the changes: a local agent on your subscription or an API model')}>
                  {/* the visible face of the picker, centred: logo + name + caret; the native select sits invisible on top */}
                  <label className="relative flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5">
                  <ProviderLogo provider={engines.find((e) => e.id === bProvider)?.logo ?? bProvider} size={16} />
                  <span className="truncate text-[12.5px] font-medium text-ink">{(engines.find((e) => e.id === bProvider)?.label ?? providers.find((p) => p.id === bProvider)?.label ?? T('Elegí constructor', 'Pick a builder')).split(' · ')[0]}</span>
                  <ChevronDown size={14} className="shrink-0 text-ink-3" />
                  <select
                    value={bProvider}
                    onChange={(e) => {
                      const id = e.target.value
                      if (ai.ask(id, (np) => { setUserPicked(true); setBProvider(np.id); setBModel(np.default_model) })) return
                      const eng = engines.find((x) => x.id === id)
                      setUserPicked(true)
                      setBProvider(id)
                      setBModel(eng ? 'default' : providers.find((p) => p.id === id)?.default_model ?? '')
                    }}
                    className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                    aria-label={T('Constructor', 'Builder')}
                  >
                    {engines.length > 0 && (
                      <optgroup label={T('Con tu suscripción', 'On your subscription')}>
                        {engines.map((e) => <option key={e.id} value={e.id} disabled={!e.ok}>{e.label.split(' · ')[0]}{e.ok ? '' : ` (${e.installed ? T('sin login', 'not logged in') : T('no instalado', 'not installed')})`}</option>)}
                      </optgroup>
                    )}
                    <optgroup label={T('Por API', 'Via API')}>
                      {providers.map((p) => <option key={p.id} value={p.id}>{p.label.split(' · ')[0]}</option>)}
                    </optgroup>
                    {ai.options}
                  </select>
                  </label>
                  {ai.dialog}
                  {!isEngineSel && bProvider && <span className="min-w-0 flex-1"><ModelSelect provider={bProvider} value={bModel} onChange={(m) => { setUserPicked(true); setBModel(m) }} /></span>}
                </div>
              )}
              {chosen.length > 0 && (
                <div className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2 shadow-sm">
                  <span className="whitespace-nowrap">{T('Luego revisa', 'Then reviews')}</span>
                  <button type="button" onClick={() => setRounds((r) => Math.max(0, r - 1))} className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-paper transition hover:border-accent hover:text-accent"><Minus size={11} /></button>
                  <span className="w-14 whitespace-nowrap text-center font-mono text-[12px] text-ink">{rounds === 0 ? T('no', 'no') : `${rounds}×`}</span>
                  <button type="button" onClick={() => setRounds((r) => Math.min(3, r + 1))} className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-paper transition hover:border-accent hover:text-accent"><Plus size={11} /></button>
                </div>
              )}
              <div className="contents">
                <button onClick={() => ro && set({ showVerdict: false, pendingBuild: { buildId: ro.build_id, sessionId: ro.session_id, fde: changes.filter((c) => c.severity === 'bloqueante').map((c) => `- ${c.text}`).join('\n') } })} className={`${pill} h-11 w-full justify-center whitespace-nowrap border-gold/40 text-gold hover:border-gold hover:bg-gold/10 hover:text-gold`} title={T('Un ingeniero nuestro resuelve esto por vos, precio fijo', 'One of our engineers solves this for you, fixed price')}><HardHat size={15} /> {T('Pedir un developer', 'Request a developer')}</button>
                <button onClick={openBuild} className={`${pill} h-11 w-full justify-center whitespace-nowrap`} title={T('Abrir el constructor sin aplicar cambios', 'Open the builder without applying changes')}><Hammer size={15} /> {T('Constructor sin cambios', 'Builder, no changes')}</button>
              </div>
            </div>
            {/* references + reverse engineering for the build that applies this list */}
            <div className="mt-3 rounded-xl border border-line bg-surface">
              <button type="button" onClick={() => setRefsOpen((v) => !v)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px]">
                <Link2 size={14} className="text-accent" />
                <span className="font-semibold">{T('Referencias e ingeniería inversa para esta construcción', 'References and reverse engineering for this build')}</span>
                <span className="text-ink-3">{refs.length ? `· ${refs.join(', ')}${deep ? ` · ${T('REA', 'REA')}` : ''}` : `· ${T('opcional', 'optional')}`}</span>
                <ChevronDown size={14} className={`ml-auto text-ink-3 transition ${refsOpen ? 'rotate-180' : ''}`} />
              </button>
              {refsOpen && (
                <div className="border-t border-line px-3.5 pb-3.5 pt-3">
                  <ReferencesField value={refs} onChange={setRefs} deep={deep} onDeep={setDeep} compact />
                  <div className="mt-1.5 text-[11.5px] text-ink-3">{T('Con referencias, el equipo las investiga primero (ves la pantalla de ingeniería inversa) y después el constructor aplica la lista tomándolas como vara; con REA, como réplica.', 'With references, the team researches them first (you see the reverse-engineering screen) and then the builder applies the list with them as the bar; with REA, as a replica.')}</div>
                </div>
              )}
            </div>
            {chosen.length > 0 && rounds > 0 && (
              <textarea value={priorities} onChange={(e) => setPriorities(e.target.value)} rows={2} placeholder={T('Para la próxima ronda: ¿qué querés que el consejo mire primero? (opcional)', 'For the next round: what should the council look at first? (optional)')} className="mt-3 w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[12.5px] shadow-sm outline-none transition focus:border-accent" />
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

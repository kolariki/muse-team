import { AnimatePresence, motion } from 'framer-motion'
import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { brandTheme } from '../lib/brand'
import { pick, tr, useLang, useT } from '../lib/i18n'
import { fmtK, fmtMs, fmtUsd, STANCE } from '../lib/parse'
import { agentMap, useAgentColor, useArena } from '../store'
import type { AgentConfig, Provider, Role, Stance } from '../types'
import ModelSelect from './ModelSelect'
import PersonaField from './PersonaField'
import ProviderLogo, { isMonoLogo, logoUrl } from './ProviderLogo'
import SkillPicker from './SkillPicker'
import { toast } from './Toast'
import { useAiConnect } from './AiConnect'

let providersCache: Provider[] | null = null
let rolesCache: { groups: string[]; groups_en?: string[]; roles: Role[] } | null = null

/**
 * Click a role's circle in the arena → this drawer: everything the role did in the debate (turns, tone, speed, tokens,
 * cost, confidence, who called it, votes) and its full setup, editable (name, company/model, role, prompt, skills).
 * Saving updates the session's team: the next round, build or review uses it; while the debate is running only the
 * model and skills can change on the fly.
 */
export default function AgentDrawer() {
  const T = useT()
  const lang = useLang()
  const agentId = useArena((s) => s.selectedAgent)
  const config = useArena((s) => s.config)
  const sessionId = useArena((s) => s.sessionId)
  const status = useArena((s) => s.status)
  const turns = useArena((s) => s.turns)
  const handoffs = useArena((s) => s.handoffs)
  const votes = useArena((s) => s.votes)
  const verdict = useArena((s) => s.verdict)
  const colorOf = useAgentColor()
  const close = () => useArena.getState().set({ selectedAgent: null })
  const agent = agentId ? agentMap(config)[agentId] : undefined

  const [providers, setProviders] = useState<Provider[]>(providersCache ?? [])
  const ai = useAiConnect(providers, (np) => setProviders((ps) => (providersCache = ps.map((x) => (x.id === np.id ? np : x)))))
  const [roles, setRoles] = useState(rolesCache)
  const [draft, setDraft] = useState<AgentConfig | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!agentId) return
    if (!providersCache) api.providers().then((p) => { providersCache = p; setProviders(p) }).catch(() => {})
    if (!rolesCache) api.roles().then((r) => { rolesCache = r; setRoles(r) }).catch(() => {})
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentId])
  // a fresh draft each time another circle is clicked
  useEffect(() => { setDraft(agent ? { ...agent, skills: [...(agent.skills ?? [])] } : null) }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    if (!agentId) return null
    const mine = turns.filter((t) => t.agent_id === agentId)
    const n = mine.length || 1
    const conf = mine.map((t) => t.confidence).filter((c): c is number => c != null)
    const ttft = mine.filter((t) => t.metrics.ttft_ms != null)
    const byStance = (['agree', 'disagree', 'propose', 'neutral'] as Stance[]).map((s) => ({ s, n: mine.filter((t) => t.stance === s && t.phase !== 'closing').length }))
    const answered: Record<string, number> = {}
    for (const t of mine) if (t.responding_to) answered[t.responding_to] = (answered[t.responding_to] ?? 0) + 1
    const passedTo: Record<string, number> = {}
    for (const h of handoffs) if (h.from === agentId) passedTo[h.to] = (passedTo[h.to] ?? 0) + 1
    const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]
    return {
      turns: mine.length,
      latency: Math.round(mine.reduce((x, t) => x + t.metrics.latency_ms, 0) / n),
      ttft: ttft.length ? Math.round(ttft.reduce((x, t) => x + (t.metrics.ttft_ms ?? 0), 0) / ttft.length) : null,
      tps: Math.round(mine.reduce((x, t) => x + t.metrics.tokens_per_s, 0) / n),
      out: mine.reduce((x, t) => x + t.metrics.output_tokens, 0),
      inp: mine.reduce((x, t) => x + t.metrics.input_tokens, 0),
      cost: mine.reduce((x, t) => x + t.metrics.cost_usd, 0),
      confAvg: conf.length ? Math.round(conf.reduce((x, y) => x + y, 0) / conf.length) : null,
      byStance,
      calledBy: handoffs.filter((h) => h.to === agentId).length,
      answeredMost: top(answered),
      passedMost: top(passedTo),
      votesFor: votes.filter((v) => v.target === agentId).length,
      voted: votes.find((v) => v.voter === agentId),
      last: mine[mine.length - 1],
    }
  }, [agentId, turns, handoffs, votes])

  if (!agent || !draft || !stats || !sessionId) return null
  const map = agentMap(config)
  const nameOf = (id?: string) => (id ? map[id]?.name ?? id : '—')
  const color = colorOf(agent)
  const theme = brandTheme(agent.wanted_provider ?? agent.provider)
  const roleLabel = roles?.roles.find((r) => r.id === agent.role)
  const running = status === 'running' || status === 'paused' || status === 'connecting' || status === 'voting'
  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...agent, skills: [...(agent.skills ?? [])] })
  const input = 'w-full rounded-lg border bg-surface px-2.5 py-1.5 text-[13px] outline-none'

  const save = async () => {
    setSaving(true)
    try {
      const st = useArena.getState()
      if (running) {
        // on a live debate the orchestrator only takes model and skill changes between turns
        if (draft.provider !== agent.provider || draft.model !== agent.model) await api.updateAgent(sessionId, agent.id, draft.provider, draft.model)
        if (JSON.stringify(draft.skills ?? []) !== JSON.stringify(agent.skills ?? [])) await api.setAgentSkills(sessionId, agent.id, draft.skills ?? [])
        const next = { ...agent, provider: draft.provider, model: draft.model, skills: draft.skills, wanted_provider: undefined }
        if (st.config) st.set({ config: { ...st.config, agents: st.config.agents.map((x) => (x.id === agent.id ? next : x)) } })
        const dropped = draft.name !== agent.name || draft.persona !== agent.persona || draft.role !== agent.role
        toast.ok(tr('Cambios aplicados al debate en curso', 'Changes applied to the running debate'), dropped ? tr('Nombre, rol y prompt se pueden editar cuando el debate termine.', 'Name, role and prompt can be edited once the debate ends.') : undefined)
      } else {
        const agents = (st.config?.agents ?? []).map((x) => (x.id === agent.id ? { ...draft, wanted_provider: undefined } : x))
        const r = await api.updateTeam(sessionId, agents)
        if (st.config) st.set({ config: { ...st.config, agents: r.agents } })
        toast.ok(tr('Rol actualizado', 'Role updated'), tr('La próxima ronda, construcción o repetición usa esta configuración; el debate ya grabado no cambia.', 'The next round, build or rerun uses this setup; the recorded debate does not change.'))
      }
    } catch (e) {
      toast.error(tr('No se pudo guardar', 'Could not save'), (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const stat = (label: string, value: string, sub?: string) => (
    <div className="rounded-xl bg-surface px-3 py-2 shadow-[0_2px_8px_-4px_rgba(30,38,34,.25)]" style={{ border: `1.5px solid ${theme.accent}` }}>
      <div className="text-[9.5px] font-semibold uppercase tracking-widest" style={{ color: theme.accent }}>{label}</div>
      <div className="font-mono text-[14px] font-bold tabular-nums text-ink">{value}</div>
      {sub && <div className="text-[10px] text-ink-4">{sub}</div>}
    </div>
  )
  const section = (title: string) => <div className="mt-4 mb-1.5 text-[10.5px] font-semibold uppercase tracking-widest text-ink-3">{title}</div>

  return createPortal(
    <AnimatePresence>
      <motion.div key="bg" className="fixed inset-0 z-[140] bg-ink/20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
      <motion.aside
        key="panel"
        className="fixed inset-y-0 right-0 z-[141] flex flex-col overflow-hidden border-l shadow-2xl"
        style={{ width: 460, maxWidth: '100vw', background: 'var(--color-surface)', borderColor: theme.accent }}
        initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 60, opacity: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* the company's logo as a big faint watermark behind everything, like the role cards on the home */}
        {logoUrl(agent.wanted_provider ?? agent.provider) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" aria-hidden>
            <img src={logoUrl(agent.wanted_provider ?? agent.provider)!} alt="" draggable={false} className={`select-none ${isMonoLogo(agent.wanted_provider ?? agent.provider) ? 'logo-mono' : ''}`} style={{ width: '72%', maxWidth: 330, opacity: 0.13, filter: isMonoLogo(agent.wanted_provider ?? agent.provider) ? undefined : 'saturate(0.9)' }} />
          </div>
        )}
        {/* header in the company's colours */}
        <div className="relative shrink-0 border-b px-5 py-5" style={{ borderColor: `color-mix(in srgb, ${theme.accent} 33%, transparent)` }}>
          <div className="flex items-center gap-3 pr-12">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface leading-none" style={{ border: `2px solid ${color}` }}><ProviderLogo provider={agent.wanted_provider ?? agent.provider} size={24} /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[17px] font-semibold leading-tight text-ink">{agent.name} {verdict?.winner === agent.id && <span title={T('ganador', 'winner')}>👑</span>}</div>
              <div className="mt-0.5 truncate font-mono text-[11px] leading-tight text-ink-3">{agent.model}{roleLabel ? ` · ${pick(roleLabel, 'label')}` : ''}</div>
            </div>
            <button type="button" onClick={close} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink shadow-sm transition hover:bg-ink hover:text-paper" style={{ position: 'absolute', right: 12, top: 12, border: `1.5px solid ${color}` }} title={T('Cerrar', 'Close')} aria-label={T('Cerrar', 'Close')}><X size={18} strokeWidth={3} /></button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto scroll-thin px-4 sm:px-5 pb-10">
          {section(T('En este debate', 'In this debate'))}
          {stats.turns === 0 ? <div className="text-[12px] text-ink-4">{T('Todavía no habló.', 'Has not spoken yet.')}</div> : (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                {stat(T('Turnos', 'Turns'), `${stats.turns}`, `${T('llamado', 'called')} ${stats.calledBy}×`)}
                {stat(T('Latencia', 'Latency'), fmtMs(stats.latency), stats.ttft != null ? `1er token ${fmtMs(stats.ttft)} · ${stats.tps} t/s` : `${stats.tps} t/s`)}
                {stat(T('Confianza', 'Confidence'), stats.confAvg != null ? `${stats.confAvg}` : '—', T('promedio 0–100', 'average 0–100'))}
                {stat(T('Escribió', 'Wrote'), `${fmtK(stats.out)} tok`, `${T('leyó', 'read')} ${fmtK(stats.inp)} tok`)}
                {stat(T('Costo', 'Cost'), fmtUsd(stats.cost), T('de este rol', 'for this role'))}
                {stat(T('Votos', 'Votes'), `${stats.votesFor}`, stats.voted ? `${T('votó a', 'voted for')} ${nameOf(stats.voted.target ?? undefined)}` : T('recibidos', 'received'))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {stats.byStance.filter((x) => x.n).map(({ s, n }) => (
                  <span key={s} className="rounded-md px-2 py-0.5 text-[11px] font-semibold" style={{ background: `${STANCE[s].color}1F`, color: STANCE[s].color }}>{n}× {s === 'agree' ? T('acuerdo', 'agree') : s === 'disagree' ? T('desacuerdo', 'disagree') : s === 'propose' ? T('propone', 'proposes') : 'neutral'}</span>
                ))}
              </div>
              <div className="mt-2 space-y-0.5 text-[12px] text-ink-2">
                {stats.answeredMost && <div>{T('Le respondió más a', 'Answered most')}: <b>{nameOf(stats.answeredMost[0])}</b> ({stats.answeredMost[1]}×)</div>}
                {stats.passedMost && <div>{T('Le pasó la palabra más a', 'Passed the floor most to')}: <b>{nameOf(stats.passedMost[0])}</b> ({stats.passedMost[1]}×)</div>}
              </div>
            </>
          )}

          {section(T('Configuración del rol', 'Role setup'))}
          {running && <div className="mb-2 rounded-lg border border-gold/40 bg-gold/10 px-2.5 py-1.5 text-[11.5px] text-ink-2">{T('Debate en curso: ahora podés cambiar el modelo y las skills; nombre, rol y prompt se editan cuando termine.', 'Debate running: you can change the model and skills now; name, role and prompt are editable once it ends.')}</div>}
          <div className="space-y-2">
            <label className="block"><span className="text-[10px] uppercase tracking-widest text-ink-3">{T('Nombre', 'Name')}</span>
              <input className={`${input} mt-0.5`} style={{ borderColor: `color-mix(in srgb, ${theme.accent} 53%, transparent)` }} value={draft.name} disabled={running} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="text-[10px] uppercase tracking-widest text-ink-3">{T('Empresa', 'Company')}</span>
                <select className={`${input} mt-0.5`} style={{ borderColor: `color-mix(in srgb, ${theme.accent} 53%, transparent)` }} value={draft.provider} onChange={(e) => { if (ai.ask(e.target.value, (np) => setDraft({ ...draft, provider: np.id, model: np.default_model, wanted_provider: undefined }))) return; const np = providers.find((x) => x.id === e.target.value); if (np) setDraft({ ...draft, provider: np.id, model: np.default_model, wanted_provider: undefined }) }}>
                  {providers.filter((x) => x.configured || x.id === 'mock').map((x) => <option key={x.id} value={x.id}>{x.id === 'mock' ? T('Simulado (sin API)', 'Simulated (no API)') : x.label}</option>)}
                  {ai.options}
                </select>
                {ai.dialog}</label>
              <label className="block"><span className="text-[10px] uppercase tracking-widest text-ink-3">{T('Modelo', 'Model')}</span>
                <div className="mt-0.5"><ModelSelect provider={draft.provider} value={draft.model} onChange={(m) => setDraft({ ...draft, model: m })} enabled={!!providers.find((x) => x.id === draft.provider)?.configured} className="text-[12px] py-1.5" /></div></label>
            </div>
            <label className="block"><span className="text-[10px] uppercase tracking-widest text-ink-3">{T('Rol', 'Role')}</span>
              <select className={`${input} mt-0.5`} style={{ borderColor: `color-mix(in srgb, ${theme.accent} 53%, transparent)` }} value={draft.role ?? 'custom'} disabled={running} onChange={(e) => { const r = roles?.roles.find((x) => x.id === e.target.value); setDraft({ ...draft, role: e.target.value, persona: r && r.id !== 'custom' && !draft.persona ? pick(r, 'persona') : draft.persona }) }}>
                {(roles?.groups ?? []).map((g, gi) => (
                  <optgroup key={g} label={lang === 'en' ? roles?.groups_en?.[gi] ?? g : g}>
                    {roles?.roles.filter((r) => r.group === g).map((r) => <option key={r.id} value={r.id}>{pick(r, 'label')}</option>)}
                  </optgroup>
                ))}
              </select></label>
            <div><span className="text-[10px] uppercase tracking-widest text-ink-3">{T('Prompt / personalidad', 'Prompt / personality')}</span>
              <div className={running ? 'pointer-events-none opacity-60' : ''}><PersonaField className="mt-0.5" value={draft.persona} onChange={(v) => setDraft({ ...draft, persona: v })} roleLabel={draft.name} inputStyle={{ borderColor: `color-mix(in srgb, ${theme.accent} 53%, transparent)` }} /></div></div>
            <div><span className="text-[10px] uppercase tracking-widest text-ink-3">Skills</span>
              <div className="mt-0.5 rounded-lg border bg-surface p-1" style={{ borderColor: `color-mix(in srgb, ${theme.accent} 53%, transparent)` }}><SkillPicker value={draft.skills ?? []} onChange={(ids) => setDraft({ ...draft, skills: ids })} /></div></div>
          </div>
        </div>

        <div className="relative flex shrink-0 items-center gap-2 border-t bg-surface/70 px-5 py-3.5 backdrop-blur-sm" style={{ borderColor: `color-mix(in srgb, ${theme.accent} 33%, transparent)` }}>
          <button type="button" onClick={save} disabled={!dirty || saving} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40" style={{ background: theme.accent }}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {T('Guardar', 'Save')}</button>
          <button type="button" onClick={() => setDraft({ ...agent, skills: [...(agent.skills ?? [])] })} disabled={!dirty || saving} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] disabled:opacity-40">{T('Descartar', 'Discard')}</button>
          <span className="ml-auto text-[10.5px] text-ink-4">{T('Aplica a la próxima ronda, build o repetición.', 'Applies to the next round, build or rerun.')}</span>
        </div>
      </motion.aside>
    </AnimatePresence>,
    document.body,
  )
}

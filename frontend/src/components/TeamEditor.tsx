import { Check, Loader2, Plus, Trash2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { brandTheme } from '../lib/brand'
import { pick, tr, useLang, useT } from '../lib/i18n'
import type { AgentConfig, Provider, Role } from '../types'
import ModelSelect from './ModelSelect'
import PersonaField from './PersonaField'
import ProviderLogo from './ProviderLogo'
import SkillPicker from './SkillPicker'
import { toast } from './Toast'
import { useAiConnect } from './AiConnect'

let providersCache: Provider[] | null = null
let rolesCache: { groups: string[]; groups_en?: string[]; roles: Role[] } | null = null

/**
 * Edit a saved project's team from the dashboard: add/remove roles, change the model, the persona (the role's prompt)
 * and the skills. Saved with "Guardar equipo"; the next council round, build or review uses the new team.
 */
export default function TeamEditor({ sessionId, onSaved }: { sessionId: string; onSaved?: (agents: AgentConfig[]) => void }) {
  const T = useT()
  const lang = useLang()
  const [agents, setAgents] = useState<AgentConfig[] | null>(null)
  const [providers, setProviders] = useState<Provider[]>(providersCache ?? [])
  const ai = useAiConnect(providers, (np) => setProviders((ps) => (providersCache = ps.map((x) => (x.id === np.id ? np : x)))))
  const [roles, setRoles] = useState(rolesCache)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api.session(sessionId).then((s) => setAgents((s.config?.agents ?? []).map((a) => ({ ...a })))).catch((e) => toast.error(tr('No se pudo cargar el equipo', 'Could not load the team'), (e as Error).message))
    if (!providersCache) api.providers().then((p) => { providersCache = p; setProviders(p) }).catch(() => {})
    if (!rolesCache) api.roles().then((r) => { rolesCache = r; setRoles(r) }).catch(() => {})
  }, [sessionId])

  const update = (i: number, patch: Partial<AgentConfig>) => { setAgents((as) => (as ? as.map((a, j) => (j === i ? { ...a, ...patch } : a)) : as)); setDirty(true) }
  const remove = (i: number) => { setAgents((as) => (as ? as.filter((_, j) => j !== i) : as)); setDirty(true) }
  const add = () => {
    if (!agents || agents.length >= 8) return
    const p = providers.find((x) => x.configured && x.id !== 'mock') ?? providers.find((x) => x.configured) ?? providers[0]
    const used = new Set(agents.map((a) => a.id))
    let n = agents.length + 1
    while (used.has(`agente-${n}`)) n++
    setAgents([...agents, { id: `agente-${n}`, name: `${tr('Agente', 'Agent')} ${n}`, provider: p?.id ?? 'mock', model: p?.default_model ?? 'mock-1', persona: '', role: 'custom', skills: [] }])
    setDirty(true)
  }
  const save = async () => {
    if (!agents) return
    setSaving(true)
    try {
      const r = await api.updateTeam(sessionId, agents)
      setAgents(r.agents)
      setDirty(false)
      onSaved?.(r.agents)
      toast.ok(tr('Equipo guardado', 'Team saved'), tr('La próxima ronda del consejo, construcción o revisión usa este equipo.', 'The next council round, build or review uses this team.'))
    } catch (e) {
      toast.error(tr('No se pudo guardar el equipo', 'Could not save the team'), (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!agents) return <div className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 size={13} className="animate-spin" /> {T('cargando equipo…', 'loading team…')}</div>
  const input = 'w-full rounded-lg border border-line bg-surface px-2 py-1 text-[12.5px] outline-none focus:border-accent'
  return (
    <div className="rounded-xl border border-line bg-surface/70 p-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-ink-3">
        <Users size={13} /> {T('Equipo del proyecto', 'Project team')} ({agents.length}/8)
        <button type="button" onClick={add} disabled={agents.length >= 8} className="ml-auto flex items-center gap-1 normal-case tracking-normal text-accent disabled:opacity-30"><Plus size={13} /> {T('agregar rol', 'add role')}</button>
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        {agents.map((a, i) => {
          const p = providers.find((x) => x.id === a.provider)
          const theme = brandTheme(a.wanted_provider ?? a.provider)
          return (
            <div key={`${a.id}-${i}`} className="rounded-lg border p-2.5" style={{ background: theme.bg, borderColor: theme.border }}>
              <div className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5">
                <ProviderLogo provider={a.wanted_provider ?? a.provider} size={20} />
                <input className={input} value={a.name} onChange={(e) => update(i, { name: e.target.value })} placeholder={T('nombre', 'name')} />
                <select className={input} value={a.provider} onChange={(e) => { if (ai.ask(e.target.value, (np) => update(i, { provider: np.id, model: np.default_model, wanted_provider: undefined }))) return; const np = providers.find((x) => x.id === e.target.value); if (np) update(i, { provider: np.id, model: np.default_model, wanted_provider: undefined }) }}>
                  {providers.filter((x) => x.configured || x.id === 'mock').map((x) => <option key={x.id} value={x.id}>{x.id === 'mock' ? T('Simulado (sin API)', 'Simulated (no API)') : x.label}</option>)}
                  {ai.options}
                </select>
                {ai.dialog}
                <button type="button" onClick={() => remove(i)} disabled={agents.length <= 2} className="text-ink-3 hover:text-danger disabled:opacity-20" title={T('Quitar rol', 'Remove role')}><Trash2 size={14} /></button>
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <select className={input} value={a.role ?? 'custom'} onChange={(e) => { const r = roles?.roles.find((x) => x.id === e.target.value); update(i, { role: e.target.value, persona: r && r.id !== 'custom' && !a.persona ? pick(r, 'persona') : a.persona }) }}>
                  {(roles?.groups ?? []).map((g, gi) => (
                    <optgroup key={g} label={lang === 'en' ? roles?.groups_en?.[gi] ?? g : g}>
                      {roles?.roles.filter((r) => r.group === g).map((r) => <option key={r.id} value={r.id}>{pick(r, 'label')}</option>)}
                    </optgroup>
                  ))}
                </select>
                <ModelSelect provider={a.provider} value={a.model} onChange={(m) => update(i, { model: m })} enabled={!!p?.configured} className="text-[11px] py-1" />
              </div>
              <PersonaField className="mt-1.5" value={a.persona} onChange={(v) => update(i, { persona: v })} placeholder={T('personalidad / prompt del rol (cómo piensa, qué prioriza)', 'personality / role prompt (how it thinks, what it prioritises)')} roleLabel={a.name} />
              <div className="mt-1.5"><SkillPicker value={a.skills ?? []} onChange={(ids) => update(i, { skills: ids })} /></div>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={save} disabled={!dirty || saving} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40">{saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {T('Guardar equipo', 'Save team')}</button>
        <span className="text-[11px] text-ink-4">{T('Aplica a la próxima ronda del consejo, construcción o revisión; el debate ya grabado no cambia.', 'Applies to the next council round, build or review; the recorded debate does not change.')}</span>
      </div>
    </div>
  )
}

import { motion } from 'framer-motion'
import { AlertTriangle, ArrowUpDown, Check, Clock, Loader2, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { GLYPH, brandTheme } from '../lib/brand'
import { tr, useT } from '../lib/i18n'
import { agentMap, useArena } from '../store'
import type { Provider } from '../types'
import ModelSelect from './ModelSelect'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'
import SkillPicker from './SkillPicker'
import { useAiConnect } from './AiConnect'

function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([])
  useEffect(() => {
    api.providers().then(setProviders).catch(() => {})
  }, [])
  return [providers, setProviders] as const
}

/** One row: switch a role to another provider/model (promote or demote). */
function AgentSwitcher({ agentId, onDone, autoFocus }: { agentId: string; onDone?: () => void; autoFocus?: boolean }) {
  const T = useT()
  const sessionId = useArena((s) => s.sessionId)!
  const config = useArena((s) => s.config)
  const [all, setAll] = useProviders()
  const providers = all.filter((p) => p.configured)
  const ai = useAiConnect(all, (np) => setAll((ps) => ps.map((x) => (x.id === np.id ? np : x))), undefined)
  const a = agentMap(config)[agentId]
  const [provider, setProvider] = useState(a?.provider ?? '')
  const [model, setModel] = useState(a?.model ?? '')
  const [busy, setBusy] = useState(false)
  const [skBusy, setSkBusy] = useState(false)
  if (!a) return null
  const changed = provider !== a.provider || model !== a.model
  const apply = async () => {
    setBusy(true)
    try {
      await api.updateAgent(sessionId, agentId, provider, model)
      // reflect it here right away: on a finished/stopped session no WebSocket event comes back, and "Repetir" /
      // "volver a debatir" start from this config, so the switch must not silently revert to the old model
      const st = useArena.getState()
      if (st.config) st.set({ config: { ...st.config, agents: st.config.agents.map((x) => (x.id === agentId ? { ...x, provider, model, wanted_provider: undefined } : x)) } })
      toast.ok(`${a.name} ${tr('ahora usa', 'now uses')} ${model}`, provider !== a.provider ? `${tr('Cambió de', 'Switched from')} ${a.provider} ${tr('a', 'to')} ${provider}.` : undefined)
      onDone?.()
    } catch (e) {
      toast.error(tr('No se pudo cambiar el modelo', 'Could not change the model'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border p-3" style={{ background: brandTheme(a.wanted_provider ?? a.provider).bg, borderColor: brandTheme(a.wanted_provider ?? a.provider).border }}>
      <div className="flex items-center gap-2">
        <ProviderLogo provider={a.wanted_provider ?? a.provider} size={18} />
        <span className="font-semibold">{a.name}</span>
        <span className="font-mono text-[11px] text-ink-3 truncate">{a.model}</span>
      </div>
      <div className="mt-2"><SkillPicker value={a.skills ?? []} busy={skBusy} onChange={async (ids) => {
        setSkBusy(true)
        try {
          await api.setAgentSkills(sessionId, agentId, ids)
          toast.ok(`${a.name}: ${ids.length} skill${ids.length === 1 ? '' : 's'}`, tr('Aplican desde su próximo turno.', 'They apply from its next turn.'))
        } catch (e) {
          toast.error(tr('No se pudieron cargar las skills', 'Could not load the skills'), (e as Error).message)
        } finally {
          setSkBusy(false)
        }
      }} /></div>
      <div className="mt-2 grid grid-cols-[1fr_1.4fr_auto] gap-2 items-center">
        <select
          autoFocus={autoFocus}
          className="rounded-lg bg-surface border border-line px-2.5 py-1.5 text-sm"
          value={provider}
          onChange={(e) => {
            if (ai.ask(e.target.value, (np) => { setProvider(np.id); setModel(np.default_model) })) return
            const p = providers.find((x) => x.id === e.target.value)
            if (!p) return
            setProvider(p.id)
            setModel(p.default_model)
          }}
        >
          {providers.map((p) => <option key={p.id} value={p.id}>{GLYPH[p.id]} {p.label}</option>)}
          {!all.some((p) => p.id === provider) && <option value={provider}>{provider}</option>}
          {ai.options}
        </select>
        {ai.dialog}
        <ModelSelect provider={provider} value={model} onChange={setModel} className="text-xs" />
        <button disabled={!changed || busy} onClick={apply} className="flex items-center gap-1 rounded-lg bg-accent text-white px-3 py-1.5 text-sm font-medium disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {T('Aplicar', 'Apply')}
        </button>
      </div>
    </div>
  )
}

/** Blocking alert when a provider is down: wait & retry, switch model, or stop. */
export function PauseModal() {
  const T = useT()
  const pause = useArena((s) => s.pause)
  const sessionId = useArena((s) => s.sessionId)
  const config = useArena((s) => s.config)
  const [mode, setMode] = useState<'choose' | 'switch'>('choose')
  const [busy, setBusy] = useState(false)
  if (!pause || !sessionId) return null
  const a = agentMap(config)[pause.agent_id]
  const providerLabel = useArena.getState().providerLabels[pause.provider] ?? pause.provider
  const retry = async () => {
    setBusy(true)
    await api.resumeSession(sessionId).catch((e) => toast.error(tr('No se pudo reanudar', 'Could not resume'), (e as Error).message))
    setBusy(false)
  }
  return (
    <div className="absolute inset-0 z-[80] bg-paper/80 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="panel rounded-3xl p-7 w-full max-w-xl border-2 border-gold/50">
        <div className="flex items-start gap-3">
          <span className="w-11 h-11 rounded-2xl bg-gold/15 text-gold flex items-center justify-center shrink-0"><AlertTriangle size={22} /></span>
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.3em] text-gold">{T('Debate en pausa', 'Debate paused')}</div>
            <h3 className="text-3xl mt-1">{pause.kind === 'account' ? T('El proveedor rechazó la llamada', 'The provider rejected the call') : T('Modelo no disponible', 'Model unavailable')}</h3>
            <p className="mt-2 text-[14px] text-ink-2">
              <b>{a?.name ?? pause.agent_id}</b> {T('usa', 'uses')} <span className="font-mono">{pause.model}</span> {T('de', 'from')} <b>{providerLabel}</b>{pause.kind === 'account' ? T(', y la cuenta de ese proveedor no puede atender el pedido:', ', and that provider’s account cannot serve the request:') : T(', y el proveedor no está respondiendo:', ', and the provider is not responding:')}
            </p>
            <div className="mt-2 rounded-xl bg-surface-2 border border-line px-3 py-2 font-mono text-[12px] text-ink-2 break-words">{pause.error}</div>
            {pause.kind === 'account' ? (
              <p className="mt-2 text-[13px] text-ink-2">
                {T('No es saturación ni un error de la app: es', 'It is not overload or an app error: it is')} <b>{T('tu cuenta en', 'your account at')} {providerLabel}</b> {T('(sin crédito, key inválida o modelo no habilitado). Cargá crédito o revisá la key en Configuración y reintentá, o pasá este rol a otro modelo. El equipo queda esperando; no se pierde nada de lo debatido.', '(no credit, invalid key or model not enabled). Top up credit or check the key in Settings and retry, or move this role to another model. The team waits; nothing debated so far is lost.')}
              </p>
            ) : (
              <p className="mt-2 text-[13px] text-ink-2">
                {T('Esto es un problema del lado del proveedor (saturación, mantenimiento o límite de uso),', 'This is a problem on the provider’s side (overload, maintenance or usage limit),')} <b>{T('no de tu configuración ni de la app', 'not your configuration or the app')}</b>. {T('Ya reintentamos', 'We already retried')} {pause.attempts} {pause.attempts === 1 ? T('vez', 'time') : T('veces', 'times')}. {T('El equipo queda esperando tu decisión; no se pierde nada de lo debatido.', 'The team is waiting for your decision; nothing debated so far is lost.')}
              </p>
            )}
          </div>
        </div>

        {mode === 'choose' ? (
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <button disabled={busy} onClick={retry} className="rounded-2xl border-2 border-accent bg-accent-soft px-4 py-3 text-left hover:brightness-95 disabled:opacity-50">
              <div className="flex items-center gap-2 font-semibold"><Clock size={16} className="text-accent" /> {pause.kind === 'account' ? T('Ya lo resolví, reintentar', 'I fixed it, retry') : T('Esperar y reintentar', 'Wait and retry')}</div>
              <div className="mt-1 text-[12.5px] text-ink-2">{pause.kind === 'account' ? T('Reintenta con el mismo modelo (después de cargar crédito o corregir la key).', 'Retries with the same model (after topping up credit or fixing the key).') : T('Reintenta 3 veces más (ya, 10 s, 20 s) con el mismo modelo. Si sigue caído, vuelve a avisar.', 'Retries 3 more times (now, 10 s, 20 s) with the same model. If it is still down, it warns you again.')}</div>
            </button>
            <button onClick={() => setMode('switch')} className="rounded-2xl border-2 border-line bg-surface px-4 py-3 text-left hover:bg-surface-2">
              <div className="flex items-center gap-2 font-semibold"><ArrowUpDown size={16} className="text-accent" /> {T('Cambiar de modelo', 'Change model')}</div>
              <div className="mt-1 text-[12.5px] text-ink-2">{T('Pasá este rol a otro proveedor o modelo y el debate sigue desde este mismo turno.', 'Move this role to another provider or model and the debate continues from this same turn.')}</div>
            </button>
          </div>
        ) : (
          <div className="mt-5">
            <AgentSwitcher agentId={pause.agent_id} autoFocus />
            <button onClick={() => setMode('choose')} className="mt-2 text-[12px] text-ink-3 hover:text-ink">{T('← volver', '← back')}</button>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button onClick={() => api.stop(sessionId)} className="flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-danger"><Square size={12} /> {T('Detener el debate', 'Stop the debate')}</button>
        </div>
      </motion.div>
    </div>
  )
}

/** Team panel: promote/demote any role to another model, any time during the run. */
export function TeamModal({ onClose }: { onClose: () => void }) {
  const T = useT()
  const config = useArena((s) => s.config)
  const source = useArena((s) => s.source)
  const status = useArena((s) => s.status)
  const live = source === 'live' && (status === 'running' || status === 'paused' || status === 'voting' || status === 'connecting')
  return (
    <div className="fixed inset-0 z-[70] bg-paper/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="panel rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto scroll-thin" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start">
          <div>
            <div className="text-xs uppercase tracking-widest text-ink-3">{T('Equipo', 'Team')}</div>
            <h3 className="text-3xl mt-1">{T('Modelos y skills por rol', 'Models and skills per role')}</h3>
            <p className="mt-1 text-[13px] text-ink-2">{T('Ascendé o descendé cualquier rol a otro modelo, y cargale skills (conocimiento) que aplica desde su próximo turno.', 'Promote or demote any role to another model, and load it with skills (knowledge) that apply from its next turn.')} {live ? T('Aplica desde su próximo turno; lo ya dicho se conserva.', 'Applies from its next turn; what was already said is kept.') : T('Esta sesión no está en curso: los cambios aplican si la reanudás o la usás como base.', 'This session is not running: changes apply if you resume it or use it as a base.')}</p>
          </div>
          <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="mt-4 space-y-2">
          {(config?.agents ?? []).map((a) => <AgentSwitcher key={a.id} agentId={a.id} />)}
        </div>
      </motion.div>
    </div>
  )
}

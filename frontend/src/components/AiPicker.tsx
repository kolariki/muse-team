import { useEffect, useState } from 'react'
import { api, type EngineStatus } from '../lib/api'
import { visibleEngines, visibleProviders } from '../lib/flags'
import { useT } from '../lib/i18n'
import type { Provider } from '../types'
import { useAiConnect } from './AiConnect'
import ModelSelect from './ModelSelect'

interface Props {
  provider: string
  model: string
  onChange: (provider: string, model: string) => void
  /** offers «Simulado» too (for trying the flow without spending) */
  simulated?: boolean
  onConnected?: (p: Provider) => void
  className?: string
}

/**
 * Any AI, any model: the subscriptions on this machine, the connected APIs and the companies still to connect (see useAiConnect).
 */
export default function AiPicker({ provider, model, onChange, simulated = false, onConnected, className = '' }: Props) {
  const T = useT()
  const [apis, setApis] = useState<Provider[]>([])
  const [engines, setEngines] = useState<EngineStatus[]>([])
  useEffect(() => {
    api.providers().then((ps) => setApis(visibleProviders(ps).filter((p) => simulated || p.id !== 'mock'))).catch(() => {})
    api.engines().then((es) => setEngines(visibleEngines(es).filter((e) => e.ok))).catch(() => {})
  }, [simulated])
  const ready = apis.filter((p) => p.configured)
  const ai = useAiConnect(apis, (np) => {
    setApis((ps) => ps.map((x) => (x.id === np.id ? np : x)))
    onConnected?.(np)
  })
  useEffect(() => {
    if (provider) return
    const first = ready.find((p) => p.id !== 'mock')
    if (first) onChange(first.id, first.default_model)
    else if (engines[0]) onChange(engines[0].id, 'default')
    else if (ready[0]) onChange(ready[0].id, ready[0].default_model)
  }, [provider, ready.length, engines.length])  // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id: string) => {
    if (ai.ask(id, (np) => onChange(np.id, np.default_model))) return
    if (engines.some((e) => e.id === id)) return onChange(id, 'default')
    const p = ready.find((x) => x.id === id)
    if (p) onChange(p.id, p.default_model)
  }
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <select data-ai-picker value={provider} onChange={(e) => pick(e.target.value)} className="min-w-0 max-w-[190px] truncate rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none">
          {!provider && <option value="">{T('elegir IA…', 'pick an AI…')}</option>}
          {engines.length > 0 && <optgroup label={T('Con tu suscripción', 'On your subscription')}>{engines.map((e) => <option key={e.id} value={e.id}>{e.label.split(' · ')[0]}</option>)}</optgroup>}
          {ready.length > 0 && <optgroup label={T('Por API', 'Via API')}>{ready.map((p) => <option key={p.id} value={p.id}>{p.id === 'mock' ? T('Simulado (sin API)', 'Simulated (no API)') : p.label.split(' · ')[0]}</option>)}</optgroup>}
          {ai.options}
        </select>
        {provider && <div className="min-w-[150px] max-w-[220px] flex-1"><ModelSelect provider={provider} value={model} onChange={(m) => onChange(provider, m)} className="py-1 text-[11px]" /></div>}
      </div>
      {ai.dialog}
    </div>
  )
}

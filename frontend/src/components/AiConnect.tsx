import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { visibleProviders } from '../lib/flags'
import { useT } from '../lib/i18n'
import type { Provider } from '../types'
import InlineKey from './InlineKey'
import { invalidateModels } from './ModelSelect'
import ProviderLogo from './ProviderLogo'

/**
 * Every AI picker offers all the companies: the ones not connected yet go in a «Sin conectar» group of the same list, and
 * choosing one asks for its key right there and leaves it selected. Ollama stays out: it has no key, it is set up in Settings.
 */
export function useAiConnect(providers: Provider[], onConnected?: (p: Provider) => void, current?: string) {
  const T = useT()
  const [asking, setAsking] = useState<{ provider: Provider; then: (p: Provider) => void } | null>(null)
  const missing = visibleProviders(providers).filter((p) => !p.configured && p.id !== 'mock' && (p.id !== 'ollama' || p.id === current))
  const ask = (id: string, then: (p: Provider) => void) => {
    const provider = missing.find((p) => p.id === id)
    if (!provider) return false
    setAsking({ provider, then })
    return true
  }
  const options = missing.length > 0 && (
    <optgroup label={T('Sin conectar', 'Not connected')}>
      {missing.map((p) => <option key={p.id} value={p.id}>{p.label.split(' · ')[0]} · {T('conectar', 'connect')}</option>)}
    </optgroup>
  )
  const dialog = asking && (
    <ConnectDialog
      provider={asking.provider}
      onClose={() => setAsking(null)}
      onConnected={(np) => {
        invalidateModels(np.id)
        onConnected?.(np)
        asking.then(np)
        setAsking(null)
      }}
    />
  )
  return { ask, options, dialog }
}

function ConnectDialog({ provider, onClose, onConnected }: { provider: Provider; onClose: () => void; onConnected: (p: Provider) => void }) {
  const T = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const name = provider.label.split(' · ')[0]
  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]" onClick={(e) => { e.stopPropagation(); onClose() }}>
      <div data-ai-connect role="dialog" aria-label={T(`Conectar ${name}`, `Connect ${name}`)} onClick={(e) => e.stopPropagation()} className="w-full max-w-[460px] rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <div className="flex items-center gap-2.5">
          <ProviderLogo provider={provider.id} size={22} />
          <h2 className="flex-1 text-[15px] font-semibold text-ink">{T(`Conectar ${name}`, `Connect ${name}`)}</h2>
          <button type="button" onClick={onClose} title={T('Cerrar', 'Close')} className="rounded-lg border border-line p-1.5 text-ink-3 hover:text-ink"><X size={13} /></button>
        </div>
        <p className="mt-1.5 text-[12.5px] text-ink-3">{T('Pegá tu API key. La probamos y queda guardada en tu cuenta, lista para usar.', 'Paste your API key. We test it and keep it on your account, ready to use.')}</p>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2"><InlineKey provider={provider} onConnected={onConnected} trash={null} /></div>
      </div>
    </div>,
    document.body,
  )
}

import { Check, Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import type { Provider } from '../types'
import { toast } from './Toast'

/** Paste an API key, test it and keep it on the user's account, right where it was missing. */
export default function InlineKey({ provider, onConnected, trash }: { provider: Provider; onConnected: (p: Provider) => void; trash: ReactNode }) {
  const T = useT()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => {
    const k = key.trim()
    if (!k) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.testKey(provider.id, k)
      if (!r.ok) throw new Error(r.error || tr('La key no respondió', 'The key did not respond'))
      await api.saveProvider(provider.id, { api_key: k })
      const fresh = (await api.providers()).find((x) => x.id === provider.id)
      onConnected(fresh ?? { ...provider, configured: true })
      toast.ok(`${provider.label} ${tr('conectado', 'connected')}`, `${r.models?.length ?? 0} ${tr('modelos disponibles. La key queda guardada en tu cuenta.', 'models available. The key is saved in your account.')}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="min-w-0">
        <input
          type="password"
          autoComplete="off"
          className={`w-full rounded-lg bg-surface border px-3 py-2 text-xs font-mono outline-none focus:border-accent transition ${err ? 'border-danger' : 'border-gold/60'}`}
          value={key}
          onChange={(e) => { setKey(e.target.value); setErr(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
          placeholder={`API key ${T('de', 'for')} ${provider.label}`}
          title={err ?? T(`Pegá tu API key de ${provider.label} y tocá Probar`, `Paste your ${provider.label} API key and hit Test`)}
        />
        {err && <div className="mt-0.5 text-[10.5px] text-danger truncate" title={err}>{err}</div>}
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={go} disabled={busy || !key.trim()} className="flex items-center gap-1 rounded-lg bg-accent text-white px-2.5 py-1.5 text-xs font-semibold disabled:opacity-40" title={T('Probar la key y guardarla', 'Test the key and save it')}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {T('Probar', 'Test')}
        </button>
        {trash}
      </div>
    </>
  )
}

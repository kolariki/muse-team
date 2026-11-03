import { ChevronDown, Loader2, Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'

/** One request per provider per page load; invalidated when a key changes. */
const cache = new Map<string, Promise<{ models: string[]; error?: string }>>()

export function invalidateModels(provider?: string) {
  if (provider) cache.delete(provider)
  else cache.clear()
}

function load(provider: string) {
  if (!cache.has(provider)) cache.set(provider, api.models(provider).catch((e) => ({ models: [], error: (e as Error).message })))
  return cache.get(provider)!
}

interface Props {
  provider: string
  value: string
  onChange: (model: string) => void
  /** false → provider has no key: show the current value, disabled */
  enabled?: boolean
  className?: string
}

/** Dropdown with the provider's real model list (fetched live with the user's key). */
export default function ModelSelect({ provider, value, onChange, enabled = true, className = '' }: Props) {
  const T = useT()
  const [models, setModels] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled || !provider) return
    let alive = true
    setModels(null)
    setError(null)
    load(provider).then((r) => {
      if (!alive) return
      setModels(r.models)
      setError(r.error ?? null)
    })
    return () => {
      alive = false
    }
  }, [provider, enabled, nonce])

  const base = `w-full rounded-lg bg-surface border border-line px-3 py-2 text-sm font-mono outline-none focus:border-accent transition ${className}`
  const loading = enabled && !!provider && models === null

  if (custom) {
    return (
      <div className="flex gap-1.5">
        <input className={base} value={value} onChange={(e) => onChange(e.target.value)} placeholder={T('id exacto del modelo', 'exact model id')} autoFocus />
        <button type="button" title={T('Volver a la lista', 'Back to the list')} onClick={() => setCustom(false)} className="shrink-0 rounded-lg border border-line px-2 text-ink-3 hover:text-accent">
          <ChevronDown size={15} />
        </button>
      </div>
    )
  }

  const list = models ?? []
  const options = value && !list.includes(value) ? [value, ...list] : list

  return (
    <div className="flex gap-1.5">
      <div className="relative flex-1 min-w-0">
        <select
          className={`${base} appearance-none pr-8 disabled:opacity-60 truncate`}
          value={value}
          disabled={!enabled || loading}
          onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}
          title={error ?? value}
        >
          {!provider && <option value={value}>{T('— sin proveedor —', '— no provider —')}</option>}
          {provider && !enabled && <option value={value}>{value} {T('(sin key)', '(no key)')}</option>}
          {enabled && loading && <option value={value}>{value} {T('· cargando modelos…', '· loading models…')}</option>}
          {enabled &&
            !loading &&
            options.map((m) => (
              <option key={m} value={m}>
                {m === 'default' ? T('modelo por defecto', 'default model') : m}
                {list.length && !list.includes(m) ? T(' (no está en la lista)', ' (not in the list)') : ''}
              </option>
            ))}
          {enabled && !loading && <option value="__custom">{T('✎ escribir otro id…', '✎ type another id…')}</option>}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <ChevronDown size={14} />}
        </span>
      </div>
      {enabled && !loading && (error || list.length === 0) && (
        <button
          type="button"
          title={error ? `${T('No se pudo listar:', 'Could not list:')} ${error}. ${T('Reintentar', 'Retry')}` : T('Reintentar', 'Retry')}
          onClick={() => {
            invalidateModels(provider)
            setNonce((n) => n + 1)
          }}
          className="shrink-0 rounded-lg border border-line px-2 text-ink-3 hover:text-accent"
        >
          <RefreshCw size={14} />
        </button>
      )}
      {!enabled && (
        <button type="button" title={T('Escribir id', 'Type an id')} onClick={() => setCustom(true)} className="shrink-0 rounded-lg border border-line px-2 text-ink-3 hover:text-accent">
          <Pencil size={14} />
        </button>
      )}
    </div>
  )
}

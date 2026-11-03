import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, Copy, ExternalLink, FlaskConical, HardHat, Loader2, RefreshCw, Save, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBuild } from '../buildStore'
import { api, type ServiceGuideData, type ServicesInfo } from '../lib/api'
import { useLang, useT } from '../lib/i18n'

type Group = ServicesInfo['groups'][number]

// guides already fetched in this tab: reopening one is instant (the server keeps them in its database too)
const guideCache = new Map<string, ServiceGuideData>()
const guideKey = (g: Group, lang: string) => `${g.service}|${g.vars.map((v) => v.var).sort().join(',')}|${lang}`

/** One value to copy (an address, a host, an event name): bold, with a one-click copy button next to it. */
function CopyValue({ text }: { text: string }) {
  const T = useT()
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400) } catch { /* the user can still select it */ }
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-accent/30 bg-accent-soft/50 py-0.5 pl-1.5 pr-0.5 align-baseline">
      <b className="break-all font-mono text-[12.5px] text-ink">{text}</b>
      <button type="button" onClick={copy} title={T('Copiar', 'Copy')} aria-label={T('Copiar', 'Copy')} className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition ${done ? 'text-ok' : 'text-accent hover:bg-accent/10'}`}>
        {done ? <Check size={12} strokeWidth={3} /> : <Copy size={12} />}
      </button>
    </span>
  )
}

/** A tutorial step: «menus and buttons» in bold; addresses and `values to paste` in bold with a copy button. */
function GuideText({ text }: { text: string }) {
  const parts = text.split(/(«[^»]+»|`[^`]+`|https?:\/\/[^\s,;)»]+)/g)
  return (
    <>
      {parts.map((p, k) => {
        if (!p) return null
        if (p.startsWith('«')) return <b key={k} className="font-semibold text-ink">{p.slice(1, -1)}</b>
        if (p.startsWith('`')) return <CopyValue key={k} text={p.slice(1, -1)} />
        if (/^https?:\/\//.test(p)) {
          const url = p.replace(/[.:]+$/, '')
          return <span key={k}><CopyValue text={url} />{p.slice(url.length)}</span>
        }
        return <span key={k}>{p}</span>
      })}
    </>
  )
}

/**
 * "How do I get this?": a guided walkthrough for one external service. The steps come from a model (cached per
 * build); the last step is always the form where the user pastes the values, so the whole journey ends here.
 */
export default function ServiceGuide({ group, sessionId, buildId, onClose, onSaved }: { group: Group; sessionId: string; buildId: string; onClose: () => void; onSaved: () => void }) {
  const T = useT()
  const lang = useLang()
  const [data, setData] = useState<ServiceGuideData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [i, setI] = useState(0)
  const [dir, setDir] = useState(1)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const load = (refresh = false) => {
    const k = guideKey(group, lang)
    const hit = refresh ? null : guideCache.get(k)
    if (hit) { setData(hit); return }
    setData(null)
    setError(null)
    api.serviceGuide(sessionId, buildId, group.service, lang, refresh).then((d) => { guideCache.set(k, d); setData(d) }).catch((e) => setError((e as Error).message))
  }
  useEffect(() => { load() }, [group.service, lang]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const steps = data?.steps ?? []
  const total = steps.length + 1 // + the final "paste it here"
  const last = i === steps.length
  const go = (n: number) => { setDir(n > i ? 1 : -1); setI(Math.max(0, Math.min(total - 1, n))) }
  const filled = group.vars.filter((v) => (values[v.var] ?? '').trim() || v.configured).length

  const save = async () => {
    const vals = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))
    if (!Object.keys(vals).length) return
    setSaving(true)
    setError(null)
    try {
      await api.saveServices(sessionId, buildId, vals)
      setDone(true)
      onSaved()
      setTimeout(onClose, 900)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[200] flex items-center justify-center bg-ink/40 p-6 backdrop-blur-[2px]" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(30,38,34,.55)]"
        style={{ maxHeight: 'calc(100vh - 48px)' }}
      >
        {/* header */}
        <div className="flex items-start gap-4 border-b border-line px-4 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Cómo conseguirlo', 'How to get it')}</div>
            <h3 className="mt-1 truncate text-2xl">{group.service}</h3>
            {data?.intro && <p className="mt-1 text-[13px] leading-snug text-ink-2">{data.intro}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data?.cost && <span className="inline-flex rounded-lg border border-line bg-paper px-2.5 py-0.5 text-[11px] leading-snug text-ink-2">{T('Costo', 'Cost')}: {data.cost}</span>}
              {data?.time && <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-0.5 text-[11px] text-ink-2"><Clock3 size={11} /> {data.time}</span>}
            </div>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={18} strokeWidth={2.5} /></button>
        </div>

        {/* progress */}
        {data && (
          <div className="flex items-center gap-1.5 px-4 pt-4 sm:px-6">
            {Array.from({ length: total }).map((_, k) => (
              <button key={k} onClick={() => go(k)} className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-label={`${T('Paso', 'Step')} ${k + 1}`}>
                <motion.span className="block h-full bg-accent" initial={false} animate={{ scaleX: k <= i ? 1 : 0 }} style={{ transformOrigin: 'left' }} transition={{ type: 'spring', stiffness: 260, damping: 28 }} />
              </button>
            ))}
            <span className="ml-2 shrink-0 font-mono text-[11px] text-ink-3">{i + 1}/{total}</span>
          </div>
        )}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-4 sm:px-6 py-5">
          {!data && !error && (
            <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-6 text-sm text-ink-2">
              <Loader2 size={18} className="animate-spin text-accent" /> {T('Un modelo está escribiendo la guía para este servicio…', 'A model is writing the guide for this service…')}
            </div>
          )}
          {error && !data && <div className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}
          {data && (
            <AnimatePresence mode="wait" initial={false} custom={dir}>
              <motion.div key={i} custom={dir} initial={{ opacity: 0, x: 28 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -28 * dir }} transition={{ duration: 0.22, ease: 'easeOut' }}>
                {!last ? (
                  <div className="flex gap-4">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-[15px] font-bold text-white shadow-sm">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-lg font-semibold leading-snug">{steps[i].title}</h4>
                      <p className="mt-2 text-[14px] leading-loose text-ink-2"><GuideText text={steps[i].detail} /></p>
                      {steps[i].url && (
                        <a href={steps[i].url!} target="_blank" rel="noreferrer" className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-4 text-sm font-medium text-accent shadow-sm transition hover:bg-accent/5">
                          <ExternalLink size={14} /> {T('Abrir la página de este paso', 'Open this step’s page')}
                        </a>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-4">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ok text-white shadow-sm"><Check size={18} strokeWidth={3} /></span>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-lg font-semibold leading-snug">{T('Pegá acá lo que conseguiste', 'Paste here what you got')}</h4>
                      <p className="mt-1 text-[13px] text-ink-2">{T('Se guarda cifrado y va al deploy como variable de entorno. Nunca se escribe en el código.', 'Stored encrypted and sent to the deploy as an environment variable. Never written into the code.')}</p>
                      <div className="mt-4 space-y-3">
                        {group.vars.map((v) => (
                          <label key={v.var} className="block">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[12px] font-semibold">{v.var}</span>
                              {v.configured && <span className="inline-flex items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[10.5px] font-medium text-ok"><CheckCircle2 size={11} /> {T('guardada', 'saved')}</span>}
                              {!v.required && <span className="text-[10.5px] text-ink-4">{T('opcional', 'optional')}</span>}
                            </div>
                            {(data.looks?.[v.var] || v.note) && <div className="mt-0.5 text-[11.5px] text-ink-3">{data.looks?.[v.var] ? <>{T('Se ve así', 'Looks like')}: <span className="font-mono">{data.looks[v.var]}</span></> : v.note}</div>}
                            <input
                              type={v.secret ? 'password' : 'text'}
                              autoComplete="off"
                              autoFocus={v === group.vars[0]}
                              placeholder={v.configured ? T('•••••••• (reemplazar)', '•••••••• (replace)') : v.example || (v.required ? T('requerida', 'required') : T('opcional', 'optional'))}
                              value={values[v.var] ?? ''}
                              onChange={(e) => setValues({ ...values, [v.var]: e.target.value })}
                              className="mt-1.5 w-full rounded-xl border border-line bg-paper px-3 py-2.5 font-mono text-[13px] shadow-sm outline-none transition focus:border-accent"
                            />
                          </label>
                        ))}
                      </div>
                      {data.test && (
                        <div className="mt-4 flex gap-2 rounded-xl border border-accent/30 bg-accent-soft/40 px-3 py-2.5 text-[12.5px] leading-snug text-ink-2">
                          <FlaskConical size={15} className="mt-0.5 shrink-0 text-accent" /> <span><b className="text-ink">{T('Para probar sin riesgo', 'To try it safely')}:</b> <GuideText text={data.test} /></span>
                        </div>
                      )}
                      {error && <div className="mt-3 text-sm text-danger">{error}</div>}
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-paper px-4 py-3 sm:px-6 sm:py-4">
          <button onClick={() => { onClose(); useBuild.getState().set({ fdeOrder: { pkg: 'service_setup', notes: `${T('Configurar', 'Set up')} ${group.service} (${group.vars.map((v) => v.var).join(', ')})` } }) }} className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border border-gold/50 bg-gold/10 px-4 text-[12.5px] font-semibold text-ink shadow-sm transition hover:bg-gold/20" title={T('Un experto de Muse Team lo configura por vos', 'A Muse Team expert sets it up for you')}>
            <HardHat size={14} className="text-gold" /> {T('Que lo haga un experto · USD 49', 'Have an expert do it · USD 49')}
          </button>
          {data && !data.curated && (
            <button onClick={() => load(true)} className="order-last flex basis-full items-center gap-1.5 text-[12px] text-ink-3 sm:order-none sm:basis-auto transition hover:text-ink" title={T('Volver a escribir la guía', 'Rewrite the guide')}>
              <RefreshCw size={12} /> {data.generated ? data.model : T('guía genérica (sin API key para escribirla)', 'generic guide (no API key to write it)')}
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {data && i > 0 && <button onClick={() => go(i - 1)} className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm shadow-sm transition hover:bg-accent-soft hover:border-accent hover:text-accent"><ArrowLeft size={15} /> {T('Anterior', 'Back')}</button>}
            {data && !last && <button onClick={() => go(i + 1)} className="flex h-10 items-center gap-1.5 rounded-full bg-accent px-5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110">{i === steps.length - 1 ? T('Ya lo tengo', 'I have it') : T('Siguiente', 'Next')} <ArrowRight size={15} /></button>}
            {data && last && (
              <button onClick={save} disabled={saving || done || !Object.values(values).some((v) => v.trim())} className={`flex h-10 items-center gap-1.5 rounded-full px-5 text-sm font-semibold text-white shadow-sm transition disabled:opacity-40 ${done ? 'bg-ok' : 'bg-accent hover:brightness-110'}`}>
                {done ? <><Check size={15} strokeWidth={3} /> {T('Guardado', 'Saved')}</> : saving ? <Loader2 size={15} className="animate-spin" /> : <><Save size={15} /> {T('Guardar', 'Save')} {filled ? `(${filled}/${group.vars.length})` : ''}</>}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

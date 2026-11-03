import DOMPurify from 'dompurify'
import { motion } from 'framer-motion'
import { BadgeCheck, Check, Copy, Download, FileText, Hammer, Loader2, RefreshCw, Rocket, X } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type BuildSummary, type EngineStatus } from '../lib/api'
import { downloadBlob, slug } from '../lib/recorder'
import { useArena } from '../store'
import type { Provider } from '../types'
import ModelSelect from './ModelSelect'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'
import { tr, useT } from '../lib/i18n'
import { useAiConnect } from './AiConnect'

const TARGET_HINT: Record<string, [string, string]> = {
  'claude-code': ['Pide BRIEF.md + CLAUDE.md y construir por etapas verificando cada una.', 'Asks for BRIEF.md + CLAUDE.md and to build in stages, verifying each one.'],
  cursor: ['Pide BRIEF.md + reglas en .cursor/rules y commits chicos.', 'Asks for BRIEF.md + rules in .cursor/rules and small commits.'],
  chat: ['Para pegar en un chat de IA: plan primero, luego archivo por archivo.', 'To paste into an AI chat: plan first, then file by file.'],
  generic: ['Agnóstico: cualquier agente de código puede seguirlo.', 'Agnostic: any coding agent can follow it.'],
}

/** The ```text block under section 10 — the part you paste into the builder agent. */
function extractPrompt(md: string): string | null {
  const body = md.split('<details>')[0]
  const i = body.search(/\n##\s*\d+\.?\s*Prompt (?:para el agente|for the builder agent)/i)
  const sec = i >= 0 ? body.slice(i) : body
  const m = sec.match(/```(?:text|txt|markdown|md)?\n([\s\S]*?)```/)
  return m ? m[1].trim() : null
}

const isEngineProvider = (id: string) => id === 'claude-code' || id === 'codex' || id === 'muse-code'

const LABEL = 'text-[11px] uppercase tracking-[0.25em] text-ink-3'
const LABEL_ACCENT = 'text-[11px] uppercase tracking-[0.25em] text-accent'
const FIELD = 'h-10 w-full appearance-none rounded-xl border border-line bg-surface px-3 text-[13px] outline-none transition focus:border-accent'
const PILL = 'flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-2'
const PRIMARY = 'flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'

/** Option row with a switch: title, optional badge on the title line, hint under it and extra content (inputs) below. */
function Toggle({ checked, disabled, onChange, title, hint, badge, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; title: string; hint?: string; badge?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 transition ${disabled ? 'border-line bg-surface/60 opacity-60' : checked ? 'border-accent/40 bg-surface' : 'border-line bg-surface hover:border-accent/40'}`}>
      {/* only the switch and the title are the label: inputs below must not toggle it */}
      <label className={`flex items-start gap-3 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
        <span className="relative mt-[2px] inline-flex h-[18px] w-8 shrink-0 items-center">
          <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span className="absolute inset-0 rounded-full bg-ink-4/50 transition peer-checked:bg-accent" />
          <span className="absolute left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition peer-checked:translate-x-[14px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold leading-snug">{title}{badge}</span>
          {hint && <span className="mt-0.5 block text-[11.5px] font-normal leading-snug text-ink-3">{hint}</span>}
        </span>
      </label>
      {children && <div className="pl-11">{children}</div>}
    </div>
  )
}


export default function BriefExport({ onClose, onBuild, onOpenBuild }: { onClose: () => void; onBuild: (provider: string, model: string, target: string, record: boolean, reviewRounds: number, priorities?: string, design?: boolean, research?: { research?: boolean; references?: string[]; deep_analysis?: boolean }) => Promise<void>; onOpenBuild: (id: string) => void }) {
  const T = useT()
  const sessionId = useArena((s) => s.sessionId)!
  const config = useArena((s) => s.config)
  const [providers, setProviders] = useState<Provider[]>([])
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([])
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [target, setTarget] = useState('claude-code')
  const [includeTranscript, setIncludeTranscript] = useState(true)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [bProvider, setBProvider] = useState('')
  const [bModel, setBModel] = useState('')
  const [building, setBuilding] = useState(false)
  const [recordBuild, setRecordBuild] = useState(false)
  const [reviewRounds, setReviewRounds] = useState(3)
  const [autoReview, setAutoReview] = useState(true)
  const [priorities, setPriorities] = useState('')
  const [designFirst, setDesignFirst] = useState(true)
  // level 1: the team studies reference apps before designing; level 2: REA reverse-engineering, paid per use
  const [research, setResearch] = useState(true)
  const [refs, setRefs] = useState<string[]>(() => (useArena.getState().config?.references ?? []).filter(Boolean))
  const [refInput, setRefInput] = useState('')
  const [deep, setDeep] = useState(false)
  const [rstatus, setRstatus] = useState<{ chrome: string | null; rea: { ok: boolean; fee_usd: number }; deep_fee_usd: number; max_references: number } | null>(null)
  useEffect(() => { api.researchStatus().then((st) => { setRstatus(st); if (st.rea.ok && useArena.getState().config?.deep_analysis) setDeep(true) }).catch(() => {}) }, [])
  const addRef = () => {
    const parts = refInput.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
    if (!parts.length) return
    setRefs((r) => [...new Set([...r, ...parts])].slice(0, rstatus?.max_references ?? 6))
    setRefInput('')
  }
  const [builds, setBuilds] = useState<BuildSummary[]>([])
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [waitingLogin, setWaitingLogin] = useState(false)
  const [startFresh, setStartFresh] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const preview = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.targets().then(setTargets).catch(() => {})
    api.providers().catch(() => {
      setError(tr('No se puede conectar con el backend (localhost:8000). Levantalo con `make dev` (o `make backend`) y volvé a abrir este panel.', 'Cannot reach the backend (localhost:8000). Start it with `make dev` (or `make backend`) and reopen this panel.'))
      return [] as Provider[]
    }).then((ps) => {
      setProviders(ps)
      const p = ps.find((x) => x.configured && x.id !== 'mock') ?? ps.find((x) => x.id === 'mock')
      if (p) {
        setProvider(p.id)
        setModel(p.default_model)
        setBProvider(p.id)
        setBModel(p.default_model)
      }
    })
    api.builds(sessionId).then(setBuilds).catch(() => {})
    api.engines().then((es) => {
      setEngines(es)
      const ok = es.find((e) => e.ok)
      if (ok) {
        setBProvider(ok.id)
        setBModel('default')
      }
    }).catch(() => {})
    return () => abort.current?.abort()
  }, [])

  // "Ya me logueé": poll the local agents until one is connected (max 3 min) and switch the builder to it.
  useEffect(() => {
    if (!waitingLogin) return
    const started = Date.now()
    const tick = async () => {
      const es = await api.engines().catch(() => null)
      if (!es) return
      setEngines(es)
      const ok = es.find((e) => e.ok)
      if (ok) {
        setWaitingLogin(false)
        setBProvider(ok.id)
        setBModel('default')
        toast.ok(`${ok.label.split(' · ')[0]} ${tr('conectado', 'connected')}`, tr('El constructor ahora usa tu plan, sin gastar API.', 'The builder now uses your plan, without spending API credits.'))
      } else if (Date.now() - started > 180_000) setWaitingLogin(false)
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => clearInterval(id)
  }, [waitingLogin])

  useEffect(() => {
    if (busy && preview.current) preview.current.scrollTop = preview.current.scrollHeight
  }, [text, busy])

  const ai = useAiConnect(providers, (np) => setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x))))
  const configured = providers.filter((p) => p.configured && (p.id !== 'mock' || providers.filter((x) => x.configured).length === 1))
  // the file starts with an HTML comment header that renders as nothing: hide it in the preview
  const visible = useMemo(() => text.replace(/^\s*<!--[\s\S]*?-->\s*/, ''), [text])
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(visible, { async: false }) as string), [visible])
  const TOTAL_SECTIONS = 17
  const sectionsDone = useMemo(() => (visible.match(/\n##\s+\d+\./g) ?? []).length, [visible])
  const progress = busy ? Math.min(96, Math.round((sectionsDone / TOTAL_SECTIONS) * 100)) : text ? 100 : 0
  const turnsCount = useArena((s) => s.turns.length)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])
  const steps = [T('Leyendo la transcripción', 'Reading the transcript'), T('Rescatando las decisiones del equipo', 'Recovering the team decisions'), T('Resolviendo desacuerdos', 'Resolving disagreements'), T('Escribiendo la especificación', 'Writing the specification')]
  const stepIdx = Math.min(steps.length - 1, Math.floor(elapsed / 6))
  const prompt = useMemo(() => extractPrompt(text), [text])
  const base = `museteam-${slug(config?.title || config?.topic || sessionId)}`

  const generate = async (regenerate: boolean) => {
    setError(null)
    setBusy(true)
    setText('')
    abort.current = new AbortController()
    try {
      await api.brief(sessionId, { provider, model, target, include_transcript: includeTranscript, regenerate, user_notes: useArena.getState().decisionNotes || undefined }, setText, abort.current.signal)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (what: 'all' | 'prompt') => {
    try {
      await navigator.clipboard.writeText(what === 'all' ? text : (prompt ?? ''))
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setError(tr('No se pudo copiar al portapapeles', 'Could not copy to the clipboard'))
    }
  }

  const downloadTranscript = async () => {
    try {
      const md = await api.transcript(sessionId)
      downloadBlob(new Blob([md], { type: 'text/markdown' }), `${base}-transcripcion.md`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="relative flex h-[90vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(30,38,34,.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* -------- header */}
        <div className="flex items-start gap-4 border-b border-line px-7 py-5">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Exportar', 'Export')}</div>
            <h3 className="mt-0.5 text-[28px] leading-tight">{T('Brief para construir', 'Brief to build')}</h3>
            <p className="mt-1 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">{T('Un modelo convierte el debate en una especificación y un prompt listo para pegar en el agente que va a construir el proyecto.', 'A model turns the debate into a specification and a prompt ready to paste into the agent that will build the project.')}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={18} strokeWidth={2.5} /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* -------- options */}
          <div className="shrink-0 overflow-y-auto scroll-thin border-b border-line bg-paper/60 px-4 sm:px-6 py-5 md:w-[380px] md:border-b-0 md:border-r">
            <div className={LABEL}>{T('Lo escribe', 'Written by')}</div>
            <div className="mt-2 grid grid-cols-1 gap-2">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"><ProviderLogo provider={provider} size={16} /></span>
                <select
                  className={`${FIELD} pl-10`}
                  value={provider}
                  onChange={(e) => {
                    if (ai.ask(e.target.value, (np) => { setProvider(np.id); setModel(np.default_model) })) return
                    const p = providers.find((x) => x.id === e.target.value)!
                    setProvider(p.id)
                    setModel(p.default_model)
                  }}
                >
                  {providers.filter((p) => p.configured).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  {ai.options}
                </select>
                {ai.dialog}
              </div>
              <ModelSelect provider={provider} value={model} onChange={setModel} />
            </div>

            <div className={`${LABEL} mt-6`}>{T('Para construir con', 'To build with')}</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {targets.map((t) => (
                <button key={t.id} type="button" onClick={() => setTarget(t.id)} className={`rounded-xl border px-3 py-2.5 text-left text-[13px] font-semibold transition ${target === t.id ? 'border-accent bg-accent-soft text-accent shadow-[0_0_0_3px_rgba(47,107,93,.12)]' : 'border-line bg-surface text-ink hover:border-accent hover:bg-accent-soft hover:text-accent'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            {TARGET_HINT[target] && <p className="mt-2 text-[12px] leading-snug text-ink-3">{T(...TARGET_HINT[target])}</p>}

            <div className="mt-4">
              <Toggle checked={includeTranscript} onChange={setIncludeTranscript} title={T('Anexar la transcripción del debate', 'Attach the debate transcript')} hint={T('Va al final del archivo, plegada, para que el agente pueda consultarla.', 'Goes at the end of the file, folded, so the agent can consult it.')} />
            </div>

            <button disabled={busy || !model} onClick={() => generate(false)} className={`${PRIMARY} mt-4 h-11 w-full justify-center text-[14px]`}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Hammer size={16} />} {busy ? T('Escribiendo…', 'Writing…') : T('Generar brief', 'Generate brief')}
            </button>
            {text && !busy && (
              <button onClick={() => generate(true)} className="mt-2 flex w-full items-center justify-center gap-1.5 text-[12.5px] text-ink-3 transition hover:text-accent">
                <RefreshCw size={12} /> {T('Regenerar con este modelo', 'Regenerate with this model')}
              </button>
            )}
            <p className="mt-2 text-[11.5px] leading-snug text-ink-4">{T('Si ya existe un brief para este destino, se reutiliza sin gastar tokens.', 'If a brief already exists for this target, it is reused without spending tokens.')}</p>

            {/* -------- build in the app */}
            <div className="mt-6 rounded-2xl border border-accent/25 bg-accent-soft/40 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white"><Rocket size={14} /></span>
                <div className={LABEL_ACCENT}>{T('Construir en la app', 'Build in the app')}</div>
              </div>
              <p className="mt-2 text-[12.5px] leading-snug text-ink-2">{T('El constructor lee el brief y escribe el proyecto archivo por archivo, acá adentro. Al final lo descargás como .zip.', 'The builder reads the brief and writes the project file by file, right here. At the end you download it as a .zip.')}</p>

              <div className={`${LABEL} mt-4`}>{T('Constructor', 'Builder')}</div>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"><ProviderLogo provider={engines.find((e) => e.id === bProvider)?.logo ?? bProvider} size={16} /></span>
                <select
                  className={`${FIELD} pl-10`}
                  value={bProvider}
                  onChange={(e) => {
                    if (ai.ask(e.target.value, (np) => { setBProvider(np.id); setBModel(np.default_model) })) return
                    const id = e.target.value
                    const eng = engines.find((x) => x.id === id)
                    if (eng) {
                      setBProvider(id)
                      setBModel('default')
                      return
                    }
                    const p = providers.find((x) => x.id === id)!
                    setBProvider(p.id)
                    setBModel(p.default_model)
                  }}
                >
                  {engines.length > 0 && (
                    <optgroup label={T('Sin API · agentes locales con tu suscripción', 'No API · local agents with your subscription')}>
                      {engines.map((e) => <option key={e.id} value={e.id} disabled={!e.ok}>{e.label}{e.ok ? '' : ` (${e.installed ? T('sin login', 'not logged in') : T('no instalado', 'not installed')})`}</option>)}
                    </optgroup>
                  )}
                  <optgroup label={T('Por API (factura por tokens)', 'Via API (billed per token)')}>
                    {configured.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </optgroup>
                  {ai.options}
                </select>
              </div>
              {engines.find((e) => e.id === bProvider) ? (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[12px] leading-snug text-ink-2">
                  <BadgeCheck size={14} className="mt-0.5 shrink-0 text-ok" />
                  {(() => {
                    const e = engines.find((x) => x.id === bProvider)!
                    return <span>{T('Corre', 'Runs')} <b>{e.label.split(' · ')[0]}</b> {e.version ? `(${e.version})` : ''} {T('en esta máquina, con su propio login', 'on this machine, with its own login')}{e.auth ? ` — ${e.auth}` : ''}. {T('Escribe el proyecto en una carpeta real y puede correr comandos; el consejo de revisión también usa este motor.', 'It writes the project to a real folder and can run commands; the review council also uses this engine.')} {e.hint && <span className="text-gold">{e.hint}</span>}</span>
                  })()}
                </div>
              ) : (
                <div className="mt-2"><ModelSelect provider={bProvider} value={bModel} onChange={setBModel} /></div>
              )}
              {!engines.find((e) => e.id === bProvider) && (() => {
                const ready = engines.filter((e) => e.ok)
                const primary = engines.find((e) => e.id === 'claude-code') ?? engines[0]
                if (ready.length > 0) {
                  // the plan is connected but an API model is selected → one click to switch
                  return (
                    <div className="mt-2 rounded-xl border border-ok/40 bg-ok/5 px-3 py-2.5">
                      <div className="flex items-center gap-2 text-[12.5px]"><BadgeCheck size={15} className="shrink-0 text-ok" /> <span>{T('Tenés', 'You have')} <b>{ready.map((e) => e.label.split(' · ')[0]).join(T(' y ', ' and '))}</b> {T('conectado: podés construir con tu plan pago, sin gastar API.', 'connected: you can build with your paid plan, without spending API credits.')}</span></div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {ready.map((e) => (
                          <button key={e.id} onClick={() => { setBProvider(e.id); setBModel('default') }} className={`${PRIMARY} h-8 px-3 text-[12.5px]`}>
                            <ProviderLogo provider={e.logo} size={14} /> {T('Usar mi plan', 'Use my plan')} · {e.label.split(' · ')[0]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                }
                if (!primary) return null
                return (
                  <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                    <div className="text-[12.5px]"><b>{T('¿Pagás Claude Pro/Max o ChatGPT?', 'Paying for Claude Pro/Max or ChatGPT?')}</b> {T('Podés construir con ese plan en vez de API: la app usa el agente oficial instalado en tu máquina.', 'You can build with that plan instead of the API: the app uses the official agent installed on your machine.')}</div>
                    <ol className="mt-2 space-y-1.5 text-[12px] text-ink-2">
                      {!primary.installed && <li>1. {T('Instalá:', 'Install:')} <code className="rounded bg-surface-2 px-1 font-mono">npm install -g @anthropic-ai/claude-code</code></li>}
                      <li>{primary.installed ? '1' : '2'}. {T('En tu terminal:', 'In your terminal:')} <button onClick={() => { navigator.clipboard?.writeText('claude auth login'); toast.ok(tr('Copiado', 'Copied'), 'claude auth login') }} className="rounded bg-[#1E2622] px-1.5 py-0.5 font-mono text-[#E6ECE8] hover:brightness-110" title={T('copiar', 'copy')}>$ claude auth login <Copy size={10} className="inline opacity-60" /></button> {T('y entrá con tu cuenta de claude.ai.', 'and sign in with your claude.ai account.')}</li>
                      <li>{primary.installed ? '2' : '3'}. {T('Volvé acá: lo detectamos solos.', 'Come back here: we detect it on our own.')}</li>
                    </ol>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button onClick={() => setWaitingLogin(true)} className={waitingLogin ? `${PILL} h-8 border-accent/40 text-accent` : `${PRIMARY} h-8 px-3 text-[12.5px]`}>
                        {waitingLogin ? <><Loader2 size={13} className="animate-spin" /> {T('Esperando tu login…', 'Waiting for your login…')}</> : T('Ya me logueé, usar mi plan', 'I logged in, use my plan')}
                      </button>
                      <button onClick={() => useArena.getState().set({ showBriefExport: false, view: 'settings' })} className="text-[12px] text-accent hover:underline">{T('Ver todas las opciones (Codex, estado) →', 'See all options (Codex, status) →')}</button>
                    </div>
                  </div>
                )
              })()}

              <div className={`${LABEL} mt-4`}>{T('Antes de construir', 'Before building')}</div>
              <div className="mt-1.5 space-y-1.5">
                {/* level 1: benchmark of reference apps (headless Chrome + vision model) → research/REFERENCES.md for the designer and the builder */}
                <Toggle checked={research} onChange={setResearch} title={T('Investigar apps de referencia', 'Research reference apps')} hint={T('El equipo entra a apps similares, saca capturas y anota qué emular y qué evitar antes de diseñar.', 'The team visits similar apps, takes screenshots and notes what to emulate and avoid before designing.')}>
                  {research && (
                    <div className="mt-2 rounded-lg border border-line bg-paper p-2">
                      <div className="flex flex-wrap gap-1.5">
                        {refs.map((r) => (
                          <span key={r} className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent">
                            {r}
                            <button type="button" onClick={() => setRefs((x) => x.filter((y) => y !== r))} className="text-accent/70 hover:text-danger" title={T('Quitar', 'Remove')}><X size={11} /></button>
                          </span>
                        ))}
                        <input
                          value={refInput}
                          onChange={(e) => setRefInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRef() } }}
                          onBlur={addRef}
                          placeholder={refs.length ? T('otra app o URL…', 'another app or URL…') : T('apps o URLs (Enter para agregar); vacío: el equipo propone', 'apps or URLs (Enter to add); empty: the team proposes')}
                          className="min-w-[200px] flex-1 bg-transparent text-[12px] outline-none placeholder:text-ink-4"
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-ink-4">
                        {rstatus && !rstatus.chrome ? T('Sin Chrome para sacar capturas: se analiza solo el texto de cada sitio.', 'No Chrome for screenshots: only each site\'s text is analysed.') : T('Se observan productos públicos, nada se copia. Resultado: research/REFERENCES.md.', 'Public products are observed, nothing is copied. Output: research/REFERENCES.md.')}
                      </div>
                    </div>
                  )}
                </Toggle>
                {/* level 2: paid per use; needs REA installed and a local engine as builder */}
                <Toggle
                  checked={deep}
                  disabled={!rstatus?.rea.ok || !isEngineProvider(bProvider)}
                  onChange={(v) => { setDeep(v); if (v) setResearch(true) }}
                  title={T('Análisis profundo e ingeniería inversa', 'Deep analysis and reverse engineering')}
                  badge={<span className="rounded-full border border-gold/50 bg-gold/10 px-2 py-[1px] text-[10.5px] font-semibold text-gold">{T('pago por uso', 'pay per use')} · USD {(rstatus?.deep_fee_usd ?? 9).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>}
                  hint={rstatus && !rstatus.rea.ok ? T('Instalá REA: npx rea-agents setup', 'Install REA: npx rea-agents setup') : !isEngineProvider(bProvider) ? T('Disponible con Muse Code como constructor.', 'Available with Muse Code as builder.') : T('REA analiza bundles, rutas y APIs de los referentes para entender cómo están hechos.', 'REA analyses the references\' bundles, routes and APIs to understand how they are built.')}
                />
                <Toggle checked={designFirst} onChange={setDesignFirst} title={T('Diseño UX/UI primero', 'UX/UI design first')} hint={T('El Product Designer entrega sistema, pantallas y mockup; la UI debe seguirlo.', 'The Product Designer delivers system, screens and mockup; the UI must follow it.')} />
                <Toggle checked={recordBuild} onChange={setRecordBuild} title={T('Grabar la construcción en video', 'Record the build on video')} hint={T('Chrome pide compartir esta pestaña.', 'Chrome asks to share this tab.')} />
                <Toggle checked={autoReview} onChange={setAutoReview} title={T('Revisión pre-prod del equipo al terminar', 'Pre-prod team review when done')} hint={T('El consejo revisa el proyecto construido y entrega la lista de cambios.', 'The council reviews the built project and hands you the change list.')}>
                  {autoReview && (
                    <div className="mt-2 space-y-1.5">
                      <select value={reviewRounds} onChange={(e) => setReviewRounds(Number(e.target.value))} className="h-8 rounded-lg border border-line bg-paper px-2 text-[12px] outline-none focus:border-accent">
                        {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{T('hasta', 'up to')} {n} {T('ronda', 'round')}{n === 1 ? '' : 's'}</option>)}
                      </select>
                      <textarea value={priorities} onChange={(e) => setPriorities(e.target.value)} rows={2} placeholder={T('¿Qué querés que el consejo trate primero? (opcional: lo demás lo deciden ellos)', 'What should the council address first? (optional: they decide the rest)')} className="w-full rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12px] outline-none focus:border-accent" />
                    </div>
                  )}
                </Toggle>
              </div>

              {(() => {
                // an unfinished build for this brief → resume it (same chat, same files) instead of starting from zero
                const pending = builds.find((x) => ['running', 'reviewing', 'connecting', 'stopped', 'error'].includes(x.status))
                if (pending && !startFresh) {
                  const live = pending.status === 'running' || pending.status === 'reviewing'
                  return (
                    <div className="mt-4 rounded-xl border border-accent bg-surface p-3">
                      <div className="flex items-center gap-2 text-[13px] font-semibold"><ProviderLogo provider={pending.provider} size={16} /> {live ? T('Hay una construcción en curso', 'There is a build in progress') : T('Hay una construcción a medio hacer', 'There is a half-finished build')}</div>
                      <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{pending.files} {pending.files === 1 ? T('archivo escrito', 'file written') : T('archivos escritos', 'files written')}{pending.stages ? ` · ${pending.stages} ${pending.stages === 1 ? T('etapa cerrada', 'stage closed') : T('etapas cerradas', 'stages closed')}` : ''} · {pending.model}. {live ? T('Sigue corriendo en el servidor aunque cierres esta pantalla.', 'It keeps running on the server even if you close this screen.') : T('Al retomar, el constructor revisa lo hecho y sigue desde ahí, sin repetir nada.', 'On resume, the builder reviews what was done and continues from there, without repeating anything.')}</div>
                      <button
                        disabled={building}
                        onClick={async () => {
                          setBuilding(true)
                          setError(null)
                          try {
                            if (!live) await api.buildResume(pending.id, sessionId)
                            await onOpenBuild(pending.id)
                          } catch (e) {
                            setError((e as Error).message)
                            setBuilding(false)
                          }
                        }}
                        className={`${PRIMARY} mt-2.5 h-10 w-full justify-center`}
                      >
                        {building ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />} {building ? T('Abriendo…', 'Opening…') : live ? T('Volver a la construcción', 'Back to the build') : T('Retomar la construcción', 'Resume the build')}
                      </button>
                      <button onClick={() => setStartFresh(true)} className="mt-1.5 w-full text-[11.5px] text-ink-3 transition hover:text-accent">{T('Empezar una construcción nueva desde cero', 'Start a new build from scratch')}</button>
                    </div>
                  )
                }
                return (
                  <button
                    disabled={!text || busy || building || !bModel}
                    onClick={async () => {
                      setBuilding(true)
                      setError(null)
                      try {
                        await onBuild(bProvider, bModel, target, recordBuild, autoReview ? reviewRounds : 0, autoReview ? priorities.trim() : '', designFirst, { research, references: refs, deep_analysis: deep })
                      } catch (e) {
                        setError((e as Error).message)
                        setBuilding(false)
                      }
                    }}
                    className={`${PRIMARY} mt-4 h-11 w-full justify-center text-[14px]`}
                    title={!text ? T('Primero generá el brief', 'Generate the brief first') : undefined}
                  >
                    {building ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />} {building ? T('Lanzando…', 'Launching…') : T('Construir el producto', 'Build the product')}
                  </button>
                )
              })()}
              {!text && <p className="mt-2 text-[11.5px] leading-snug text-ink-4">{T('Generá el brief primero: es lo que el constructor va a seguir.', 'Generate the brief first: it is what the builder will follow.')}</p>}
              {builds.length > 0 && (
                <div className="mt-4">
                  <div className={LABEL}>{T('Construcciones anteriores', 'Previous builds')}</div>
                  <div className="mt-1.5 space-y-1">
                    {builds.slice(0, 5).map((b) => (
                      <button key={b.id} onClick={() => onOpenBuild(b.id)} className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-[12px] transition hover:border-accent hover:bg-accent-soft">
                        <ProviderLogo provider={b.provider} size={14} />
                        <span className="truncate font-mono">{b.model}</span>
                        <span className="ml-auto shrink-0 text-ink-3">{b.files} {T('arch.', 'files')} · {b.status}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6">
              <div className={LABEL}>{T('Sin modelo', 'No model')}</div>
              <button onClick={downloadTranscript} className={`${PILL} mt-2 w-full justify-center`}><FileText size={15} /> {T('Transcripción del debate .md', 'Debate transcript .md')}</button>
            </div>
            {error && <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
          </div>

          {/* -------- preview */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative flex items-center gap-3 border-b border-line px-6 py-3">
              {busy && (
                <div className="absolute bottom-0 left-0 right-0 h-[3px] overflow-hidden bg-accent-soft">
                  {sectionsDone > 0 ? (
                    <div className="h-full bg-accent transition-all duration-700" style={{ width: `${progress}%` }} />
                  ) : (
                    <div className="h-full w-1/3 bg-accent/70 animate-[shimmer_1.4s_ease-in-out_infinite]" />
                  )}
                </div>
              )}
              <span className={LABEL}>{T('Vista previa', 'Preview')}</span>
              {busy ? (
                <span className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-2.5 py-0.5 text-[11.5px] text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                  {sectionsDone > 0 ? `${T('sección', 'section')} ${sectionsDone} ${T('de', 'of')} ${TOTAL_SECTIONS} · ${progress}%` : steps[stepIdx] + '…'} <span className="font-mono text-ink-3">{elapsed}s</span>
                </span>
              ) : text ? (
                <span className="flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok/5 px-2.5 py-0.5 text-[11.5px] text-ok"><Check size={12} /> {T('Brief listo', 'Brief ready')} · {sectionsDone} {T('secciones', 'sections')}</span>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <button disabled={!prompt || busy} onClick={() => copy('prompt')} className={PILL} title={T('Copia sólo el prompt final para el agente constructor', 'Copies only the final prompt for the builder agent')}>
                  {copied === 'prompt' ? <Check size={14} /> : <Copy size={14} />} {T('Copiar prompt', 'Copy prompt')}
                </button>
                <button disabled={!text || busy} onClick={() => copy('all')} className={PILL}>
                  {copied === 'all' ? <Check size={14} /> : <Copy size={14} />} {T('Copiar todo', 'Copy all')}
                </button>
                <button disabled={!text || busy} onClick={() => downloadBlob(new Blob([text], { type: 'text/markdown' }), `${base}-brief-${target}.md`)} className={PRIMARY}>
                  <Download size={14} /> {T('Descargar .md', 'Download .md')}
                </button>
              </div>
            </div>
            <div ref={preview} className="flex-1 overflow-y-auto scroll-thin bg-paper/40 px-4 py-5 sm:px-8 sm:py-8">
              {busy && !visible.trim() ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div className="relative">
                    {[0, 1].map((i) => <span key={i} className="absolute inset-0 rounded-full border border-accent/40 animate-ping" style={{ animationDelay: `${i * 0.6}s`, animationDuration: '2s' }} />)}
                    <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface shadow-sm"><ProviderLogo provider={provider} size={34} /></span>
                  </div>
                  <div className="mt-6 font-mono text-[15px]">{model}</div>
                  <div className="mt-1 text-sm text-ink-3">{T('está escribiendo el brief a partir de', 'is writing the brief from')} {turnsCount} {T('turnos', 'turns')}</div>
                  <ul className="mt-6 space-y-2 text-left text-sm">
                    {steps.map((st, i) => (
                      <li key={st} className={`flex items-center gap-2.5 ${i < stepIdx ? 'text-ok' : i === stepIdx ? 'text-ink' : 'text-ink-4'}`}>
                        <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${i < stepIdx ? 'bg-ok/15' : i === stepIdx ? 'bg-accent-soft text-accent' : 'bg-surface-2'}`}>{i < stepIdx ? <Check size={11} /> : i === stepIdx ? <span className="h-2 w-2 rounded-full bg-accent animate-pulse" /> : ''}</span>
                        {st}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6 max-w-xs text-[12px] text-ink-4">{T('Un modelo grande puede tardar 20–60 s antes de la primera línea; el documento completo son varios miles de palabras.', 'A large model can take 20–60 s before the first line; the full document is several thousand words.')} {elapsed}s {T('transcurridos.', 'elapsed.')}</div>
                </div>
              ) : text ? (
                <div className="mx-auto max-w-[820px] rounded-2xl border border-line bg-surface px-10 py-9 shadow-[0_1px_2px_rgba(30,38,34,.04),0_12px_32px_-20px_rgba(30,38,34,.25)]">
                  <article className={`md ${busy ? 'caret' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface shadow-sm"><FileText size={24} className="text-accent" /></span>
                  <div className="mt-4 text-[17px]">{T('Todavía no hay brief', 'No brief yet')}</div>
                  <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-3">{T('Elegí el modelo y el destino, y generá el brief. Vas a ver cómo se escribe acá, sección por sección.', 'Pick the model and the target, then generate the brief. You will watch it being written here, section by section.')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

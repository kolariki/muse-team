import DOMPurify from 'dompurify'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Copy, FolderOpen, GitBranch, Loader2, Search, Send, Terminal, Wrench, X } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type AgentPart, type AgentSessionDetail, type AgentSessionList, type AgentSessionSummary } from '../lib/api'
import { readCache, writeCache } from '../lib/cache'
import { fmtDur } from '../lib/duration'
import { tr, useT } from '../lib/i18n'
import { PanelLoader } from './HomeLoader'
import { MUSE_ONLY } from '../lib/flags'
import ProviderLogo from './ProviderLogo'

type Engine = 'muse' | 'claude' | 'codex'
const ENGINES: Engine[] = MUSE_ONLY ? ['muse'] : ['muse', 'claude', 'codex']
const LOGO: Record<Engine, string> = { muse: 'meta', claude: 'anthropic', codex: 'openai' }
const NAME: Record<Engine, string> = { muse: 'Muse Code', claude: 'Claude Code', codex: 'Codex' }
const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string)
const PILL = 'flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'

function ago(ts: number, T: (es: string, en: string) => string) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))
  if (m < 1) return T('ahora', 'now')
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d`
  return new Date(ts * 1000).toLocaleDateString()
}

const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

function CopyChip({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1400) } catch { /* no clipboard */ } }} className={PILL} title={text}>
      {ok ? <Check size={13} /> : <Copy size={13} />} {ok ? tr('Copiado', 'Copied') : label}
    </button>
  )
}

/** A tool call the assistant made: one line, expandable to the full input and result. */
function ToolPart({ p }: { p: AgentPart }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className={`my-1 rounded-lg border text-[12px] ${p.is_error ? 'border-danger/30 bg-danger/5' : 'border-line bg-paper'}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <Wrench size={11} className="shrink-0 text-ink-3" />
        <span className="shrink-0 font-semibold text-ink">{p.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">{p.summary}</span>
        {p.result != null && <span className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] ${p.is_error ? 'bg-danger/10 text-danger' : 'bg-ok/10 text-ok'}`}>{p.is_error ? T('error', 'error') : T('ok', 'ok')}</span>}
        <ChevronRight size={12} className={`shrink-0 text-ink-3 transition ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-4">{T('entrada', 'input')}</div>
          <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-ink-2">{p.input}</pre>
          {p.result != null && (
            <>
              <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-ink-4">{T('resultado', 'result')}</div>
              <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-ink-2">{p.result || '(vacío)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingPart({ text }: { text: string }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[11.5px] italic text-ink-3 hover:text-ink"><ChevronRight size={11} className={`transition ${open ? 'rotate-90' : ''}`} /> {T('Pensó', 'Thought')} · {Math.round(text.length / 5)} {T('palabras', 'words')}</button>
      {open && <div className="mt-1 whitespace-pre-wrap rounded-lg border border-dashed border-line px-3 py-2 text-[12px] italic leading-relaxed text-ink-2">{text}</div>}
    </div>
  )
}

function Conversation({ engine, id, onClose }: { engine: Engine; id: string; onClose: () => void }) {
  const T = useT()
  const [d, setD] = useState<AgentSessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // chatting from here: the real CLI session is resumed; what streams back is shown live, then the file is re-read
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<{ user: string; parts: AgentPart[]; text: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // the engines report differently (Muse: flat cwd/branch/model and plain-text items, no usage): one shape for the screen
  const normalize = (x: AgentSessionDetail): AgentSessionDetail => {
    const raw = x as AgentSessionDetail & { cwd?: string | null; branch?: string | null; model?: string | null }
    return {
      ...x,
      meta: x.meta ?? { cwd: raw.cwd ?? null, branch: raw.branch ?? null, model: raw.model ?? null, version: null },
      usage: x.usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      items: (x.items ?? []).map((it) => ({ ...it, parts: it.parts ?? ((it as { text?: string }).text ? [{ type: 'text' as const, text: (it as { text?: string }).text }] : []) })),
    }
  }
  const load = () => api.agentSession(engine, id).then((x) => setD(normalize(x))).catch((e) => setError((e as Error).message))
  useEffect(() => {
    setD(null)
    setError(null)
    setPending(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, id])
  useEffect(() => { if (pending && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [pending])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    setPending({ user: text, parts: [], text: '' })
    try {
      const res = await api.agentChat(engine, id, text)
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let ev: Record<string, string>
          try { ev = JSON.parse(line) } catch { continue }
          setPending((p) => {
            if (!p) return p
            if (ev.kind === 'text_delta') return { ...p, text: p.text + (ev.text ?? '') }
            if (ev.kind === 'text') return { ...p, text: '', parts: [...p.parts, { type: 'text', text: ev.text ?? '' }] }
            if (ev.kind === 'activity') return { ...p, parts: [...p.parts, { type: 'tool', name: ev.label ?? ev.act ?? 'tool', summary: ev.path ?? '', input: ev.path ?? '', result: null }] }
            if (ev.kind === 'error') return { ...p, parts: [...p.parts, { type: 'text', text: `**Error:** ${ev.error ?? ''}` }] }
            if (ev.kind === 'result' && ev.error) return { ...p, parts: [...p.parts, { type: 'text', text: `**Error:** ${ev.error}` }] }
            return p
          })
        }
      }
    } catch (e) {
      setPending((p) => (p ? { ...p, parts: [...p.parts, { type: 'text', text: `**Error:** ${(e as Error).message}` }] } : p))
    } finally {
      setSending(false)
      await load()
      setPending(null)
    }
  }
  if (error) return <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-danger">{error}</div>
  if (!d) return <PanelLoader caption={T('Abriendo la conversación…', 'Opening the conversation…')} />
  const turns = d.items.filter((i) => i.role === 'user').length
  const span = d.updated - d.created
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="flex flex-wrap items-start gap-3 border-b border-line bg-surface px-4 py-3 sm:flex-nowrap sm:px-6 sm:py-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider={LOGO[engine]} size={18} /></span>
        <div className="order-3 w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
          <h2 className="text-[18px] leading-tight sm:truncate">{d.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
            {d.meta.cwd && <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono" title={d.meta.cwd}><FolderOpen size={11} className="shrink-0" /> <span className="truncate">{d.meta.cwd}</span></span>}
            {d.meta.branch && <span className="inline-flex items-center gap-1 font-mono"><GitBranch size={11} /> {d.meta.branch}</span>}
            {d.meta.model && <span className="font-mono">{d.meta.model}</span>}
            <span>{new Date(d.created * 1000).toLocaleString()} → {ago(d.updated, T)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-ink-2"><b className="text-ink">{turns}</b> {T('pedidos', 'prompts')}</span>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-ink-2"><b className="text-ink">{d.items.reduce((a, i) => a + i.parts.filter((p) => p.type === 'tool').length, 0)}</b> {T('herramientas', 'tools')}</span>
            {span > 60 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-ink-2"><b className="text-ink">{fmtDur(span)}</b> {T('de duración', 'long')}</span>}
            {d.usage.output > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-ink-2" title={T('Tokens de entrada / salida / leídos de caché', 'Input / output / cache-read tokens')}>{fmtK(d.usage.input + d.usage.cache_write)} → <b className="text-ink">{fmtK(d.usage.output)}</b> tok{d.usage.cache_read ? ` · ${fmtK(d.usage.cache_read)} caché` : ''}</span>}
            {d.live && <span className="inline-flex items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-ok"><span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse" /> {T('activa', 'live')}</span>}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <CopyChip text={d.resume} label={T('Reanudar en terminal', 'Resume in terminal')} />
          <button onClick={onClose} className="rounded-full p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink md:hidden" aria-label={T('Cerrar', 'Close')}><X size={16} /></button>
        </div>
      </div>
      {/* messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scroll-thin bg-paper/40 px-4 sm:px-6 py-6">
        <div className="mx-auto max-w-[860px] space-y-5">
          {d.truncated && <div className="rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 text-[12px]">{T('Conversación muy larga: se muestran los primeros 2500 mensajes.', 'Very long conversation: the first 2500 messages are shown.')}</div>}
          {d.items.map((it, i) =>
            it.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[78%] rounded-2xl rounded-tr-md bg-accent-soft px-4 py-3 text-[13.5px] leading-relaxed text-ink">
                  <div className="whitespace-pre-wrap break-words">{it.parts[0]?.text}</div>
                  {it.ts && <div className="mt-1 text-right text-[10.5px] text-ink-4">{new Date(it.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3">
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider={LOGO[engine]} size={14} /></span>
                <div className="min-w-0 flex-1">
                  {it.parts.map((p, j) =>
                    p.type === 'text' ? <article key={j} className="md text-[13.5px]" dangerouslySetInnerHTML={{ __html: md(p.text ?? '') }} /> : p.type === 'thinking' ? <ThinkingPart key={j} text={p.text ?? ''} /> : <ToolPart key={j} p={p} />,
                  )}
                </div>
              </div>
            ),
          )}
          {pending && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[78%] rounded-2xl rounded-tr-md bg-accent-soft px-4 py-3 text-[13.5px] leading-relaxed text-ink"><div className="whitespace-pre-wrap break-words">{pending.user}</div></div>
              </div>
              <div className="flex gap-3">
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider={LOGO[engine]} size={14} /></span>
                <div className="min-w-0 flex-1">
                  {pending.parts.map((p, j) => (p.type === 'text' ? <article key={j} className="md text-[13.5px]" dangerouslySetInnerHTML={{ __html: md(p.text ?? '') }} /> : <ToolPart key={j} p={p} />))}
                  {pending.text && <article className="md text-[13.5px]" dangerouslySetInnerHTML={{ __html: md(pending.text) }} />}
                  {sending && <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-3"><Loader2 size={12} className="animate-spin" /> {T('respondiendo…', 'answering…')}</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {/* composer: continues the real session with the CLI, in its own folder */}
      <div className="border-t border-line bg-surface px-6 py-3">
        <div className="mx-auto flex max-w-[860px] items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            rows={2}
            placeholder={T('Seguí la conversación acá: corre el mismo agente, en la misma carpeta, con toda la memoria de la sesión…', 'Continue the conversation here: the same agent runs, in the same folder, with the whole session memory…')}
            className="min-h-[44px] flex-1 resize-none rounded-2xl border border-line bg-paper px-4 py-2.5 text-[13.5px] outline-none focus:border-accent"
          />
          <button onClick={send} disabled={!draft.trim() || sending} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm transition hover:brightness-110 disabled:opacity-40" title={T('Enviar (Enter)', 'Send (Enter)')}>{sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}</button>
        </div>
        <div className="mx-auto mt-1 max-w-[860px] text-[11px] text-ink-4">{engine === 'claude' ? T('Usa tu Claude Code con tu suscripción; los cambios en archivos quedan en la carpeta del proyecto.', 'Uses your Claude Code on your subscription; file changes land in the project folder.') : T('Usa tu Codex CLI con tu cuenta de ChatGPT; los cambios en archivos quedan en la carpeta del proyecto.', 'Uses your Codex CLI with your ChatGPT account; file changes land in the project folder.')}</div>
      </div>
    </div>
  )
}

/** Your Claude Code and Codex conversations, read from this machine, laid out like the claude.ai web. */
export default function AgentSessions({ onBack }: { onBack: () => void }) {
  const T = useT()
  const [engine, setEngine] = useState<Engine>(() => { const c = readCache<Engine>('agents.engine'); return c && ENGINES.includes(c) ? c : ENGINES[0] })
  const [list, setList] = useState<AgentSessionList | null>(() => readCache<AgentSessionList>(`agents.${engine}`) ?? null)
  const [loading, setLoading] = useState(!list)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [sel, setSel] = useState<AgentSessionSummary | null>(null)

  useEffect(() => {
    writeCache('agents.engine', engine)
    const cached = readCache<AgentSessionList>(`agents.${engine}`)
    setList(cached ?? null)
    setLoading(!cached)
    api.agentSessions(engine).then((l) => { writeCache(`agents.${engine}`, l); setList(l); setLoading(false) }).catch(() => setLoading(false))
  }, [engine])

  const projects = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return (list?.projects ?? []).map((p) => ({ ...p, sessions: ql ? p.sessions.filter((s) => s.title.toLowerCase().includes(ql) || (s.cwd ?? '').toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql)) : p.sessions })).filter((p) => p.sessions.length)
  }, [list, q])

  const isOpen = (key: string, idx: number) => open[key] ?? (idx < 4 || !!q)

  return (
    <div className="flex h-full min-h-0 flex-col arena-bg">
      {/* top bar */}
      <div className="flex items-center gap-3 border-b border-line bg-surface px-6 py-3">
        <button onClick={onBack} className={PILL}><ArrowLeft size={14} /> {T('Inicio', 'Home')}</button>
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.3em] text-accent">{T('Tus IAs', 'Your AIs')}</div>
          <div className="text-[17px] leading-tight">{T('Proyectos y conversaciones', 'Projects and conversations')}</div>
        </div>
        <div data-tour="engines" className="ml-auto flex items-center rounded-full border border-line bg-paper p-1 shadow-sm">
          {ENGINES.map((e) => (
            <button key={e} onClick={() => { setEngine(e); setSel(null) }} className={`flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition ${engine === e ? 'bg-accent text-white shadow-sm' : 'text-ink-2 hover:text-ink'}`}>
              <ProviderLogo provider={LOGO[e]} size={14} className={engine === e ? 'brightness-[3]' : ''} /> {NAME[e]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <aside data-tour="sessions" className={`flex w-full shrink-0 flex-col border-r border-line bg-surface md:w-[340px] ${sel ? 'hidden md:flex' : ''}`}>
          <div className="border-b border-line p-3">
            <label className="flex h-9 items-center gap-2 rounded-full border border-line bg-paper px-3 text-[13px]"><Search size={13} className="text-ink-3" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={T('Buscar conversación o proyecto…', 'Search conversation or project…')} className="w-full bg-transparent outline-none placeholder:text-ink-4" /></label>
            <div className="mt-2 px-1 text-[11px] text-ink-3">{list ? `${list.count} ${T('conversaciones', 'conversations')} · ${list.projects.length} ${T('proyectos', 'projects')}` : ' '}</div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            {loading && !list ? (
              <div className="flex items-center gap-2 px-4 py-6 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> {T('Leyendo tus sesiones…', 'Reading your sessions…')}</div>
            ) : list && !list.available ? (
              <div className="px-4 py-6 text-[12.5px] leading-relaxed text-ink-3">{engine === 'claude' ? T('No encontré ~/.claude/projects en esta máquina: Claude Code todavía no guardó conversaciones acá.', 'Could not find ~/.claude/projects on this machine: Claude Code has not saved conversations here yet.') : T('No encontré ~/.codex/sessions en esta máquina: Codex todavía no guardó conversaciones acá.', 'Could not find ~/.codex/sessions on this machine: Codex has not saved conversations here yet.')}</div>
            ) : projects.length === 0 ? (
              <div className="px-4 py-6 text-[12.5px] text-ink-3">{T('Nada que mostrar.', 'Nothing to show.')}</div>
            ) : (
              projects.map((p, idx) => (
                <div key={p.key} className="border-b border-line/70">
                  <button onClick={() => setOpen((o) => ({ ...o, [p.key]: !isOpen(p.key, idx) }))} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/60">
                    <ChevronDown size={13} className={`shrink-0 text-ink-3 transition ${isOpen(p.key, idx) ? '' : '-rotate-90'}`} />
                    <FolderOpen size={13} className="shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={p.path ?? p.key}>{p.name}</span>
                    <span className="shrink-0 text-[11px] text-ink-3">{p.sessions.length}</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen(p.key, idx) && (
                      <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden pb-1">
                        {p.sessions.map((s) => (
                          <li key={s.id}>
                            <button onClick={() => setSel(s)} className={`flex w-full items-start gap-2 px-3 py-2 pl-9 text-left transition ${sel?.id === s.id ? 'bg-accent-soft' : 'hover:bg-surface-2/60'}`}>
                              <span className="min-w-0 flex-1">
                                <span className={`block truncate text-[12.5px] ${sel?.id === s.id ? 'font-semibold text-accent' : 'text-ink'}`}>{s.title}</span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-4">{s.live && <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse" />}{ago(s.updated, T)}{s.branch ? ` · ${s.branch}` : ''}{s.model ? ` · ${s.model.replace('claude-', '')}` : ''}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                </div>
              ))
            )}
          </div>
        </aside>
        {/* conversation */}
        <main data-tour="conversation" className={`flex min-h-0 min-w-0 flex-1 flex-col ${sel ? '' : 'hidden md:flex'}`}>
          {sel ? (
            <Conversation engine={engine} id={sel.id} onClose={() => setSel(null)} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface shadow-sm"><Terminal size={22} className="text-accent" /></span>
              <div className="mt-4 text-[17px]">{T('Elegí una conversación', 'Pick a conversation')}</div>
              <p className="mt-1 max-w-md text-[13px] leading-relaxed text-ink-3">{T('Son las sesiones que Muse Code guarda en esta máquina, agrupadas por proyecto. Se leen tal cual están en el disco; nada se envía a ningún lado.', 'These are the sessions Muse Code keep on this machine, grouped by project. They are read as they are on disk; nothing is sent anywhere.')}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

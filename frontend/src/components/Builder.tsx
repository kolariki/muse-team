import DOMPurify from 'dompurify'
import { openTeam } from './TeamMemory'
import { srv } from '../lib/serverText'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Clapperboard, Hammer, X, ArrowLeft, ArrowRight, CheckCircle2, Trophy, FlaskConical, Gauge, Home, ListChecks, Search, ShieldCheck, ChevronDown, ChevronLeft, Circle, Copy, CreditCard, Download, Maximize2, Minimize2, GitBranch, HardHat, MonitorPlay, Palette, PanelRightClose, ExternalLink, Eye, FileCode2, FileText, Folder, Gavel, KeyRound, Play, RefreshCw, Send, Square, TerminalSquare, Sparkles, Loader2, CloudUpload, Clock3, Menu, Users, Languages } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'
import { reconnectBuild, useBuild, type Activity, type ChatItem, type Todo } from '../buildStore'
import { api } from '../lib/api'
import { BRAND_COLOR } from '../lib/brand'
import { tr, useT } from '../lib/i18n'
import { downloadBlob, requestTabStream, startRecording, type Recording } from '../lib/recorder'
import { toast } from './Toast'
import ProviderLogo from './ProviderLogo'
import { LiveReview, ReviewLauncher, ReviewRoundCard } from './ReviewPanel'
import ServicesDeploy, { servicesMissing } from './ServicesDeploy'
import CloudPanel from './CloudPanel'
import LevelsPanel, { LevelBadge } from './LevelsPanel'
import AdsPanel from './AdsPanel'
import { fmtDur } from '../lib/duration'
import AppRunner from './AppRunner'
import ThemeSwitch from './ThemeSwitch'
import RunModal from './RunModal'
import VersionsPanel, { ReadinessBadge } from './VersionsPanel'
import CouncilLaunch from './CouncilLaunch'
import FdeModal from './FdeModal'
import { useArena } from '../store'
import CodeEditor from './CodeEditor'
import DesignPanel from './DesignPanel'
import { useEditorTheme } from '../lib/editorThemes'

/** Header buttons share the home page's language: pills that lift on hover. */
const HBTN = 'flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-2 shadow-sm transition hover:bg-accent-soft hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-2'
const HBTN_PRIMARY = 'flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const PBTN = 'flex items-center gap-1 rounded-md px-2 py-1 text-ink-3 transition hover:bg-surface-2 hover:text-ink disabled:opacity-40'

type BuildState = ReturnType<typeof useBuild.getState>
/** The panes the rail can open, in order, with when each one is still empty. */
const PANES: { id: BuildState['pane']; icon: typeof FileCode2; es: string; en: string; off: (b: BuildState) => boolean }[] = [
  { id: 'code', icon: FileCode2, es: 'Código', en: 'Code', off: () => false },
  { id: 'design', icon: Palette, es: 'Diseño', en: 'Design', off: () => false },
  { id: 'preview', icon: Eye, es: 'Vista previa', en: 'Preview', off: (b) => !b.previewHtml },
  { id: 'app', icon: MonitorPlay, es: 'App real', en: 'Real app', off: (b) => Object.keys(b.files).length === 0 },
  { id: 'versions', icon: GitBranch, es: 'Versiones', en: 'Versions', off: (b) => b.versions.length === 0 },
  { id: 'cloud', icon: CloudUpload, es: 'Publicar', en: 'Publish', off: () => false },
  { id: 'levels', icon: Trophy, es: 'Niveles', en: 'Levels', off: () => false },
  { id: 'ads', icon: Clapperboard, es: 'Anuncios', en: 'Ads', off: (b) => Object.keys(b.files).length === 0 },
  { id: 'deploy', icon: KeyRound, es: 'Servicios', en: 'Services', off: () => false },
  { id: 'report', icon: FileText, es: 'Informe', en: 'Report', off: (b) => !b.auditReport },
]

/** Chat Markdown with semantic colour: inline code becomes a typed chip (file path, command, number, hash, keyword) and
 * plain-text measurements get a quiet highlight, so a turn reads like a changelog instead of a wall of text. */
const CMD_RE = /^(npm|npx|pnpm|yarn|bun|git|node|uv|python3?|pip|claude|codex|docker|make|cargo|go|rm|cd|ls|cat|curl)\b/
const PATH_RE = /^(?:[\w.@-]+\/)+[\w.@-]+$|^[\w.-]+\.(tsx?|jsx?|mjs|cjs|json|md|css|scss|html|py|toml|ya?ml|sh|svg|png|env|txt|sql|lock)$/i
const NUM_RE = /^[-+]?\d[\d.,]*\s?(%|px|ms|s|KB|MB|GB|h|min|kt|°)?$/
const HASH_RE = /^[0-9a-f]{7,40}$/
const classify = (t: string) => (CMD_RE.test(t) ? 'cmd' : PATH_RE.test(t) ? 'path' : HASH_RE.test(t) ? 'hash' : NUM_RE.test(t) ? 'num' : 'kw')
const md = (s: string) => {
  const html = DOMPurify.sanitize(marked.parse(s, { async: false }) as string)
  const el = document.createElement('div')
  el.innerHTML = html
  el.querySelectorAll('code').forEach((c) => {
    if (c.parentElement?.tagName === 'PRE') return
    const t = (c.textContent ?? '').trim()
    const kind = classify(t)
    c.classList.add('tok', `tok-${kind}`)
    if (kind === 'path') c.setAttribute('data-path', t.replace(/^\.\//, ''))
  })
  // measurements in prose: "36.8 KB", "227 tests", "2184 palabras", "0.9 s"
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const todo: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement && ['CODE', 'PRE', 'A'].includes(n.parentElement.tagName))) todo.push(n as Text)
  const MEAS = /(\b\d[\d.,]*\s?(?:%|px|ms|KB|MB|GB|k|tests?|archivos?|files?|palabras|words|líneas|lines|pasos|steps|turnos?|comandos?|errores?|warnings?)\b|\b\d[\d.,]*\/\d+\b)/g
  for (const n of todo) {
    const txt = n.textContent ?? ''
    if (!MEAS.test(txt)) continue
    MEAS.lastIndex = 0
    const span = document.createElement('span')
    span.innerHTML = txt.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!).replace(MEAS, '<span class="meas">$1</span>')
    n.replaceWith(...Array.from(span.childNodes))
  }
  return el.innerHTML
}

/** Live-parse the streaming turn: the <say> text so far and which files are closed/open. */
function liveParts(raw: string) {
  const say = raw.match(/<say>([\s\S]*?)(?:<\/say>|$)/)?.[1] ?? ''
  const files = [...raw.matchAll(/<file path="([^"\n]+)"\s*>[\s\S]*?<\/file>/g)].map((m) => m[1])
  const stage = raw.match(/<stage[^>]*>([\s\S]*?)(?:<\/stage>|$)/)?.[1] ?? ''
  const done = raw.match(/<done>([\s\S]*?)(?:<\/done>|$)/)?.[1] ?? ''
  return { say, files, stage, done }
}

export default function Builder({ onBack, onHome }: { onBack: () => void; onHome?: () => void }) {
  const T = useT()
  const b = useBuild()
  const color = BRAND_COLOR[b.provider ?? ''] ?? '#2F6B5D'
  const [input, setInput] = useState('')
  const rec = useRef<Recording | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [applyRounds, setApplyRounds] = useState(2)
  useEffect(() => {  // the rail badge and the Publish notice know what is missing without opening «Servicios»
    if (!b.sessionId || !b.id || !Object.keys(b.files).length || b.status === 'running' || b.status === 'connecting') return
    api.services(b.sessionId, b.id).then((d) => useBuild.getState().set({ servicesMissing: servicesMissing(d) })).catch(() => {})
  }, [b.sessionId, b.id, b.status, b.versions.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const runOpen = b.runOpen
  const setRunOpen = (v: boolean) => useBuild.getState().set({ runOpen: v })
  const [councilOpen, setCouncilOpen] = useState<false | 'launch' | 'edit'>(false)
  const [fdeOpen, setFdeOpen] = useState<string | null>(null)
  useEffect(() => {
    if (b.fdePrefill !== null) { setFdeOpen(b.fdePrefill); useBuild.getState().set({ fdePrefill: null }) }
  }, [b.fdePrefill])
  // seconds since the current turn started (shown while the model hasn't emitted anything yet)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (b.liveTurn == null) return
    setElapsed(0)
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [b.liveTurn])
  const chatRef = useRef<HTMLDivElement>(null)
  const live = useMemo(() => liveParts(b.liveRaw), [b.liveRaw])
  const running = b.status === 'running' || b.status === 'connecting' || b.status === 'reviewing'
  const reviewing = b.status === 'reviewing'

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' })
  }, [b.chat.length, live.say.length, live.files.length])
  // when something below the chat grows (the step log opening, quick requests), keep the latest messages in view
  const atBottom = useRef(true)
  useEffect(() => {
    const el = chatRef.current
    if (!el) return
    const onScroll = () => { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight })
    ro.observe(el)
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect() }
  }, [b.id])


  // fetch a file's content lazily when selected (contents aren't streamed into the tree)
  useEffect(() => {
    const p = b.selected
    if (!p || !b.sessionId || !b.id || b.files[p]?.content !== undefined || (b.liveFile && b.liveFile.path === p)) return
    api.build(b.sessionId, b.id).then((d) => {
      const contents = d.file_contents ?? {}
      useBuild.getState().set({ files: Object.fromEntries(Object.entries(useBuild.getState().files).map(([k, v]) => [k, { ...v, content: contents[k] ?? v.content }])) })
    }).catch(() => {})
  }, [b.selected, b.liveFile?.path, b.chat.length])

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!text || !b.id) return
    if (!preset) setInput('')
    const r = await api.buildMessage(b.id, text, b.sessionId).catch(() => null)
    if (r && (r as { resumed?: boolean }).resumed) {
      useBuild.getState().set({ status: 'connecting', chat: [...useBuild.getState().chat, { role: 'user', text, ts: Date.now() / 1000 }], error: null })
      reconnectBuild(b.id)
    }
  }

  const toggleRecording = async () => {
    if (rec.current) {
      const blob = await rec.current.stop()
      rec.current = null
      useBuild.getState().set({ recording: false })
      downloadBlob(blob, `museteam-construccion-${b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto'}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`)
      return
    }
    try {
      const stream = await requestTabStream(false)
      rec.current = await startRecording(stream, document.querySelector<HTMLElement>('[data-capture="builder"]'))
      useBuild.getState().set({ recording: true })
      rec.current.ended.then(() => rec.current && toggleRecording())
    } catch {
      /* permission declined */
    }
  }

  const openPreviewTab = () => {
    if (!b.previewHtml) return
    const url = URL.createObjectURL(new Blob([b.previewHtml], { type: 'text/html' }))
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const regeneratePreview = async () => {
    if (!b.id) return
    const text = 'Regenerá preview/index.html (vista previa autocontenida del producto terminado) incorporando los últimos cambios.'
    const r = await api.buildMessage(b.id, text, b.sessionId).catch(() => null)
    if (r && (r as { resumed?: boolean }).resumed) {
      useBuild.getState().set({ status: 'connecting', chat: [...useBuild.getState().chat, { role: 'user', text, ts: Date.now() / 1000 }] })
      reconnectBuild(b.id)
    }
  }

  const downloadZip = async () => {
    if (!b.sessionId || !b.id) return
    const blob = await api.buildZip(b.sessionId, b.id)
    downloadBlob(blob, `${b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyecto'}.zip`)
  }

  const shownFile = b.liveFile && b.selected === b.liveFile.path ? b.liveFile.content : b.files[b.selected ?? '']?.content
  const tree = useMemo(() => buildTree(Object.keys(b.files).concat(b.liveFile ? [b.liveFile.path] : [])), [b.files, b.liveFile?.path])
  const codeTheme = useEditorTheme((s) => s.theme)
  const [payingFees, setPayingFees] = useState(false)
  const [stopping, setStopping] = useState(false)
  useEffect(() => { if (!running) setStopping(false) }, [running])  // the stop landed: the button goes back to normal (or away)
  const codeDark = codeTheme.dark
  // the side panel takes ~60% of the row (at least 640px), leaving the chat its minimum; measured so the spring can animate pixels
  const wrapRef = useRef<HTMLDivElement>(null)
  const [wrapW, setWrapW] = useState(0)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth))
    ro.observe(el)
    setWrapW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // expanded: the pane takes the whole row (the chat folds away) so the editor can be worked in full width
  const [paneFull, setPaneFull] = useState(false)
  useEffect(() => {
    if (!paneFull) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPaneFull(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneFull])
  const [treeOpen, setTreeOpen] = useState(false)
  const phone = wrapW > 0 && wrapW < 768  // on a phone a pane takes the whole width (the chat comes back when it closes)
  // a tablet-width window has no room for the chat next to a 560px pane: the pane takes the width there too
  const tight = wrapW > 0 && wrapW - 56 - 560 < 380
  const paneW = wrapW ? (paneFull || phone || tight ? wrapW - (phone ? 48 : 56) : Math.max(560, Math.min(wrapW - 56 - 400, Math.round((wrapW - 56) * 0.6)))) : 760

  return (
    <div className="h-full flex flex-col bg-paper">
      {/* top bar */}
      <div className="relative z-[60] flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-2 backdrop-blur sm:h-16 sm:gap-3 sm:px-4">
        <button onClick={onHome ?? onBack} className="flex shrink-0 items-center rounded-lg transition hover:opacity-80" title={T('Muse Team · ir al inicio', 'Muse Team · go home')}>
          <img src="/icon.svg?v=3" alt="Muse Team" className="h-8 w-8 rounded-xl shadow-sm sm:h-9 sm:w-9" draggable={false} />
        </button>
        <button onClick={onHome ?? onBack} className={`${HBTN} hidden px-3 sm:flex`} title={T('Ir al inicio: tus proyectos y experimentos', 'Go home: your projects and experiments')}><Home size={14} /> {T('Inicio', 'Home')}</button>
        <button onClick={onBack} className={`${HBTN} px-2.5 sm:px-3`} title={T('Volver al consejo de este proyecto', 'Back to this project\u2019s council')} aria-label={T('Consejo', 'Council')}><ArrowLeft size={14} /> <span className="hidden sm:inline">{T('Consejo', 'Council')}</span></button>
        <span className="mx-1 hidden h-7 w-px bg-line sm:block" />
        <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface shadow-sm sm:flex" style={{ border: `1.5px solid ${color}` }}><ProviderLogo provider={b.provider} size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="serif truncate text-[15px] leading-tight sm:text-[17px]" title={b.title}>{b.title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-3">
            <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} /> <span className="font-mono">{b.model}</span></span>
          </div>
        </div>
        <div className="ml-2 hidden shrink-0 items-center gap-2 whitespace-nowrap lg:flex">
          {reviewing ? (
            <span className="flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-[11px] font-bold text-gold"><span className="h-2 w-2 rounded-full bg-gold animate-pulse" /> {b.reviewMode === 'audit' ? T('AUDITANDO', 'AUDITING') : `${T('CONSEJO · ronda', 'COUNCIL · round')} ${b.reviewRound ?? b.reviews.length + 1}`}</span>
          ) : b.status === 'audited' ? (
            <span className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-white">{T('AUDITADO · informe listo', 'AUDITED · report ready')}</span>
          ) : running ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/30 bg-accent-soft px-2.5 py-1 text-[11px] font-bold text-accent"><span className="h-2 w-2 rounded-full bg-accent animate-pulse" /> {b.reviews.length ? T('APLICANDO', 'APPLYING') : T('CONSTRUYENDO', 'BUILDING')}{b.liveTurn ? ` · ${T('turno', 'turn')} ${b.liveTurn}` : ''}</span>
          ) : b.status === 'approved' ? (
            <span className="flex items-center gap-1.5 rounded-full bg-ok px-2.5 py-1 text-[11px] font-bold text-white"><CheckCircle2 size={12} /> {T('APROBADO POR EL CONSEJO', 'APPROVED BY THE COUNCIL')}</span>
          ) : (
            <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${b.status === 'completed' ? 'border-ok/30 bg-ok/10 text-ok' : 'border-line bg-surface-2 text-ink-3'}`}>{b.status === 'completed' ? (b.reviews.length ? T('CAMBIOS LISTOS · pendiente de consejo', 'CHANGES READY · pending council') : <><span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_0_3px_rgba(23,137,106,.18)]" /> {T('LISTO', 'DONE')}</>) : b.status.toUpperCase()}</span>
          )}
          {b.levels && <button onClick={() => useBuild.getState().set({ pane: 'levels', paneOpen: true })} className="transition hover:brightness-95" title={T('Niveles de crecimiento', 'Growth levels')}><LevelBadge level={b.levels.level} pct={b.levels.pct} next={b.levels.next} /></button>}
          {b.feesDue > 0 && (
            <button
              disabled={payingFees}
              onClick={async () => {
                if (!b.sessionId || !b.id) return
                setPayingFees(true)
                try { const o = await api.checkout({ kind: 'fees', build_id: b.id, session_id: b.sessionId }); window.location.href = o.url } catch (e) { toast.error(tr('No se pudo iniciar el pago', 'Could not start the payment'), (e as Error).message); setPayingFees(false) }
              }}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-[11px] font-bold text-gold transition hover:bg-gold/20 disabled:opacity-50"
              title={T('Cargos por uso pendientes de pago (análisis profundo). Se pagan con Stripe.', 'Unpaid per-use charges (deep analysis). Paid through Stripe.')}
            >{payingFees ? <Loader2 size={11} className="animate-spin" /> : <CreditCard size={11} />} USD {b.feesDue.toFixed(2)} {T('a pagar', 'to pay')}</button>
          )}
        </div>
        {/* actions: labels only when there is room; below 2xl the secondary ones are icon buttons with a tooltip */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap sm:gap-2">
          <button onClick={() => setRunOpen(true)} disabled={!Object.keys(b.files).length || (running && b.appRun.status === 'idle' && !b.appRun.fix)} className={HBTN_PRIMARY} title={T('Levanta la app en esta máquina y la muestra acá', 'Starts the app on this machine and shows it here')}><MonitorPlay size={14} /> <span className="hidden sm:inline">{T('Correr la app', 'Run the app')}</span>{b.appRun.status === 'running' ? <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" /> : null}</button>
          <ThemeSwitch className="hidden h-9 sm:flex" />
          <BuilderMenu onDownload={downloadZip} onRecord={toggleRecording} />
        </div>
      </div>
      <DeployWatcher />
      {runOpen && <RunModal onClose={() => setRunOpen(false)} onDownload={downloadZip} />}
      {fdeOpen !== null && <FdeModal onClose={() => setFdeOpen(null)} prefill={fdeOpen ? `${T('Resolver los bloqueantes del consejo:', 'Resolve the council blockers:')}\n${fdeOpen}` : ''} />}
      {b.fdeOrder && <FdeModal onClose={() => useBuild.getState().set({ fdeOrder: null })} prefill={b.fdeOrder.notes} initialPackage={b.fdeOrder.pkg} />}
      {councilOpen && (
        <CouncilLaunch team={b.team} startEditing={councilOpen === 'edit'} onClose={() => setCouncilOpen(false)} onLaunch={async (priorities, rounds, references, deep, focus) => {
          if (!b.id) return
          try {
            const r = await api.buildCouncil(b.id, b.sessionId, rounds, priorities, references, deep, focus)
            if (r.session_id) useBuild.getState().set({ councilSession: r.session_id })
            else {
              // the benchmark runs in the background: open the build socket so its events (references, done, council) arrive
              useBuild.getState().set({ researching: { refs: references, hidden: references.length === 0, started: Date.now(), visited: [], finished: false }, councilSessionsKnown: b.councilSessionsKnown })
              reconnectBuild(b.id)
            }
            setCouncilOpen(false)
          } catch (e) {
            useBuild.getState().set({ error: (e as Error).message })
          }
        }} />
      )}

      <div ref={wrapRef} className="flex min-h-0 flex-1">
        {/* chat */}
        <div className={`flex min-h-0 min-w-0 flex-1 flex-col border-r border-line transition-opacity duration-300 ${(paneFull || phone) && b.paneOpen ? 'pointer-events-none opacity-0' : ''}`}>
          <div
            ref={chatRef}
            className="flex-1 overflow-y-auto scroll-thin space-y-4 px-2.5 py-4 sm:px-5 sm:py-5 [&>*]:mx-auto [&>*]:w-full lg:[&>*]:max-w-[80vw]"
            onClick={(e) => {
              const chip = (e.target as HTMLElement).closest('code[data-path]') as HTMLElement | null
              const path = chip?.getAttribute('data-path')
              if (!path) return
              const hit = b.files[path] ? path : Object.keys(b.files).find((f) => f.endsWith('/' + path) || f === path)
              if (hit) useBuild.getState().set({ selected: hit, pane: 'code', paneOpen: true })
            }}
          >
            <AnimatePresence initial={false}>
              {b.chat.map((c, i) => (c.role === 'review' ? <ReviewRoundCard key={i} round={{ round: c.round!, approved: !!c.approved, results: c.results ?? [], mode: c.mode, ts: c.ts }} team={b.team} /> : <Bubble key={i} c={c} color={color} provider={b.provider} onOpen={(p) => useBuild.getState().set({ selected: p })} />))}
              {reviewing && <LiveReview round={b.reviewRound ?? b.reviews.length + 1} team={b.team} raws={b.liveReviews} audit={b.reviewMode === 'audit'} />}
              {b.liveTurn != null && (
                <motion.div key="live" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
                  <span className="shrink-0 w-8 h-8 rounded-full bg-surface border flex items-center justify-center" style={{ borderColor: `${color}66` }}><ProviderLogo provider={b.provider} size={18} /></span>
                  <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-surface px-3 py-3 sm:px-4">
                    {b.livePhase === 'preview' && <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-1">{T('🖼 Vista previa del producto', '🖼 Product preview')}</div>}
                    {b.livePhase === 'report' && <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-1">{T('📄 Escribiendo el informe de auditoría', '📄 Writing the audit report')}</div>}
                    {b.livePhase === 'design' && <div className="text-[10px] font-bold uppercase tracking-widest text-accent mb-1">{T('🎨 El Product Designer diseña la interfaz (sistema, pantallas, mockup) antes de escribir código', '🎨 The Product Designer designs the interface (system, screens, mockup) before writing code')}</div>}
                    {b.engineSession !== undefined && (b.activity.length > 0 || b.todos.length > 0) && b.livePhase === 'build' && (
                      <LiveActivity activity={b.activity} todos={b.todos} elapsed={elapsed} files={Object.keys(b.files).length} lastEventTs={b.lastEventTs} />
                    )}
                    {live.say ? (
                      <div className={`md text-[14px] ${b.activity.length ? 'mt-3 pt-3 border-t border-line' : ''}`} dangerouslySetInnerHTML={{ __html: md(live.say) }} />
                    ) : b.activity.length > 0 ? null : (
                      <div className="text-sm">
                        <div className="flex items-center gap-2 text-ink">
                          <span className="flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}</span>
                          {b.livePhase === 'preview' ? T('Armando la vista previa del producto', 'Building the product preview') : b.livePhase === 'report' ? T('Consolidando las evaluaciones del equipo', 'Consolidating the team evaluations') : b.liveTurn === 1 ? T('Leyendo el brief y planificando la etapa 1', 'Reading the brief and planning stage 1') : `${T('Preparando el turno', 'Preparing turn')} ${b.liveTurn}`}
                          <span className="font-mono text-[11px] text-ink-3">{elapsed}s</span>
                        </div>
                        <div className="mt-1.5 text-[12px] text-ink-3">{T('Un modelo grande puede tardar 30–90 s antes del primer archivo: escribe cada archivo completo. Los archivos aparecen a la derecha a medida que se cierran.', 'A large model can take 30–90 s before the first file: it writes each file in full. Files appear on the right as they are closed.')}</div>
                      </div>
                    )}
                    {(live.files.length > 0 || b.liveFile) && (
                      <div className="mt-3 space-y-1.5">
                        {live.files.map((p) => <FileChip key={p} path={p} done onOpen={() => useBuild.getState().set({ selected: p })} />)}
                        {b.liveFile && !live.files.includes(b.liveFile.path) && <FileChip path={b.liveFile.path} lines={b.liveFile.content.split('\n').length} onOpen={() => useBuild.getState().set({ selected: b.liveFile!.path })} />}
                      </div>
                    )}
                    {live.stage && <div className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-[13px] md" dangerouslySetInnerHTML={{ __html: md(T('**Etapa cerrada.** ', '**Stage closed.** ') + live.stage) }} />}
                    {live.done && <div className="mt-3 rounded-lg bg-ok/10 px-3 py-2 text-[13px] md" dangerouslySetInnerHTML={{ __html: md(T('🎉 **Producto terminado.** ', '🎉 **Product finished.** ') + live.done) }} />}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {b.error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger font-mono">⚠️ {b.error}</div>}
            {b.status === 'audited' && !b.liveTurn && b.id && (() => {
              const audit = [...b.reviews].reverse().find((r) => r.mode === 'audit')
              const props = (audit?.results ?? []).filter((r) => r.requests?.trim())
              const chosen = props.filter((r) => picked[r.agent_id] ?? true)
              return (
                <div className="rounded-2xl border-2 border-dashed border-accent/40 p-4">
                  <div className="flex items-center gap-2 font-semibold"><Gavel size={18} className="text-accent" /> {T('Aplicar mejoras con el constructor', 'Apply improvements with the builder')}</div>
                  <p className="mt-1 text-[12.5px] text-ink-2">{T('Elegí qué propuestas implementar. El constructor las aplica sobre tu proyecto y el consejo las revisa hasta aprobarlas; después descargás el zip mejorado.', 'Choose which proposals to implement. The builder applies them to your project and the council reviews them until approved; then you download the improved zip.')}</p>
                  <div className="mt-3 space-y-1.5">
                    {props.map((r) => (
                      <label key={r.agent_id} className="flex items-start gap-2 rounded-lg border border-line bg-paper px-2.5 py-2 text-[12.5px]">
                        <input type="checkbox" className="accent-accent mt-0.5" checked={picked[r.agent_id] ?? true} onChange={(e) => setPicked({ ...picked, [r.agent_id]: e.target.checked })} />
                        <span><b>{r.name}</b> <span className="text-ink-3">· {r.role_label}</span><span className="block text-ink-2 whitespace-pre-wrap">{r.requests.slice(0, 400)}{r.requests.length > 400 ? '…' : ''}</span></span>
                      </label>
                    ))}
                    {props.length === 0 && <div className="text-[12.5px] text-ink-3">{T('Ningún rol propuso cambios: el equipo considera que está bien así.', 'No role proposed changes: the team thinks it is fine as is.')}</div>}
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <label className="text-[12px] text-ink-3 flex items-center gap-1.5">{T('rondas de revisión', 'review rounds')}
                      <select value={applyRounds} onChange={(e) => setApplyRounds(Number(e.target.value))} className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink">{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                    </label>
                    <button disabled={!chosen.length} onClick={async () => {
                      await api.buildApply(b.id!, b.sessionId, chosen.map((r) => ({ role_label: r.role_label, name: r.name, text: r.requests })), applyRounds).catch((e) => useBuild.getState().set({ error: (e as Error).message }))
                      useBuild.getState().set({ status: 'connecting', error: null, pane: 'code' })
                      reconnectBuild(b.id!)
                    }} className="ml-auto flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40"><Play size={15} /> {T('Aplicar', 'Apply')} {chosen.length} {chosen.length === 1 ? T('propuesta', 'proposal') : T('propuestas', 'proposals')}</button>
                  </div>
                </div>
              )
            })()}
            {(b.status === 'error' || b.status === 'stopped') && b.id && (
              <div className="rounded-2xl border-2 border-dashed border-gold/50 bg-gold/5 px-4 py-3 text-sm">
                <div className="font-semibold">{b.status === 'error' ? T('La construcción se interrumpió por un error', 'The build was interrupted by an error') : T('Construcción detenida', 'Build stopped')}</div>
                <div className="mt-1 text-[12.5px] text-ink-2">{T('Todo lo escrito está guardado', 'Everything written is saved')} ({Object.keys(b.files).length} {T('archivos', 'files')}, {b.stages.length} {b.stages.length === 1 ? T('etapa cerrada', 'stage closed') : T('etapas cerradas', 'stages closed')}). {T('Al reanudar, el constructor revisa el árbol y sigue desde donde quedó, en este mismo chat.', 'On resume, the builder reviews the tree and continues where it left off, in this same chat.')}</div>
                <button
                  onClick={async () => {
                    await api.buildResume(b.id!, b.sessionId).catch((e) => useBuild.getState().set({ error: (e as Error).message }))
                    useBuild.getState().set({ status: 'connecting', error: null })
                    reconnectBuild(b.id!)
                  }}
                  className="mt-3 flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2 text-sm font-semibold hover:brightness-110"
                >
                  <Play size={15} /> {T('Reanudar construcción', 'Resume build')}
                </button>
              </div>
            )}
            {b.status === 'approved' && (
              <div className="rounded-2xl border-2 border-ok bg-ok/10 px-4 py-3 text-sm flex items-center gap-3">
                <CheckCircle2 className="text-ok shrink-0" size={22} />
                <div><b>{T('Aprobado por el consejo', 'Approved by the council')}</b> {T('en', 'in')} {b.reviews.length} {b.reviews.length === 1 ? T('ronda', 'round') : T('rondas', 'rounds')}: {T('todos los roles dieron el visto bueno para producción. Descargá el .zip final.', 'every role gave the go-ahead for production. Download the final .zip.')}</div>
              </div>
            )}
            {b.status === 'completed' && !b.liveTurn && b.team.length > 0 && (
              <ReviewLauncher team={b.team} onStart={() => setCouncilOpen('launch')} onEdit={() => setCouncilOpen('edit')} />
            )}
            {b.pendingCouncil && !b.liveTurn && (
              <button onClick={() => useArena.getState().set({ pendingLive: b.pendingCouncil! })} className="block w-full rounded-2xl border-2 border-gold bg-gold/10 px-4 py-3 text-left transition hover:brightness-95">
                <div className="flex items-center gap-2 font-semibold"><Gavel size={18} className="text-gold" /> {T('El consejo ya dio su veredicto', 'The council has given its verdict')}{b.versions.length ? ` ${T('sobre', 'on')} v${b.versions.length}` : ''}</div>
                <div className="mt-0.5 text-[12.5px] text-ink-2">{T('Mirá la lista de cambios y decidí si construir con ellos o no →', 'Check the list of changes and decide whether to build with them or not →')}</div>
              </button>
            )}
            {(b.status === 'completed' || b.status === 'approved') && !b.liveTurn && (
              <div>
                <div className="mb-2 text-[10.5px] uppercase tracking-[0.3em] text-ink-3">{T('Qué hacer ahora', 'What to do now')}</div>
                <div className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                  {([
                    { id: 'run', icon: MonitorPlay, title: T('Correr la app', 'Run the app'), text: T('Levantala en esta máquina y vela acá', 'Start it on this machine and see it here'), primary: true, show: true, go: () => setRunOpen(true) },
                    { id: 'preview', icon: Eye, title: T('Prototipo navegable', 'Clickable prototype'), text: T('Sin correr nada, en un clic', 'Without running anything, one click'), primary: false, show: !!b.previewHtml, go: () => useBuild.getState().set({ paneOpen: true, pane: 'preview' }) },
                    { id: 'design', icon: Palette, title: T('Diseño', 'Design'), text: T('Qué tiene y pedile cambios', 'What it has, ask for changes'), primary: false, show: true, go: () => useBuild.getState().set({ paneOpen: true, pane: 'design' }) },
                    { id: 'deploy', icon: KeyRound, title: T('Servicios', 'Services'), text: T('Lo que necesita para cobrar y mandar emails', 'What it needs to take payments and send email'), primary: false, show: true, go: () => useBuild.getState().set({ paneOpen: true, pane: 'deploy' }) },
                    { id: 'fde', icon: HardHat, title: T('Pedir un developer', 'Request a developer'), text: T('Un ingeniero nuestro lo sube por vos', 'One of our engineers ships it for you'), primary: false, show: true, go: () => setFdeOpen('') },
                  ] as const).filter((a) => a.show).map((a) => {
                    const Icon = a.icon
                    return (
                      <motion.button key={a.id} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.985 }} onClick={a.go} className={`group flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-left shadow-[0_10px_24px_-16px_rgba(30,38,34,.45)] transition-colors ${a.primary ? 'border-accent bg-accent text-white' : 'border-line bg-surface hover:border-accent'}`}>
                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${a.primary ? 'bg-white/15 text-white' : 'bg-accent-soft text-accent'}`}><Icon size={19} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold">{a.title}</span>
                          <span className={`block truncate text-[11.5px] ${a.primary ? 'text-white/80' : 'text-ink-3'}`}>{a.text}</span>
                        </span>
                        <ArrowRight size={15} className={`shrink-0 transition group-hover:translate-x-0.5 ${a.primary ? 'text-white/80' : 'text-ink-4 group-hover:text-accent'}`} />
                      </motion.button>
                    )
                  })}
                </div>
              </div>
            )}
            {b.status === 'design_review' && !b.liveTurn && <DesignReviewCard />}
            {b.status === 'completed' && !b.liveTurn && (
              <div className="rounded-2xl border border-ok/30 bg-ok/5 px-4 py-3 text-sm flex items-center gap-3">
                <CheckCircle2 className="text-ok shrink-0" size={20} />
                <div>{T('Construcción terminada:', 'Build finished:')} {Object.keys(b.files).length} {T('archivos. Descargá el .zip, seguí las instrucciones del README y, si querés cambios, escribile al constructor abajo.', 'files. Download the .zip, follow the README instructions and, if you want changes, write to the builder below.')}</div>
              </div>
            )}
            {b.status === 'completed' && !b.liveTurn && Object.keys(b.files).length > 0 && <SavingsCard />}
          </div>
          <div className="border-t border-line bg-surface p-3 [&>*]:mx-auto lg:[&>*]:max-w-[80vw]">
            {/* quick actions: the full visual-polish checklist is one click (the server expands "pulido visual" into it) */}
            {b.id && !running && (
              <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&>*]:shrink-0">
                <span className="mr-1 hidden text-[10px] uppercase tracking-[0.25em] text-ink-3 sm:inline">{T('Pedidos rápidos', 'Quick requests')}</span>
                {([
                  { icon: Sparkles, label: T('Pulido visual', 'Visual polish'), text: 'Pulido visual', tip: T('Pasada de diseño sobre toda la UI: tipografía real, tokens, layout, estados, responsive y accesibilidad, según design/DESIGN.md y el mockup.', 'Design pass over the whole UI: real typography, tokens, layout, states, responsive and accessibility, per design/DESIGN.md and the mockup.'), hot: true },
                  { icon: ShieldCheck, label: T('Accesibilidad', 'Accessibility'), text: tr('Auditá y corregí accesibilidad en toda la UI: contraste AA, foco visible, navegación por teclado, labels y roles ARIA, textos alternativos, tamaños táctiles ≥ 44 px. Verificá con lint/tests y resumí qué cambió.', 'Audit and fix accessibility across the UI: AA contrast, visible focus, keyboard navigation, ARIA labels and roles, alt texts, touch targets ≥ 44 px. Verify with lint/tests and summarise what changed.'), tip: T('Contraste, teclado, ARIA, tamaños táctiles.', 'Contrast, keyboard, ARIA, touch sizes.'), hot: false },
                  { icon: Gauge, label: T('Rendimiento', 'Performance'), text: tr('Optimizá el rendimiento sin cambiar funcionalidad: tamaño del bundle, carga diferida, imágenes, caché, render innecesario. Medí antes y después (Lighthouse o equivalente) y reportá los números.', 'Optimise performance without changing functionality: bundle size, lazy loading, images, caching, unnecessary renders. Measure before and after (Lighthouse or equivalent) and report the numbers.'), tip: T('Bundle, carga, caché, render.', 'Bundle, loading, cache, render.'), hot: false },
                  { icon: FlaskConical, label: T('Más tests', 'More tests'), text: tr('Subí la cobertura de tests en los flujos críticos (happy path y errores), unitarios y e2e, sin tests frágiles. Dejá todo en verde y resumí qué quedó cubierto.', 'Raise test coverage on the critical flows (happy path and errors), unit and e2e, without flaky tests. Leave everything green and summarise what is covered.'), tip: T('Cobertura en los flujos críticos.', 'Coverage on the critical flows.'), hot: false },
                ] as const).map((q) => {
                  const Icon = q.icon
                  return (
                    <button key={q.label} type="button" onClick={() => send(q.text)} title={q.tip} className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium shadow-sm transition ${q.hot ? 'border-accent/40 bg-accent-soft text-accent hover:bg-accent hover:text-white' : 'border-line bg-paper text-ink-2 hover:border-accent hover:text-accent'}`}>
                      <Icon size={13} /> {q.label}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-line bg-paper px-3 py-2 focus-within:border-accent">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                placeholder={running ? T('Pedile un cambio o una aclaración; lo toma en el próximo turno…', 'Ask for a change or a clarification; it picks it up next turn…') : T('Escribile al constructor para seguir (reanuda la construcción)…', 'Write to the builder to continue (resumes the build)…')}
                className="flex-1 resize-none bg-transparent text-sm outline-none"
                disabled={!b.id}
              />
              {running && b.id && (
                <button
                  disabled={stopping}
                  onClick={async () => { setStopping(true); try { await api.buildStop(b.id!) } catch (e) { toast.error(tr('No se pudo detener', 'Could not stop'), (e as Error).message); setStopping(false) } }}
                  className="shrink-0 rounded-xl border border-danger/40 p-2 text-danger transition hover:border-danger hover:bg-danger/10 disabled:opacity-60"
                  title={stopping ? T('Deteniendo la construcción…', 'Stopping the build…') : T('Detener la construcción', 'Stop the build')}
                >{stopping ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} />}</button>
              )}
              <button onClick={() => send()} disabled={!input.trim() || !b.id} className="shrink-0 rounded-xl bg-accent text-white p-2 disabled:opacity-40"><Send size={16} /></button>
            </div>
            {/* what the agent is doing right now, under the box: last action, counters of the turn, elapsed */}
            <AnimatePresence initial={false}>
              {running && <LiveStatusBar key="live" />}
            </AnimatePresence>
          </div>
        </div>

        {/* the side: file tree + the open pane, sliding in and out on a spring */}
        <motion.div initial={false} animate={{ width: b.paneOpen ? paneW : 0 }} transition={{ type: 'spring', stiffness: 230, damping: 30, mass: 0.9 }} className="relative min-h-0 shrink-0 overflow-hidden">
          <div className="absolute inset-y-0 right-0 flex min-h-0" style={{ width: paneW }}>
            {/* file tree: only next to the code, sliding in and out with the same spring */}
            <motion.div initial={false} animate={{ width: b.pane === 'code' && (!phone || treeOpen) ? (phone ? paneW : 232) : 0 }} transition={{ type: 'spring', stiffness: 230, damping: 30, mass: 0.9 }} className="min-h-0 shrink-0 overflow-hidden border-r border-line bg-surface">
              <div className="h-full overflow-y-auto scroll-thin" style={{ width: phone ? paneW : 232 }}>
                <div className="sticky top-0 flex items-center border-b border-line bg-surface px-3 py-2 text-[11px] uppercase tracking-widest text-ink-3">
                  {T('Archivos', 'Files')}
                  {phone && <button type="button" onClick={() => setTreeOpen(false)} className="ml-auto flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] normal-case tracking-normal text-ink" aria-label={T('Cerrar la lista de archivos', 'Close the file list')}><X size={12} /> {T('Cerrar', 'Close')}</button>}
                </div>
                <div className="py-1 font-mono text-[13px]">
                  {tree.length === 0 && <div className="px-3 py-3 font-sans text-xs text-ink-4">{T('Todavía no hay archivos.', 'No files yet.')}</div>}
                  {tree.map((n) => <TreeNode key={n.path} node={n} depth={0} selected={b.selected} live={b.liveFile?.path ?? null} onSelect={(p) => { useBuild.getState().set({ selected: p }); setTreeOpen(false) }} />)}
                </div>
              </div>
            </motion.div>

            {/* the pane */}
            <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${b.pane !== 'code' ? 'bg-paper' : ''}`} style={b.pane === 'code' ? { background: codeTheme.bg } : undefined}>
              <div className={`flex h-10 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-3 text-[12px] ${b.pane !== 'code' ? 'border-line bg-surface' : codeDark ? 'border-white/10 text-[#B9C4BE]' : 'border-black/10 bg-black/[0.03] text-ink-2'}`}>
                {phone && b.pane === 'code' && <button type="button" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen} className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 ${codeDark ? 'border-white/15 text-white' : 'border-line text-ink'}`}><Folder size={12} /> {T('Archivos', 'Files')}</button>}
                {(() => { const cur = PANES.find((x) => x.id === b.pane); const Icon = cur?.icon ?? FileCode2; return <span className={`flex items-center gap-1.5 font-semibold ${b.pane === 'code' ? (codeDark ? 'text-white' : 'text-ink') : 'text-ink'}`}><Icon size={14} className={b.pane === 'code' && codeDark ? 'text-[#8FD3B0]' : 'text-accent'} /> {cur ? T(cur.es, cur.en) : ''}</span> })()}
                {b.pane === 'code' ? (
                  <span className="ml-auto text-[11px] opacity-70">{running ? T('solo lectura mientras el constructor escribe', 'read-only while the builder writes') : T('editá y guardá con ⌘S: el constructor sigue desde tu versión', 'edit and save with ⌘S: the builder continues from your version')}</span>
                ) : b.pane === 'cloud' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('hosting, base de datos, git y migración', 'hosting, database, git and migration')}</span>
                ) : b.pane === 'levels' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('qué nivel tiene el proyecto, qué falta para el siguiente, analytics y marketplace', 'the project level, what the next one needs, analytics and marketplace')}</span>
                ) : b.pane === 'ads' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('videos para Reels, Stories y feed, y su publicación en Meta Ads', 'videos for Reels, Stories and feed, and publishing them on Meta Ads')}</span>
                ) : b.pane === 'deploy' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('lo que tu app necesita para cobrar, mandar emails y más', 'what your app needs to take payments, send email and more')}</span>
                ) : b.pane === 'app' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('corre en esta máquina, sin deploy', 'runs on this machine, no deploy')}</span>
                ) : b.pane === 'versions' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('qué cambió en cada iteración y qué tan lista está', 'what changed in each iteration and how ready it is')}</span>
                ) : b.pane === 'design' ? (
                  <span className="ml-auto text-[11px] text-ink-3 max-md:hidden">{T('qué tiene el diseño y pedidos al diseñador', 'what the design has and requests to the designer')}</span>
                ) : b.pane === 'report' ? (
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={() => b.auditReport && downloadBlob(new Blob([b.auditReport], { type: 'text/markdown' }), `informe-auditoria-${b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`)} className={PBTN}><Download size={12} /> {T('descargar .md', 'download .md')}</button>
                  </div>
                ) : (
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={regeneratePreview} disabled={running} className={PBTN} title={T('Vuelve a generar el prototipo con los últimos cambios', 'Regenerates the prototype with the latest changes')}><RefreshCw size={12} /> {T('regenerar', 'regenerate')}</button>
                    <button onClick={openPreviewTab} className={PBTN}><ExternalLink size={12} /> {T('abrir en pestaña', 'open in tab')}</button>
                  </div>
                )}
                <button onClick={() => setPaneFull((v) => !v)} title={paneFull ? T('Volver al panel normal (Esc)', 'Back to the normal panel (Esc)') : T('Expandir a toda la pantalla', 'Expand to the full screen')} className={`ml-1 shrink-0 rounded-md p-1 transition ${paneFull ? 'bg-accent text-white hover:brightness-110' : b.pane === 'code' && codeDark ? 'text-[#B9C4BE] hover:bg-white/10 hover:text-white' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}>{paneFull ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
                <button onClick={() => { setPaneFull(false); useBuild.getState().set({ paneOpen: false }) }} title={T('Cerrar el panel', 'Close the panel')} className={`shrink-0 rounded-md p-1 transition ${b.pane === 'code' && codeDark ? 'text-[#B9C4BE] hover:bg-white/10 hover:text-white' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}><PanelRightClose size={14} /></button>
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={b.pane} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.18, ease: 'easeOut' }} className="flex min-h-0 flex-1 flex-col">
          {b.pane === 'design' ? (
                <DesignPanel />
              ) : b.pane === 'versions' ? (
                <VersionsPanel />
              ) : b.pane === 'app' ? (
                <AppRunner />
              ) : b.pane === 'cloud' ? (
                <CloudPanel />
              ) : b.pane === 'levels' ? (
                <LevelsPanel />
              ) : b.pane === 'ads' ? (
                <AdsPanel />
              ) : b.pane === 'deploy' ? (
                <ServicesDeploy onOpenSettings={() => { useArena.getState().set({ view: 'settings' }) }} />
              ) : b.pane === 'report' && b.auditReport ? (
                <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-5 sm:px-8 sm:py-6 bg-surface"><article className="md" dangerouslySetInnerHTML={{ __html: md(b.auditReport) }} /></div>
              ) : b.pane === 'preview' && b.previewHtml ? (
                <div className="flex-1 min-h-0 p-3">
                  <div className="h-full rounded-xl border border-line bg-surface overflow-hidden shadow-sm">
                    <div className="flex items-center gap-1.5 px-3 h-7 border-b border-line bg-surface-2/70"><span className="w-2 h-2 rounded-full bg-[#E6A19A]" /><span className="w-2 h-2 rounded-full bg-[#E9C97A]" /><span className="w-2 h-2 rounded-full bg-[#9FCDA8]" /><span className="ml-2 text-[10px] font-mono text-ink-3">preview/index.html · {T('prototipo navegable del producto', 'clickable prototype of the product')}</span></div>
                    <iframe title={T('Vista previa del producto', 'Product preview')} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={b.previewHtml} className="w-full h-[calc(100%-28px)] bg-white" />
                  </div>
                </div>
              ) : (
                shownFile !== undefined && b.selected ? (
                  <CodeEditor
                    path={b.selected}
                    content={shownFile}
                    live={!!b.liveFile && b.selected === b.liveFile.path}
                    readOnly={running}
                    onSave={async (content) => {
                      if (!b.sessionId || !b.id || !b.selected) return
                      try {
                        const r = await api.saveFile(b.sessionId, b.id, b.selected, content)
                        useBuild.getState().set({ files: { ...useBuild.getState().files, [r.path]: { ...useBuild.getState().files[r.path], size: r.size, lines: r.lines, content } } })
                        toast.ok(tr('Archivo guardado', 'File saved'), r.path)
                      } catch (e) {
                        toast.error(tr('No se pudo guardar', 'Could not save'), (e as Error).message)
                        throw e
                      }
                    }}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center p-8 text-center text-sm" style={{ color: codeTheme.dark ? '#7F8C86' : '#6B7A72' }}>{b.selected ? T('cargando…', 'loading…') : T('Elegí un archivo del árbol o esperá a que el constructor empiece a escribir.', 'Pick a file from the tree or wait for the builder to start writing.')}</div>
                )
              )}
                    </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </motion.div>

        {/* the rail: one tab per pane, always visible; the active one closes the panel again */}
        <div className="flex min-h-0 w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-l border-line bg-surface py-2 sm:w-14">
          {PANES.filter((x) => x.id !== 'report' || b.auditReport || b.mode === 'audit').map((x) => {
            const Icon = x.icon
            const disabled = x.off(b)
            const active = b.paneOpen && b.pane === x.id
            return (
              <motion.button
                key={x.id}
                disabled={disabled}
                whileHover={disabled ? undefined : { y: -2 }}
                whileTap={disabled ? undefined : { scale: 0.94 }}
                onClick={() => useBuild.getState().set(active ? { paneOpen: false } : { paneOpen: true, pane: x.id })}
                className={`group relative flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-xl transition-colors disabled:opacity-30 ${active ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_rgba(47,107,93,.25)]' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}
              >
                <Icon size={17} />
                <span className="text-[8px] leading-none">{T(x.es, x.en).split(' ')[0]}</span>
                {x.id === 'app' && b.appRun.status === 'running' && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-ok animate-pulse" />}
                {x.id === 'deploy' && !!b.servicesMissing?.count && <span className="absolute -right-0.5 -top-0.5 rounded-full border border-surface bg-gold px-1 text-[8px] font-bold leading-[13px] text-white" title={T('Servicios que faltan', 'Missing services')}>{b.servicesMissing.count}</span>}
                {x.id === 'versions' && b.versions.length > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full border border-surface bg-accent px-1 text-[8px] font-bold leading-[13px] text-white">{b.versions.length}</span>}
                <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-medium normal-case text-paper opacity-0 shadow-lg transition group-hover:opacity-100">{T(x.es, x.en)}{disabled ? ` · ${T('todavía no', 'not yet')}` : ''}</span>
              </motion.button>
            )
          })}
          <motion.button whileHover={{ y: -2 }} whileTap={{ scale: 0.94 }} onClick={() => useBuild.getState().set({ paneOpen: !b.paneOpen })} title={b.paneOpen ? T('Cerrar el panel', 'Close the panel') : T('Abrir el panel', 'Open the panel')} className="mt-auto flex h-11 w-11 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink">
            <motion.span animate={{ rotate: b.paneOpen ? 180 : 0 }} transition={{ type: 'spring', stiffness: 300, damping: 24 }} className="flex"><ChevronLeft size={16} /></motion.span>
          </motion.button>
        </div>
      </div>
    </div>
  )
}

/** The live strip under the chat box: the agent's current action with its path, this turn's counters and the clock. */
/** The language the team speaks on this project: a build started in Spanish can switch to English (and back). It applies
 *  from the next builder turn and the next council round; what was already written stays as it is. */
/** While the app deploys on Railway: polls its record and tells the user when it is live (or failed), panel open or not. */
function DeployWatcher() {
  const T = useT()
  const deploying = useBuild((s) => s.cloudApp?.status === 'deploying')
  const ids = useBuild((s) => (s.sessionId && s.id ? `${s.sessionId}~${s.id}` : null))
  useEffect(() => {
    if (!deploying || !ids) return
    const [sid, bid] = ids.split('~')
    const tick = () => api.cloud(sid, bid).then((d) => {
      const st = useBuild.getState()
      if (st.id !== bid) return
      st.set({ cloudApp: d.app })
      if (d.app?.status === 'live' && d.app.url) {
        const url = d.app.url
        toast.ok(T('Tu app está en línea', 'Your app is live'), url, { label: T('Abrir', 'Open'), onClick: () => window.open(url, '_blank', 'noopener') })
      } else if (d.app?.status === 'error') {
        toast.error(T('El despliegue falló', 'The deploy failed'), d.app.error ?? '')
      }
    }).catch(() => {})
    const t = window.setInterval(tick, 8000)
    return () => window.clearInterval(t)
  }, [deploying, ids]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

/** The secondary actions of the builder, folded in one menu so the header stays clean. */
function BuilderMenu({ onDownload, onRecord }: { onDownload: () => void; onRecord: () => void }) {
  const T = useT()
  const b = useBuild()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  const item = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-ink disabled:opacity-40'
  const act = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className={`${HBTN} px-2.5 ${open ? 'border-accent text-accent' : ''}`} title={T('Más opciones', 'More options')} aria-label={T('Más opciones', 'More options')} aria-expanded={open}>
        {b.recording ? <Circle size={14} className="fill-danger text-danger animate-pulse" /> : <Menu size={16} />}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[290px] rounded-2xl border border-line bg-surface p-2 shadow-[0_20px_50px_-20px_rgba(30,38,34,.45)]">
          {b.id && <button className={item} onClick={act(() => openTeam())}><Users size={15} /> {T('Mi equipo', 'My team')}</button>}
          {b.id && b.sessionId && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-[13px] text-ink-2"><span className="flex items-center gap-2.5"><Languages size={15} /> {T('Idioma del equipo', 'Team language')}</span><TeamLanguage /></div>
          )}
          <div className="my-1 h-px bg-line" />
          <button className={item} onClick={act(onDownload)} disabled={!Object.keys(b.files).length}><Download size={15} /> {T('Descargar .zip', 'Download .zip')}</button>
          <button className={`${item} ${b.recording ? 'text-danger hover:text-danger' : ''}`} onClick={act(onRecord)}><Circle size={15} className={b.recording ? 'fill-danger' : ''} /> {b.recording ? T('Guardar el video', 'Save the video') : T('Grabar la pantalla en video', 'Record the screen as video')}</button>
          {b.engineSession && b.workdir && (
            <button className={item} onClick={act(() => { navigator.clipboard?.writeText(`cd "${b.workdir}" && muse --resume ${b.engineSession}`); toast.ok(tr('Comando copiado', 'Command copied'), tr('Pegalo en tu terminal para abrir esta misma sesión en tu Muse Code.', 'Paste it in your terminal to open this same session in your Muse Code.')) })}>
              <TerminalSquare size={15} /> {T('Abrir en mi Muse Code', 'Open in my Muse Code')} <Copy size={11} className="ml-auto opacity-60" />
            </button>
          )}
          {(b.versions.length > 0 || b.buildSeconds > 0 || b.reviews.length > 0) && (
            <>
              <div className="my-1 h-px bg-line" />
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11.5px] text-ink-3">
                {b.versions.length > 0 && <ReadinessBadge versions={b.versions} />}
                {b.buildSeconds > 0 && <span className="flex items-center gap-1 font-mono"><Clock3 size={11} /> {fmtDur(b.buildSeconds)}</span>}
                {b.reviews.length > 0 && <span>{b.reviews.length} {b.reviews.length === 1 ? T('ronda de revisión', 'review round') : T('rondas de revisión', 'review rounds')}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TeamLanguage() {
  const T = useT()
  const b = useBuild()
  const [busy, setBusy] = useState(false)
  const code = /^(en|ingl)/i.test(b.language ?? '') ? 'en' : 'es'
  const pick = async (to: 'es' | 'en') => {
    if (to === code || busy || !b.sessionId || !b.id) return
    setBusy(true)
    try {
      const r = await api.setBuildLanguage(b.sessionId, b.id, to === 'en' ? 'English' : 'español rioplatense')
      useBuild.getState().set({ language: r.language })
      toast.ok(T('Idioma del equipo cambiado', 'Team language changed'), to === 'en' ? T('El equipo habla en inglés desde el próximo turno y la próxima ronda del consejo.', 'The team speaks English from the next turn and the next council round.') : T('El equipo habla en español desde el próximo turno y la próxima ronda del consejo.', 'The team speaks Spanish from the next turn and the next council round.'))
    } catch (e) {
      toast.error(T('No se pudo cambiar el idioma', 'Could not change the language'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <span className="flex items-center gap-1 whitespace-nowrap" title={T('Idioma en el que habla el equipo (constructor y consejo)', 'Language the team speaks (builder and council)')}>
        <span role="group" aria-label={T('Idioma del equipo', 'Team language')} className={`flex overflow-hidden rounded-full border border-line ${busy ? 'opacity-50' : ''}`}>
          {(['es', 'en'] as const).map((l) => (
            <button key={l} type="button" onClick={() => void pick(l)} aria-pressed={code === l} className={`px-1.5 py-px font-mono text-[10.5px] uppercase transition ${code === l ? 'bg-accent text-white' : 'text-ink-3 hover:text-accent'}`}>{l}</button>
          ))}
        </span>
      </span>
    </>
  )
}

/** What this build used and saved, all measured: tokens (API calls + the CLI agent's own session logs), wall-clock,
 *  and at official list prices what the agent's work is worth (covered by the subscription) and what the cache saved. */
function SavingsCard() {
  const T = useT()
  const b = useBuild()
  const [open, setOpen] = useState(false)
  const u = b.usage
  if (!u || !u.total) return null
  const engine = b.provider === 'claude-code' || b.provider === 'codex' || b.provider === 'muse-code'
  const name = b.provider === 'claude-code' ? 'Claude Code' : b.provider === 'codex' ? 'Codex' : 'Muse Code'
  const paid = (u.api_cost_usd ?? 0) + (b.fees || 0)
  const credits = engine ? u.engine_value_usd ?? 0 : 0  // API credits not spent: the agent ran on the subscription
  const cache = u.cache_saved_usd ?? 0
  const saved = credits + cache
  const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
  const usd = (n: number) => `$${n.toFixed(2)}`
  const read = u.input + u.cache_write + (u.unsplit ?? 0)
  const pct = u.total ? Math.round((100 * u.cache_read) / u.total) : 0
  const Cell = ({ l, v, sub, hot }: { l: string; v: string; sub: string; hot?: boolean }) => (
    <div className={`min-w-0 rounded-xl border px-3 py-2 ${hot ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface'}`}>
      <div className={`text-[10.5px] uppercase tracking-[0.2em] ${hot ? 'text-accent' : 'text-ink-3'}`}>{l}</div>
      <div className="font-mono text-[18px] leading-tight text-ink">{v}</div>
      <div className="text-[11px] leading-snug text-ink-3">{sub}</div>
    </div>
  )
  return (
    <div className="rounded-2xl border border-accent/25 bg-accent-soft/40 px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="shrink-0 text-accent" />
        <div className="font-semibold">{saved > 0 ? T('Lo que te ahorró Muse Team en esta construcción', 'What Muse Team saved you on this build') : T('Lo que usó esta construcción', 'What this build used')}</div>
        {saved > 0 && <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-white">{usd(saved)} {T('ahorrados', 'saved')}</span>}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {engine && <Cell hot l={T('Créditos de API ahorrados', 'API credits saved')} v={usd(credits)} sub={T(`Lo que costaría el trabajo de ${name} a precio de lista; lo cubrió tu suscripción`, `What ${name}'s work costs at list price; your subscription covered it`)} />}
        <Cell hot l={T('Ahorro de la caché', 'Saved by the cache')} v={usd(cache)} sub={T(`${fmtTok(u.cache_read)} tokens (${pct}%) salieron de la caché en lugar de procesarse de nuevo`, `${fmtTok(u.cache_read)} tokens (${pct}%) came from the cache instead of being processed again`)} />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Cell l={T('Tokens', 'Tokens')} v={fmtTok(u.total)} sub={`${fmtTok(u.output)} ${T('escritos', 'written')} · ${fmtTok(u.cache_read)} ${T('de caché', 'from cache')} · ${fmtTok(read)} ${T('leídos', 'read')}`} />
        <Cell l={T('Tiempo', 'Time')} v={fmtDur(Math.round(b.buildSeconds))} sub={`${b.turns} ${T('turnos del constructor', 'builder turns')}`} />
        <Cell l={T('Pagaste', 'You paid')} v={usd(engine ? paid : b.cost + (b.fees || 0))} sub={engine ? T('llamadas a tus API keys y cargos por uso', 'calls on your API keys and usage fees') : T('cobrado a tus API keys', 'charged to your API keys')} />
      </div>
      {!u.measured && <p className="mt-2 text-[11.5px] text-gold">{T('No están los registros de Muse Code de esta carpeta: los tokens del constructor no se pudieron contar, solo los de las llamadas a la API.', "Muse Code's logs for this folder are missing: the builder's tokens could not be counted, only the API calls'.")}</p>}
      <button onClick={() => setOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-ink"><ChevronDown size={12} className={`transition ${open ? 'rotate-180' : ''}`} /> {T('De dónde salen', 'Where they come from')}</button>
      {open && (
        <p className="mt-1 text-[11.5px] leading-snug text-ink-3">
          {T(`Todo medido, nada estimado. Tokens: los que informa cada llamada a la API (diseño, consejo) más los que ${name} registra en sus logs de sesión para esta carpeta${u.models?.length ? ` (${u.models.join(', ')})` : ''}. Los montos usan el precio de lista oficial de cada modelo. Créditos ahorrados: esos tokens a precio de API, que no pagaste porque corrieron con tu suscripción. Caché: cada token leído de la caché cobrado como entrada normal, menos su precio de lectura de caché. Tiempo: el reloj real de los turnos.`,
            `All measured, nothing estimated. Tokens: what every API call reports (design, council) plus what ${name} records in its session logs for this folder${u.models?.length ? ` (${u.models.join(', ')})` : ''}. Amounts use each model's official list price. Credits saved: those tokens at API price, which you did not pay because they ran on your subscription. Cache: every token read from the cache billed as normal input, minus its cache-read price. Time: the real clock of the turns.`)}
        </p>
      )}
    </div>
  )
}

function LiveStatusBar() {
  const T = useT()
  const b = useBuild()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const acts = b.activity
  const last = acts[acts.length - 1]
  const counts = acts.reduce((c, a) => { c[a.kind] = (c[a.kind] ?? 0) + 1; return c }, {} as Record<string, number>)
  const started = b.turnStartedAt ?? (acts[0]?.ts ? acts[0].ts * (acts[0].ts < 1e12 ? 1000 : 1) : now)
  const el = Math.max(0, Math.round((now - started) / 1000))
  const clock = fmtDur(el)
  const total = fmtDur(b.buildSeconds + el)
  const ICON: Record<string, typeof Search> = { read: FileText, write: FileCode2, edit: FileCode2, search: Search, run: TerminalSquare, test: FlaskConical, install: Download, build: HardHat, git: GitBranch, plan: ListChecks, think: Eye }
  const Icon = (last && ICON[last.kind]) || Loader2
  const phase = b.livePhase === 'research' ? T('investigando referentes', 'researching references') : b.livePhase === 'design' ? T('diseñando', 'designing') : b.livePhase === 'preview' ? T('armando la vista previa', 'building the preview') : b.livePhase === 'report' ? T('escribiendo el informe', 'writing the report') : T('construyendo', 'building')
  const chips: [string, number | undefined][] = [[T('leídos', 'read'), counts.read], [T('escritos', 'written'), (counts.write ?? 0) + (counts.edit ?? 0) || undefined], [T('comandos', 'commands'), counts.run], [T('tests', 'tests'), counts.test]]
  const [open, setOpen] = useState(false)
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} className="relative mt-2">
      {/* the step log, opening upward from the bar */}
      <AnimatePresence>
        {open && acts.length > 0 && (
          // in the flow (not floating): opening it takes its own room and pushes the chat up instead of covering it
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mb-2 max-h-64 overflow-y-auto scroll-thin rounded-xl border border-line bg-[#1E2622] p-3 font-mono text-[11.5px] text-[#E6ECE8]">
              {acts.slice(-14).reverse().map((a, i) => {
                const I = ICON[a.kind] ?? Search
                return <div key={`${a.ts}-${i}`} className={`flex items-center gap-2 ${i ? 'opacity-70' : ''}`}><span className="text-[#5E6B65]">{new Date(a.ts * (a.ts < 1e12 ? 1000 : 1)).toLocaleTimeString()}</span><I size={11} className="shrink-0 text-[#8FD3B0]" /><span className="truncate">{srv(a.label)}</span>{a.path && <span className="truncate text-[#7F8C86]">{a.path}</span>}</div>
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button type="button" onClick={() => setOpen((v) => !v)} title={open ? T('Ocultar los pasos', 'Hide the steps') : T('Ver los últimos pasos', 'See the last steps')} className="relative flex w-full items-center gap-2.5 overflow-hidden rounded-xl bg-accent px-3.5 py-2.5 text-left text-[12.5px] text-white shadow-[0_10px_28px_-12px_rgba(47,107,93,.75),0_0_0_1px_rgba(47,107,93,.35)] transition hover:brightness-110">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/15 to-transparent animate-[shimmer_2.2s_ease-in-out_infinite]" />
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/20 text-white"><Icon size={12} className={last ? '' : 'animate-spin'} /><span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#9FE1C3] ring-2 ring-accent animate-pulse" /></span>
      <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.2em] text-white">{phase}{b.liveTurn ? ` · ${T('turno', 'turn')} ${b.liveTurn}` : ''}</span>
      <span className="h-3.5 w-px shrink-0 bg-white/30" />
      <span className="min-w-0 flex-1 truncate">
        {b.thinking && !last ? <span className="italic text-white/80">{T('pensando…', 'thinking…')}</span> : last ? <><span className="text-white">{srv(last.label)}</span>{last.path && <span className="ml-1.5 font-mono text-[11px] text-white/70">{last.path}</span>}</> : <span className="text-white/80">{T('arrancando…', 'starting…')}</span>}
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
        {chips.filter(([, n]) => n).map(([l, n]) => <span key={l} className="rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] text-white/85"><b className="text-white">{n}</b> {l}</span>)}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-white/90" title={T('Este turno · total de la construcción', 'This turn · whole build')}>{clock} <span className="text-white/55">· Σ {total}</span></span>
      <ChevronDown size={13} className={`shrink-0 text-white/80 transition ${open ? '' : 'rotate-180'}`} />
      </button>
    </motion.div>
  )
}

const NOTICE_BTN = 'flex h-9 items-center justify-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110'

/** What Muse Team is doing with the app (an error found, being fixed, fixed, needs you): a card the user can't miss, with «Ver la app». */
function AppNotice({ c }: { c: ChatItem }) {
  const T = useT()
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const check = !!c.checks
  // one click: the builder gets what the delivery check finds missing right now and completes it
  const completeDelivery = async () => {
    const b = useBuild.getState()
    if (!b.id) return
    setBusy(true)
    const text = T('Completá lo que falta de la entrega', 'Complete what the delivery is missing')
    const r = await api.buildMessage(b.id, text, b.sessionId).catch(() => null)
    if (r && (r as { resumed?: boolean }).resumed) {
      useBuild.getState().set({ status: 'connecting', chat: [...useBuild.getState().chat, { role: 'user', text, ts: Date.now() / 1000 }], error: null })
      reconnectBuild(b.id)
    }
    setBusy(false)
  }
  const tone = c.tone === 'done' ? { box: 'border-ok/40 bg-ok/10', icon: <CheckCircle2 size={18} className="text-ok" />, label: check ? T('Entrega verificada', 'Delivery verified') : T('Arreglado', 'Fixed') }
    : c.tone === 'attention' ? { box: 'border-gold/50 bg-gold/10', icon: <AlertTriangle size={18} className="text-gold" />, label: check ? T('Verificación de entrega', 'Delivery check') : T('Necesita tu atención', 'Needs your attention') }
    : { box: 'border-accent/40 bg-accent-soft/60', icon: <Loader2 size={18} className="animate-spin text-accent" />, label: check ? T('Completando la entrega', 'Completing the delivery') : T('Arreglando la app', 'Fixing the app') }
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`mx-auto flex w-full max-w-3xl flex-wrap gap-3 rounded-2xl border-2 px-4 py-3 ${tone.box}`}>
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <div className="min-w-[min(100%,220px)] flex-1 basis-[220px]">
        <div className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-ink-3">Muse Team · {tone.label}</div>
        <div className="mt-0.5 text-[14.5px] font-medium text-ink">{c.text}</div>
        {c.checks && c.checks.length > 0 && (
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {c.checks.map((k) => (
              <li key={k.label} className="flex items-start gap-1.5 text-[13px] text-ink-2">
                {k.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-gold" />}
                <span>{k.label}</span>
              </li>
            ))}
          </ul>
        )}
        {c.detail && (more
          ? <div className="mt-1.5 break-words rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] text-ink-3">{c.detail}</div>
          : <button onClick={() => setMore(true)} className="mt-1 text-[11.5px] text-ink-3 underline-offset-2 hover:underline">{T('Ver el detalle técnico', 'See the technical detail')}</button>)}
      </div>
      {(c.run || c.link || c.go || (c.checks && c.tone === 'attention')) && (
        <div className="flex w-full shrink-0 flex-wrap items-stretch gap-1.5 self-center pl-9 sm:w-auto sm:flex-col sm:pl-0">
          {c.checks && c.tone === 'attention' && <button onClick={completeDelivery} disabled={busy} className={NOTICE_BTN}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} {T('Completar lo que falta', 'Complete what is missing')}</button>}
          {c.link && <a href={c.link.url} target="_blank" rel="noreferrer" className={NOTICE_BTN}><ExternalLink size={13} /> {c.link.label}</a>}
          {c.go && <button onClick={() => useBuild.getState().set({ paneOpen: true, pane: c.go! })} className={NOTICE_BTN}><CloudUpload size={13} /> {c.go === 'cloud' ? T('Ir a Publicar', 'Go to Publish') : T('Abrir', 'Open')}</button>}
          {c.run && <button onClick={() => useBuild.getState().set({ runOpen: true })} className={NOTICE_BTN}><MonitorPlay size={13} /> {T('Ver la app', 'See the app')}</button>}
        </div>
      )}
    </motion.div>
  )
}

function Bubble({ c, color, provider, onOpen }: { c: ChatItem; color: string; provider: string | null; onOpen: (p: string) => void }) {
  const T = useT()
  if (c.role === 'system' && c.tone) return <AppNotice c={c} />
  if (c.role === 'system') {
    return <div className="text-center text-[12px] text-ink-3"><span className="rounded-full bg-surface-2 border border-line px-3 py-1">{c.text}</span></div>
  }
  if (c.role === 'report') {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border-2 border-accent bg-accent-soft/40 p-4">
        <div className="flex items-center gap-2 font-semibold"><FileText size={18} className="text-accent" /> {T('Informe de auditoría listo', 'Audit report ready')}</div>
        <div className="mt-1 text-[12.5px] text-ink-2">{(c.text ?? '').split('\n').find((l) => l.startsWith('>'))?.replace(/^>\s*/, '') || T('Abrilo en la pestaña Informe (derecha) o descargalo como .md.', 'Open it in the Report tab (right) or download it as .md.')}</div>
        <button onClick={() => useBuild.getState().set({ paneOpen: true, pane: 'report' })} className="mt-2 text-sm font-semibold text-accent hover:underline">{T('Ver informe completo →', 'See full report →')}</button>
      </motion.div>
    )
  }
  if (c.role === 'user') {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-accent text-white px-4 py-2.5 text-[14px] whitespace-pre-wrap">{c.text}</div>
      </motion.div>
    )
  }
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
      <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-surface sm:flex" style={{ borderColor: `${color}66` }}><ProviderLogo provider={provider} size={18} /></span>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-surface border border-line px-4 py-3">
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-ink-4">{T('turno', 'turn')} {c.turn}{c.phase === 'preview' ? T(' · 🖼 vista previa del producto', ' · 🖼 product preview') : c.phase === 'design' ? T(' · 🎨 diseño de la interfaz', ' · 🎨 interface design') : ''}{c.seconds != null && <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-1.5 py-[1px] text-ink-3" title={T('Duración del turno', 'Turn duration')}><Clock3 size={9} /> {fmtDur(c.seconds)}</span>}</div>
        {c.activity && (c.activity.written + c.activity.edited + c.activity.commands + c.activity.tests > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
            {c.activity.written > 0 && <span className="rounded-full bg-ok/10 text-ok px-2 py-0.5">✍️ {c.activity.written} {c.activity.written === 1 ? T('archivo nuevo', 'new file') : T('archivos nuevos', 'new files')}</span>}
            {c.activity.edited > 0 && <span className="rounded-full bg-accent-soft text-accent px-2 py-0.5">✏️ {c.activity.edited} {c.activity.edited === 1 ? T('edición', 'edit') : T('ediciones', 'edits')}</span>}
            {c.activity.tests > 0 && <span className="rounded-full bg-gold/15 text-gold px-2 py-0.5">🧪 tests ×{c.activity.tests}</span>}
            {c.activity.commands > 0 && <span className="rounded-full bg-surface-2 text-ink-2 px-2 py-0.5">⚙️ {c.activity.commands} {c.activity.commands === 1 ? T('comando', 'command') : T('comandos', 'commands')}</span>}
          </div>
        )}
        {c.say && <div className="md text-[14px]" dangerouslySetInnerHTML={{ __html: md(c.say) }} />}
        {!!c.files?.length && c.files.length <= 8 && <div className="mt-3 space-y-1.5">{c.files.map((p) => <FileChip key={p} path={p} done onOpen={() => onOpen(p)} />)}</div>}
        {!!c.files?.length && c.files.length > 8 && <ManyFiles files={c.files} onOpen={onOpen} />}
        {c.stage && <div className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-[13px] md" dangerouslySetInnerHTML={{ __html: md(`**${T('Etapa', 'Stage')} ${c.stage.n} ${T('cerrada.', 'closed.')}** ${c.stage.text}`) }} />}
        {c.done && <div className="mt-3 rounded-lg bg-ok/10 px-3 py-2 text-[13px] md" dangerouslySetInnerHTML={{ __html: md(T('🎉 **Producto terminado.** ', '🎉 **Product finished.** ') + c.done) }} />}
      </div>
    </motion.div>
  )
}


/** What the local agent is doing, as cards: current step, its plan, the files it touched, the last steps, and a live thumbnail. */
function LiveActivity({ activity, todos, elapsed, files, lastEventTs }: { activity: Activity[]; todos: Todo[]; elapsed: number; files: number; lastEventTs: number; thinking?: string; previewHtml?: string | null }) {
  const T = useT()
  const [showPlan, setShowPlan] = useState(false)
  // heartbeat: seconds since the agent last said/did anything (so a long tool call never looks like a crash)
  const [quiet, setQuiet] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setQuiet(lastEventTs ? Math.round((Date.now() - lastEventTs) / 1000) : 0), 1000)
    return () => clearInterval(id)
  }, [lastEventTs])
  const done = todos.filter((t) => t.status === 'completed').length
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0
  const inProgress = todos.find((t) => t.status === 'in_progress')
  const counts = activity.reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] ?? 0) + 1 }), {} as Record<string, number>)
  const touched = [...new Set(activity.filter((a) => (a.kind === 'write' || a.kind === 'edit') && a.path).map((a) => a.path))]
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  return (
    <div className="text-[13px]">
      {/* header: the turn is alive */}
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center"><span className="absolute inset-0 rounded-full border-2 border-accent/25" /><span className="absolute inset-0 animate-spin rounded-full border-2 border-accent border-t-transparent" /></span>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.2em] text-accent">{T('Trabajando', 'Working')}</span>
        {quiet >= 12 && <span className="text-[11px] text-ink-3">· {T('este paso puede tardar', 'this step can take a while')} · {T('sin novedades hace', 'no news for')} {quiet}s</span>}
        <span className="ml-auto font-mono text-[11px] text-ink-3">{mm}:{ss}</span>
      </div>
      {/* plan: a bar and the current step; the list is one click away */}
      {todos.length > 0 && (
        <div className="mt-2.5">
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="text-ink-3">{T('Plan', 'Plan')} {done}/{todos.length}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-accent transition-all duration-700" style={{ width: `${Math.max(pct, inProgress ? 4 : 0)}%` }} /></span>
            <button type="button" onClick={() => setShowPlan((v) => !v)} className="flex items-center gap-1 text-ink-3 transition hover:text-accent"><ChevronDown size={11} className={`transition ${showPlan ? 'rotate-180' : ''}`} /> {showPlan ? T('ocultar', 'hide') : T('ver plan', 'see plan')}</button>
          </div>
          {inProgress && !showPlan && <div className="mt-1 truncate text-[12.5px] text-ink">{inProgress.text}</div>}
          {showPlan && (
            <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto scroll-thin">
              {todos.map((t, i) => (
                <li key={i} className={`flex items-start gap-1.5 text-[12px] ${t.status === 'completed' ? 'text-ink-3 line-through' : t.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-2'}`}>
                  {t.status === 'completed' ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-ok" /> : t.status === 'in_progress' ? <span className="mt-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" /> : <Circle size={12} className="mt-0.5 shrink-0 text-ink-4" />}
                  <span className="line-clamp-2">{t.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* files touched this turn, as chips, with the turn's counters */}
      {(touched.length > 0 || activity.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {touched.slice(-12).map((p) => <button key={p} type="button" onClick={() => useBuild.getState().set({ selected: p, pane: 'code', paneOpen: true })} className="max-w-full truncate rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2 transition hover:border-accent hover:text-accent" title={p}>{p.split('/').slice(-2).join('/')}</button>)}
          {touched.length > 12 && <span className="text-[10.5px] text-ink-3">+{touched.length - 12}</span>}
          <span className="ml-auto flex items-center gap-1 text-[10.5px] text-ink-3">
            {touched.length ? <span>{touched.length}{files ? `/${files}` : ''} {T('archivos', 'files')}</span> : <span>{T('leyendo el proyecto', 'reading the project')}</span>}
            {counts.run ? <span>· {counts.run} {T('comandos', 'commands')}</span> : null}
            {counts.test ? <span>· {counts.test} tests</span> : null}
          </span>
        </div>
      )}
    </div>
  )
}

function ManyFiles({ files, onOpen }: { files: string[]; onOpen: (p: string) => void }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[12px] text-accent hover:underline"><ChevronDown size={12} className={`transition ${open ? 'rotate-180' : ''}`} /> {files.length} {T('archivos escritos', 'files written')}</button>
      {open && <div className="mt-1.5 space-y-1.5">{files.map((p) => <FileChip key={p} path={p} done onOpen={() => onOpen(p)} />)}</div>}
    </div>
  )
}

function FileChip({ path, done, lines, onOpen }: { path: string; done?: boolean; lines?: number; onOpen: () => void }) {
  const T = useT()
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-2 rounded-lg border border-line bg-paper hover:bg-surface-2 px-2.5 py-1.5 text-left font-mono text-[12px]">
      <FileCode2 size={13} className={done ? 'text-ok' : 'text-accent animate-pulse'} />
      <span className="truncate">{path}</span>
      <span className="ml-auto text-[10px] text-ink-4">{done ? T('escrito', 'written') : `${lines ?? 0} ${T('líneas…', 'lines…')}`}</span>
    </button>
  )
}

// ------------------------------------------------------------------ tree
interface Node {
  name: string
  path: string
  children?: Node[]
}

function buildTree(paths: string[]): Node[] {
  const root: Node[] = []
  for (const p of [...new Set(paths)].sort()) {
    const parts = p.split('/')
    let level = root
    let acc = ''
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part
      let node = level.find((n) => n.name === part)
      if (!node) {
        node = i < parts.length - 1 ? { name: part, path: acc, children: [] } : { name: part, path: acc }
        level.push(node)
        level.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name))
      }
      if (node.children) level = node.children
    })
  }
  return root
}

function TreeNode({ node, depth, selected, live, onSelect }: { node: Node; depth: number; selected: string | null; live: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(true)
  if (node.children) {
    return (
      <div>
        <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-1.5 px-2 py-1 text-ink-2 hover:bg-surface-2" style={{ paddingLeft: 8 + depth * 14 }}>
          <Folder size={13} className="text-ink-3" /> {node.name}
        </button>
        {open && node.children.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} live={live} onSelect={onSelect} />)}
      </div>
    )
  }
  const isSel = selected === node.path
  return (
    <button onClick={() => onSelect(node.path)} className={`w-full flex items-center gap-1.5 px-2 py-1 text-left truncate ${isSel ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'}`} style={{ paddingLeft: 8 + depth * 14 }}>
      <FileCode2 size={13} className={live === node.path ? 'text-accent animate-pulse' : 'text-ink-4'} /> <span className="truncate">{node.name}</span>
    </button>
  )
}


/** The designer's mockup is ready and the build waits: approve it, or send change requests for another design round. */
function DesignReviewCard() {
  const T = useT()
  const b = useBuild()
  const [fb, setFb] = useState('')
  const [busy, setBusy] = useState(false)
  const approve = async () => {
    setBusy(true)
    try {
      await api.buildDesignApprove(b.id!, b.sessionId)
      useBuild.getState().set({ status: 'connecting' })
      reconnectBuild(b.id!)
      toast.ok(tr('Diseño aprobado', 'Design approved'), tr('El constructor empieza a escribir el código siguiendo el mockup.', 'The builder starts writing the code following the mockup.'))
    } catch (e) {
      toast.error(tr('No se pudo aprobar', 'Could not approve'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const redo = async () => {
    if (!fb.trim()) return
    setBusy(true)
    try {
      await api.buildDesignRedo(b.id!, fb.trim(), b.sessionId)
      useBuild.getState().set({ status: 'connecting' })
      reconnectBuild(b.id!)
      setFb('')
      toast.ok(tr('Rediseñando', 'Redesigning'), tr('El diseñador aplica tus cambios y te muestra la nueva versión.', 'The designer applies your changes and shows you the new version.'))
    } catch (e) {
      toast.error(tr('No se pudo pedir el rediseño', 'Could not request the redesign'), (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-2xl border-2 border-accent/40 bg-accent-soft/40 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-semibold text-ink"><Palette size={16} className="text-accent" /> {T('El diseño está listo. ¿Construimos así?', 'The design is ready. Build it like this?')}</div>
      <p className="mt-1 text-[12.5px] text-ink-2">{T('Mirá el mockup en la pestaña Diseño (pantallas navegables, tokens y DESIGN.md). Todavía no hay código: si algo no te gusta, pedí cambios y el diseñador hace otra ronda antes de construir.', 'Look at the mockup in the Design tab (navigable screens, tokens and DESIGN.md). There is no code yet: if something is off, ask for changes and the designer does another round before building.')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => useBuild.getState().set({ paneOpen: true, pane: 'design' })} className="flex items-center gap-1.5 rounded-xl border border-line bg-paper px-3 py-1.5 text-[12.5px] hover:bg-surface-2"><Eye size={14} /> {T('Ver el mockup', 'View the mockup')}</button>
        <button type="button" onClick={approve} disabled={busy} className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {T('Me gusta, construir', 'I like it, build')}</button>
      </div>
      <textarea value={fb} onChange={(e) => setFb(e.target.value)} placeholder={T('ej.: paleta más oscura y moderna, el dato del clima como protagonista, menos tarjetas, tipografía más grande, parecido a Apple Weather…', 'e.g.: darker, modern palette, the weather number as the hero, fewer cards, larger type, close to Apple Weather…')} className="mt-2 h-20 w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] outline-none focus:border-accent" />
      <button type="button" onClick={redo} disabled={busy || !fb.trim()} className="mt-1.5 flex items-center gap-1.5 rounded-xl border border-accent/50 bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-accent disabled:opacity-40"><Palette size={14} /> {T('Rediseñar con estos cambios', 'Redesign with these changes')} {b.designRounds ? `(${T('ronda', 'round')} ${b.designRounds + 1})` : ''}</button>
    </div>
  )
}

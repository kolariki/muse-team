import { Focus, ChevronDown, Download, FileText, Hammer, Home, Menu, Rocket, Pause, Users, Square, Trophy, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { downloadBlob, slug } from '../lib/recorder'
import { setSfx } from '../lib/sfx'
import { useArena } from '../store'

export default function TopBar({ onNew, onRerun }: { onNew: () => void; onRerun?: () => void }) {
  const T = useT()
  const s = useArena()
  const [menuOpen, setMenuOpen] = useState(false)
  const compact = s.layout === 'vertical'
  useEffect(() => { setSfx(true) }, [])  // sound effects are always on
  const live = s.status === 'running' || s.status === 'paused' || s.status === 'voting' || s.status === 'connecting'
  // the same pill language as the home and builder headers: 36 px, rounded, lifts on hover
  const btn = 'flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-2 shadow-sm transition hover:bg-accent-soft hover:border-accent hover:text-accent disabled:opacity-40'
  const primary = 'flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110'

  return (
    <div className="relative z-[70] flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-2 backdrop-blur sm:h-16 sm:gap-3 sm:px-4">
      <img src="/icon.svg?v=2" alt="Tably Team" title="Tably Team" className="h-9 w-9 shrink-0 rounded-xl shadow-sm" draggable={false} />
      <div className="ml-1 flex shrink-0 items-center gap-2 sm:ml-2">
        {s.recording ? null : s.status === 'paused' ? (
          <span className="flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/15 px-2.5 py-1 text-[11px] font-bold text-gold">
            <Pause size={11} /> {T('EN PAUSA', 'PAUSED')}
          </span>
        ) : live ? (
          <span className="flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 text-[11px] font-bold text-danger">
            <span className="w-2 h-2 rounded-full bg-danger animate-pulse" /> {s.source === 'replay' ? 'REPLAY' : T('EN VIVO', 'LIVE')}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok/10 px-2.5 py-1 text-[11px] font-bold text-ok"><span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_0_3px_rgba(23,137,106,.18)]" /> {s.status === 'completed' ? T('TERMINADO', 'FINISHED') : s.status.toUpperCase()}</span>
        )}
        {s.config && !s.recording && (
          <span className="whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-ink-2" title={T('turno actual / máximo', 'current turn / maximum')}>
            {s.status === 'voting' ? T('votación final', 'final vote') : s.closing && s.status === 'running' ? T('ronda de cierre', 'closing round') : `${T('turno', 'turn')} ${Math.min(s.turns.length + (s.status === 'running' ? 1 : 0), s.config.max_turns)} / ${s.config.max_turns}`}
          </span>
        )}
        {s.config && !compact && (
          <span className="hidden min-w-0 max-w-[34vw] md:block">
            <span className="serif block truncate text-[17px] leading-tight" title={s.config.mode === 'review' && s.config.review_of ? s.config.review_of.title : (s.config.title || s.config.topic)}>{s.config.mode === 'review' && s.config.review_of ? s.config.review_of.title : (s.config.title || s.config.topic)}</span>
            {s.config.mode === 'review' && s.config.review_of && (
              <span className="block truncate text-[11.5px] text-ink-3">{T('Consejo · ronda', 'Council · round')} {s.config.review_of.round} · v{s.config.review_of.version ?? ''}{(s.config.review_of as { focus?: string }).focus === 'design' ? ` · ${T('diseño', 'design')}` : ''}</span>
            )}
          </span>
        )}
      </div>
      <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-label={T('Menú', 'Menu')} className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-sm md:hidden">{menuOpen ? <X size={17} /> : <Menu size={17} />}</button>
      <div onClick={(e) => { if ((e.target as HTMLElement).closest('button') && window.innerWidth < 768) setMenuOpen(false) }} className={`${menuOpen ? 'fixed inset-x-3 top-16 z-[80] flex max-h-[calc(100dvh-5rem)] flex-col items-stretch overflow-y-auto rounded-2xl border border-line bg-surface p-3 shadow-xl [&>*]:w-full [&>*]:justify-center' : 'hidden'} gap-2 md:static md:z-auto md:ml-auto md:flex md:min-w-0 md:max-h-none md:flex-row md:items-center md:overflow-x-auto md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none md:[&>*]:w-auto ${s.recording ? 'invisible' : s.recMode ? 'opacity-0 hover:opacity-100 transition' : ''}`}>
        {s.source === 'replay' && (
          <select className={`${btn} appearance-none pr-3 font-mono`} value={s.speed} onChange={(e) => s.set({ speed: Number(e.target.value) })} title={T('Velocidad de reproducción', 'Playback speed')}>
            {[0.5, 1, 1.5, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
          </select>
        )}
        {s.sessionId && !live && <ExportMenu btn={btn} />}
        {s.config?.mode === 'review' && s.config.review_of && (
          <button className={primary} onClick={() => s.set({ showVerdict: false, pendingBuild: { buildId: s.config!.review_of!.build_id, sessionId: s.config!.review_of!.session_id } })} title={T('Volver al constructor de este proyecto', "Back to this project's builder")}><Hammer size={14} /> {T('Constructor', 'Builder')} · v{s.config.review_of.version ?? ''}</button>
        )}
        {s.sessionId && !live && s.config?.mode !== 'review' && (
          <button className={primary} onClick={() => s.set({ showBriefExport: true })} title={T('El equipo construye el producto: brief, diseño y código, acá adentro', 'The team builds the product: brief, design and code, right here')}><Rocket size={14} /> {T('Construir la app', 'Build the app')}</button>
        )}
        {s.verdict && <button className={btn} onClick={() => s.set({ showVerdict: true })}><Trophy size={14} /> {s.config?.mode === 'review' ? T('Veredicto del consejo', 'Council verdict') : T('Veredicto', 'Verdict')}</button>}
        {s.config && s.source === 'live' && <button className={btn} onClick={() => s.set({ showTeam: true })} title={T('Cambiar el modelo de cualquier rol', 'Change the model of any role')}><Users size={14} /> {T('Equipo', 'Team')}</button>}
        <button className={`${btn} ${s.focus ? 'border-accent bg-accent-soft text-accent' : ''}`} onClick={() => s.set({ focus: !s.focus })} title={T('Foco: los agentes debatiendo ocupan la pantalla; transcripción y métricas se achican', 'Focus: the debating agents fill the screen; transcript and metrics shrink')}><Focus size={14} /> {T('Foco', 'Focus')}</button>
        {live && s.source === 'live' && s.sessionId && (
          <button className={`${btn} border-danger/40 text-danger hover:border-danger hover:text-danger`} onClick={() => api.stop(s.sessionId!)}><Square size={14} /> {T('Detener', 'Stop')}</button>
        )}
        {live && s.source === 'replay' && <button className={btn} onClick={onNew}><Pause size={14} /> {T('Salir', 'Exit')}</button>}
        {!live && onRerun && <button className={btn} onClick={onRerun} title={T('Volver a correr el mismo debate desde cero (misma consigna y equipo)', 'Run the same debate again from scratch (same brief and team)')}><RotateCcw size={14} /> {T('Repetir', 'Repeat')}</button>}
        {!live && <button className={primary} onClick={onNew} title={T('Volver al inicio', 'Back to home')}><Home size={15} /> {T('Inicio', 'Home')}</button>}
      </div>
    </div>
  )
}

function ExportMenu({ btn }: { btn: string }) {
  const T = useT()
  const set = useArena((s) => s.set)
  const sessionId = useArena((s) => s.sessionId)
  const config = useArena((s) => s.config)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 64, right: 16 })
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const transcript = async () => {
    setOpen(false)
    const md = await api.transcript(sessionId!)
    downloadBlob(new Blob([md], { type: 'text/markdown' }), `tablyteam-${slug(config?.title || config?.topic || sessionId!)}-transcripcion.md`)
  }
  const item = 'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2'
  return (
    <div ref={ref} className="relative shrink-0">
      <button className={`${btn} ${open ? 'border-accent text-accent' : ''}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }); setOpen(!open) }}>
        <Download size={14} /> {T('Exportar', 'Export')} <ChevronDown size={13} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="fixed z-[400] w-72 rounded-2xl border border-line bg-surface p-1.5 text-sm shadow-[0_18px_40px_-18px_rgba(30,38,34,.55)]" style={{ top: pos.top, right: pos.right }}>
          <button className={item} onClick={() => { setOpen(false); set({ showBriefExport: true }) }}>
            <Hammer size={17} className="mt-0.5 text-accent" />
            <span><b className="font-medium">{T('Brief para construir', 'Build brief')}</b><span className="block text-xs text-ink-3">{T('Markdown + prompt para Claude Code, Cursor…', 'Markdown + prompt for Claude Code, Cursor…')}</span></span>
          </button>
          <button className={item} onClick={transcript}>
            <FileText size={17} className="mt-0.5 text-accent" />
            <span><b className="font-medium">{T('Transcripción', 'Transcript')}</b><span className="block text-xs text-ink-3">{T('El debate completo en .md', 'The full debate as .md')}</span></span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

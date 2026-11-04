import { motion } from 'framer-motion'
import { Camera, Check, Eye, FileSearch, Gavel, Globe, Loader2, Search, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBuild } from '../buildStore'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { MUSE_FIRST } from '../lib/flags'
import ProviderLogo from './ProviderLogo'

const RING = MUSE_FIRST ? Array(6).fill('meta') as string[] : ['meta', 'anthropic', 'openai', 'deepseek', 'gemini', 'xai', 'groq', 'kimi', 'mistral', 'openrouter', 'ollama']

/**
 * The team is researching the references before the council: a full screen that holds the user here (every click
 * elsewhere would race the job) and shows what is happening: each reference visited, captured and analysed, the live
 * activity feed, the elapsed time. It leaves by itself when the council opens.
 */
export default function ResearchOverlay({ demo = false, hiddenDemo = false, onClose }: { demo?: boolean; hiddenDemo?: boolean; onClose?: () => void } = {}) {
  const T = useT()
  const b = useBuild()
  const r = b.researching
  // demo mode (#demo=research): a scripted run so the screen can be seen without a real benchmark; loops every ~24 s
  useEffect(() => {
    if (!demo) return
    const refs = ['windy.com', 'accuweather.com', 'apple.com/weather']
    const steps: { at: number; apply: () => void }[] = [
      { at: 0, apply: () => useBuild.getState().set({ researching: { refs, hidden: hiddenDemo, started: Date.now(), visited: [], finished: false }, activity: [{ kind: 'search', label: 'Buscando referentes', path: '', ts: Date.now() }] }) },
      { at: 2500, apply: () => useBuild.getState().set({ activity: [...useBuild.getState().activity, { kind: 'search', label: 'Entrando a windy.com', path: 'https://windy.com', ts: Date.now() }] }) },
      { at: 5500, apply: () => useBuild.getState().set({ activity: [...useBuild.getState().activity, { kind: 'read', label: 'Analizando Windy', path: 'https://windy.com', ts: Date.now() }] }) },
      { at: 8000, apply: () => { const st = useBuild.getState(); st.set({ researching: st.researching && { ...st.researching, visited: [{ name: 'windy.com', url: 'https://windy.com', ok: true }] }, activity: [...st.activity, { kind: 'search', label: 'Entrando a accuweather.com', path: 'https://accuweather.com', ts: Date.now() }] }) } },
      { at: 11500, apply: () => { const st = useBuild.getState(); st.set({ researching: st.researching && { ...st.researching, visited: [...st.researching.visited, { name: 'accuweather.com', url: 'https://accuweather.com', ok: false }] }, activity: [...st.activity, { kind: 'search', label: 'Entrando a apple.com/weather', path: 'https://apple.com/weather', ts: Date.now() }] }) } },
      { at: 14500, apply: () => { const st = useBuild.getState(); st.set({ activity: [...st.activity, { kind: 'read', label: 'Analizando Apple Weather', path: 'https://apple.com/weather', ts: Date.now() }] }) } },
      { at: 17500, apply: () => { const st = useBuild.getState(); st.set({ researching: st.researching && { ...st.researching, visited: [...st.researching.visited, { name: 'apple.com/weather', url: 'https://apple.com/weather', ok: true }, { name: 'Yr.no', url: 'https://yr.no', ok: true }] }, activity: [...st.activity, { kind: 'plan', label: 'Armando el brief de referentes', path: 'research/REFERENCES.md', ts: Date.now() }] }) } },
      { at: 21000, apply: () => { const st = useBuild.getState(); st.set({ researching: st.researching && { ...st.researching, finished: true } }) } },
      { at: 23000, apply: () => { const st = useBuild.getState(); st.set({ researching: st.researching && { ...st.researching, opening: true } }) } },
    ]
    let timers: number[] = []
    const run = () => { timers = steps.map((x) => window.setTimeout(x.apply, x.at)); timers.push(window.setTimeout(run, 28500)) }
    run()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => { timers.forEach(clearTimeout); window.removeEventListener('keydown', onKey); useBuild.getState().set({ researching: null, activity: [] }) }
  }, [demo]) // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  // belt and braces: if the socket misses the events, poll the build; a new council round or a finished job ends the wait
  useEffect(() => {
    const id = setInterval(async () => {
      const st = useBuild.getState()
      if (!st.sessionId || !st.id) return
      try {
        const d = await api.build(st.sessionId, st.id)
        const councils: string[] = d.council_sessions ?? []
        if (councils.length > st.councilSessionsKnown) {
          st.set({ councilSession: councils[councils.length - 1], councilSessionsKnown: councils.length, researching: st.researching ? { ...st.researching, finished: true, opening: true } : null, status: d.status })
        } else if (d.status !== 'running' && st.researching && Date.now() - st.researching.started > 20000 && !d.live) {
          st.set({ researching: { ...st.researching, finished: true } })
        }
      } catch { /* next tick */ }
    }, 6000)
    return () => clearInterval(id)
  }, [])
  const started = r?.started ?? now
  const elapsed = Math.max(0, Math.round((now - started) / 1000))
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  const refs = r?.refs ?? []
  const stateOf = (ref: string) => {
    const key = ref.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
    const hit = (r?.visited ?? []).find((v) => (v.url ?? '').toLowerCase().includes(key) || (v.name ?? '').toLowerCase().includes(key) || key.includes((v.name ?? '—').toLowerCase()))
    if (!hit) return 'pending'
    return hit.ok ? 'done' : 'failed'
  }
  const fuse = !!r?.opening
  // the fusion lasts ~2.6 s; then the overlay clears itself (the council is already mounted underneath)
  useEffect(() => {
    if (!fuse || demo) return
    const t = window.setTimeout(() => useBuild.getState().set({ researching: null }), 2700)
    return () => window.clearTimeout(t)
  }, [fuse, demo])

  // which phase we are in, read from the activity feed; the current reference is the last one entered
  const acts = b.activity
  const last = acts[acts.length - 1]
  // the team's own references leave no named steps to read: the count says how far it went
  const phase = r?.finished ? 4 : r?.hidden ? (r.visited.length ? 2 : 1) : /Armando/i.test(last?.label ?? '') ? 3 : /Analizando/i.test(last?.label ?? '') ? 2 : /Entrando/i.test(last?.label ?? '') ? 1 : 0
  const currentRef = [...acts].reverse().find((a) => /Entrando a/i.test(a.label))
  const currentHost = (currentRef?.path || currentRef?.label.replace(/^Entrando a\s*/i, '') || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const visited = r?.visited ?? []
  const captured = visited.filter((v) => v.ok)
  const STEPS = [
    { n: 1, label: T('Buscar referentes', 'Find references'), icon: Search },
    { n: 2, label: T('Capturar pantallas', 'Capture screens'), icon: Camera },
    { n: 3, label: T('Analizar con visión', 'Analyse with vision'), icon: Eye },
    { n: 4, label: T('Armar REFERENCES.md', 'Write REFERENCES.md'), icon: FileSearch },
  ]
  const ICON: Record<string, typeof Search> = { search: Globe, read: FileSearch, plan: Gavel, write: Camera, think: Eye }
  const stamp = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` }
  // Muse Team's own references (the user added none): the work is shown, the names are not
  const hidden = !!r?.hidden
  const SKEL = [
    { w: '38%', h: 14, y: 0 }, { w: '100%', h: 36, y: 26 }, { w: '62%', h: 10, y: 74 }, { w: '48%', h: 10, y: 92 },
    { w: '31%', h: 70, y: 118, x: '0%' }, { w: '31%', h: 70, y: 118, x: '34.5%' }, { w: '31%', h: 70, y: 118, x: '69%' },
    { w: '100%', h: 10, y: 204 }, { w: '84%', h: 10, y: 222 },
  ]

  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: fuse ? 0 : 1 }} transition={fuse ? { delay: 2.1, duration: 0.5 } : { duration: 0.3 }} exit={{ opacity: 0, transition: { duration: 0.4 } }} className="fixed inset-0 z-[160] overflow-y-auto bg-paper arena-bg">
      {demo && <button onClick={onClose} className="absolute right-5 top-5 z-30 flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent">{T('Demo · cerrar (Esc)', 'Demo · close (Esc)')}</button>}

      {/* the fusion layer: every company leaves the orbit, lines up in front (half over the next) and the row grows into the screen */}
      {fuse && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <motion.div className="relative flex items-center justify-center" initial={{ scale: 1, opacity: 1 }} animate={{ scale: [1, 1, 1.15, 22], opacity: [1, 1, 1, 0] }} transition={{ duration: 2.5, times: [0, 0.5, 0.62, 1], ease: ['linear', 'easeOut', 'easeIn'] }}>
            {RING.map((id, i) => {
              const a = (i / RING.length) * Math.PI * 2
              const slot = (i - (RING.length - 1) / 2) * 28
              return (
                <motion.span key={i} className="absolute flex h-14 w-14 items-center justify-center rounded-full border-2 border-surface bg-surface shadow-[0_18px_40px_-14px_rgba(30,38,34,.5)]" style={{ zIndex: RING.length - i }} initial={{ x: Math.cos(a) * 260, y: Math.sin(a) * 160, scale: 0.8 }} animate={{ x: [Math.cos(a) * 260, slot * 1.6, slot], y: [Math.sin(a) * 160, 0, 0], scale: [0.8, 1.1, 1] }} transition={{ duration: 1.15, times: [0, 0.75, 1], ease: ['easeInOut', 'easeOut'], delay: i * 0.05 }}>
                  <ProviderLogo provider={id} size={28} />
                </motion.span>
              )
            })}
          </motion.div>
          <motion.span className="absolute h-40 w-40 rounded-full" style={{ background: 'radial-gradient(circle, rgba(47,107,93,.95) 0%, rgba(47,107,93,.6) 40%, rgba(47,107,93,0) 70%)' }} initial={{ scale: 0, opacity: 0 }} animate={{ scale: [0, 0, 1.6, 30], opacity: [0, 0, 1, 0] }} transition={{ duration: 2.5, times: [0, 0.55, 0.72, 1], ease: 'easeInOut' }} />
          <motion.div className="absolute inset-0 bg-accent" initial={{ opacity: 0 }} animate={{ opacity: [0, 0, 0.9, 0] }} transition={{ duration: 2.6, times: [0, 0.65, 0.84, 1] }} />
        </div>
      )}

      <motion.div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-6 sm:px-8 sm:py-10" animate={{ opacity: fuse ? 0 : 1, y: fuse ? 16 : 0 }} transition={{ duration: 0.5 }}>
        {/* header */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[min(100%,260px)] flex-1">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.35em] text-accent"><span className="h-2 w-2 rounded-full bg-accent animate-pulse" /> {T('Reverse engineering · antes del consejo', 'Reverse engineering · before the council')}</div>
            <h2 className="mt-1.5 text-[26px] leading-tight sm:text-[34px]">{r?.finished ? T('Listo: abriendo el consejo…', 'Done: opening the council…') : hidden ? T('Investigando referentes', 'Researching references') : T('El equipo está investigando las referencias', 'The team is researching the references')}</h2>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">{hidden ? T('El equipo estudia los mejores productos de la categoría: estructura, jerarquía, flujos y estados. Con eso como vara, el consejo revisa tu proyecto. Quedate acá: se abre solo al terminar.', 'The team studies the best products in the category: structure, hierarchy, flows and states. With that as the bar, the council reviews your project. Stay here: it opens by itself when done.') : T('Entra a cada app, saca capturas y anota qué emular y qué evitar. Con eso en la mano, el consejo revisa tu proyecto. Quedate acá: se abre solo al terminar.', 'It visits each app, takes screenshots and notes what to emulate and avoid. With that in hand the council reviews your project. Stay here: it opens by itself when done.')}</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[[String(r?.refs.length || visited.length || '—'), hidden ? T('modelos', 'models') : T('referentes', 'references')], [String(captured.length), T('capturas', 'captures')], [`${mm}:${ss}`, T('transcurrido', 'elapsed')]].map(([v, l]) => (
              <div key={l} className="rounded-xl border border-line bg-surface px-4 py-2.5 text-center shadow-sm"><div className="font-mono text-xl leading-none">{v}</div><div className="mt-1 text-[10px] uppercase tracking-widest text-ink-3">{l}</div></div>
            ))}
          </div>
        </div>

        {/* the phases */}
        <ol className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STEPS.map((st) => {
            const Icon = st.icon
            const state = st.n - 1 < phase ? 'done' : st.n - 1 === phase ? 'active' : 'next'
            return (
              <li key={st.n} className={`relative flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[12.5px] transition-colors ${state === 'active' ? 'border-accent bg-accent-soft text-ink' : state === 'done' ? 'border-ok/30 bg-ok/5 text-ink-2' : 'border-line bg-surface text-ink-3'}`}>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${state === 'done' ? 'bg-ok text-white' : state === 'active' ? 'bg-accent text-white' : 'bg-surface-2 text-ink-3'}`}>{state === 'done' ? <Check size={13} strokeWidth={3} /> : state === 'active' ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}</span>
                <span className="min-w-0"><span className="block text-[10px] uppercase tracking-widest opacity-70">{T('Paso', 'Step')} {st.n}</span><span className="block truncate font-medium">{st.label}</span></span>
              </li>
            )
          })}
        </ol>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1.25fr_1fr] lg:items-start">
          {/* the scanner: a browser frame where the current reference is being captured */}
          <div className="flex min-h-0 flex-col">
            <div className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_60px_-28px_rgba(30,38,34,.55)]">
              <div className="flex h-9 items-center gap-1.5 border-b border-line bg-surface-2/70 px-3">
                <span className="h-2.5 w-2.5 rounded-full bg-[#E6A19A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#E9C97A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#9FCDA8]" />
                <span className="ml-3 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-surface px-2 font-mono text-[11px] text-ink-2"><Globe size={11} className="shrink-0 text-ink-3" /><span className="truncate">{hidden ? T('investigando referentes…', 'researching references…') : currentHost ? `https://${currentHost}` : T('buscando referentes…', 'finding references…')}</span></span>
                <span className={`ml-2 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${phase === 1 ? 'border-danger/40 bg-danger/10 text-danger' : phase === 2 ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface text-ink-3'}`}><span className={`h-1.5 w-1.5 rounded-full ${phase === 1 ? 'bg-danger animate-pulse' : phase === 2 ? 'bg-accent animate-pulse' : 'bg-ink-4'}`} /> {phase === 1 ? T('capturando', 'capturing') : phase === 2 ? T('analizando', 'analysing') : phase === 3 ? T('redactando', 'writing') : r?.finished ? T('listo', 'done') : T('buscando', 'searching')}</span>
              </div>
              {/* the page being read: a skeleton that builds up, a scan beam, and the orbit watching from the corner */}
              <div className="relative h-[330px] p-6">
                <div className="relative h-[240px]">
                  {SKEL.map((k, i) => (
                    <motion.div key={`${currentHost}-${i}`} className="absolute rounded-md bg-surface-2" style={{ left: k.x ?? 0, top: k.y, width: k.w, height: k.h }} initial={{ opacity: 0, scaleX: 0.6 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ delay: 0.15 + i * 0.09, duration: 0.45, ease: 'easeOut' }} />
                  ))}
                  <motion.div key={`beam-${currentHost}`} className="pointer-events-none absolute inset-x-0 h-10" style={{ background: 'linear-gradient(180deg, rgba(47,107,93,0) 0%, rgba(47,107,93,.18) 50%, rgba(47,107,93,0) 100%)', borderBottom: '1px solid rgba(47,107,93,.6)' }} initial={{ top: -40 }} animate={{ top: [-40, 240, -40] }} transition={{ duration: 3.2, ease: 'easeInOut', repeat: Infinity }} />
                  {phase === 2 && (
                    <motion.div className="absolute inset-0 rounded-lg border-2 border-dashed border-accent/50" initial={{ opacity: 0 }} animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.6, repeat: Infinity }}>
                      {[['top-2 left-2', T('jerarquía clara', 'clear hierarchy')], ['top-2 right-2', T('CTA único', 'single CTA')], ['bottom-2 left-2', T('tarjetas por día', 'cards per day')]].map(([pos, t]) => (
                        <span key={t} className={`absolute ${pos} rounded-full border border-accent/40 bg-surface px-2 py-0.5 text-[10px] text-accent shadow-sm`}>{t}</span>
                      ))}
                    </motion.div>
                  )}
                </div>
                {/* the companies, small, watching the page */}
                <div className="absolute bottom-4 right-5">
                  <div className="relative h-20 w-20">
                    <motion.div className="absolute inset-0" animate={{ rotate: 360 }} transition={{ duration: 12, ease: 'linear', repeat: Infinity }}>
                      {RING.slice(0, 6).map((id, i) => { const a = (i / 6) * Math.PI * 2; return (
                        <motion.span key={id} className="absolute flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface shadow-sm" style={{ left: `calc(50% + ${Math.cos(a) * 32}px - 12px)`, top: `calc(50% + ${Math.sin(a) * 32}px - 12px)` }} animate={{ rotate: -360 }} transition={{ duration: 12, ease: 'linear', repeat: Infinity }}><ProviderLogo provider={id} size={13} /></motion.span>
                      ) })}
                    </motion.div>
                    <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-white shadow-sm"><Search size={14} /></span>
                  </div>
                </div>
              </div>
            </div>
            {/* captured so far: a strip of thumbnails */}
            <div className="mt-3 flex items-center gap-2 overflow-x-auto scroll-thin pb-1">
              <span className="shrink-0 text-[10.5px] uppercase tracking-[0.25em] text-ink-3">{T('Capturas', 'Captures')}</span>
              {captured.length === 0 && <span className="text-[12px] text-ink-4">{T('todavía ninguna', 'none yet')}</span>}
              {captured.map((v, i) => (
                <motion.div key={`${v.url ?? v.name ?? 'ref'}-${i}`} initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }} className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg border border-line shadow-sm" style={{ background: `linear-gradient(135deg, hsl(${(i * 67) % 360} 45% 92%) 0%, hsl(${(i * 67 + 40) % 360} 40% 84%) 100%)` }}>
                  <span className="absolute left-1.5 top-1.5 h-1.5 w-10 rounded-full bg-white/70" /><span className="absolute left-1.5 top-4 h-4 w-16 rounded bg-white/60" /><span className="absolute bottom-1.5 left-1.5 right-1.5 h-3 rounded bg-white/50" />
                  <span className="absolute bottom-0 inset-x-0 truncate bg-ink/60 px-1.5 py-0.5 font-mono text-[9px] text-white">{hidden ? `${T('modelo', 'model')} ${i + 1}` : (v.name || v.url || '').replace(/^https?:\/\//, '')}</span>
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-ok text-white"><Check size={9} strokeWidth={3} /></span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* references + log (hidden mode: one calm status card, no names, no log) */}
          {hidden ? (
            <div className="rounded-2xl border border-line bg-surface p-5 shadow-[0_12px_28px_-18px_rgba(30,38,34,.4)]">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{r?.finished ? <Check size={18} strokeWidth={3} /> : <Loader2 size={18} className="animate-spin" />}</span>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">{r?.finished ? T('Análisis terminado', 'Analysis finished') : T('Analizando modelos…', 'Analysing models…')}</div>
                  <div className="text-[12px] text-ink-3">{STEPS[Math.min(phase, STEPS.length - 1)].label}</div>
                </div>
                <span className="ml-auto font-mono text-[12px] text-ink-2">{captured.length}/{Math.max(refs.length, visited.length) || '—'}</span>
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2"><motion.div className="h-full rounded-full bg-accent" animate={{ width: `${Math.round(((r?.finished ? STEPS.length : phase) / STEPS.length) * 100)}%` }} transition={{ duration: 0.6 }} /></div>
              <ul className="mt-4 space-y-2 text-[12.5px] text-ink-2">
                {[T('Estructura y navegación', 'Structure and navigation'), T('Jerarquía visual y densidad', 'Visual hierarchy and density'), T('Flujos clave y estados', 'Key flows and states'), T('Qué emular y qué evitar', 'What to emulate and avoid')].map((t, i) => (
                  <li key={t} className="flex items-center gap-2">{i < phase || r?.finished ? <Check size={13} className="text-ok" strokeWidth={3} /> : <span className="h-1.5 w-1.5 rounded-full bg-ink-4" />}{t}</li>
                ))}
              </ul>
            </div>
          ) : (
          <div className="flex min-h-0 flex-col gap-4">
            <div className="rounded-2xl border border-line bg-surface p-4 shadow-[0_12px_28px_-18px_rgba(30,38,34,.4)]">
              <div className="flex items-center text-[10.5px] uppercase tracking-[0.25em] text-ink-3">{T('Referencias', 'References')}<span className="ml-auto font-mono normal-case tracking-normal text-ink-2">{captured.length}/{Math.max(refs.length, visited.length) || '—'}</span></div>
              <ul className="mt-2.5 space-y-2">
                {refs.length === 0 && visited.length === 0 && <li className="text-[13px] text-ink-3">{T('El equipo propone los referentes de la categoría…', 'The team proposes the category’s references…')}</li>}
                {[...refs.map((ref) => ({ key: ref, label: ref, st: stateOf(ref), own: false })), ...visited.filter((v) => !refs.some((x) => { const k = x.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''); return (v.url ?? '').toLowerCase().includes(k) || (v.name ?? '').toLowerCase().includes(k) })).map((v) => ({ key: v.url ?? v.name ?? '', label: v.name || v.url || '', st: v.ok ? 'done' : 'failed', own: true }))].map((it) => {
                  const host = it.label.replace(/^https?:\/\//, '').replace(/\/$/, '')
                  const active = it.st === 'pending' && host === currentHost
                  return (
                    <li key={it.key} className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${active ? 'border-accent bg-accent-soft/60' : it.st === 'done' ? 'border-ok/30 bg-ok/5' : it.st === 'failed' ? 'border-danger/30 bg-danger/5' : 'border-line bg-paper'}`}>
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold uppercase ${it.st === 'done' ? 'bg-ok text-white' : it.st === 'failed' ? 'bg-danger/80 text-white' : 'bg-surface-2 text-ink-2'}`}>{it.st === 'done' ? <Check size={14} strokeWidth={3} /> : it.st === 'failed' ? <XCircle size={14} /> : host.slice(0, 1)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{host}</span>
                        <span className="block truncate text-[11px] text-ink-3">{it.own ? T('propuesta por el equipo', 'proposed by the team') : it.st === 'done' ? T('capturada y analizada', 'captured and analysed') : it.st === 'failed' ? T('no se pudo abrir', 'could not open') : active ? (phase === 2 ? T('analizando con visión…', 'analysing with vision…') : T('capturando pantallas…', 'capturing screens…')) : T('en cola', 'queued')}</span>
                        {active && <motion.span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-2"><motion.span className="block h-full rounded-full bg-accent" initial={{ width: '10%' }} animate={{ width: ['10%', '85%'] }} transition={{ duration: 6, ease: 'easeOut' }} /></motion.span>}
                      </span>
                      {it.st === 'pending' && active && <Loader2 size={15} className="shrink-0 animate-spin text-accent" />}
                    </li>
                  )
                })}
              </ul>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-[#1E2622] shadow-[0_12px_28px_-18px_rgba(30,38,34,.6)]">
              <div className="flex h-8 items-center gap-2 border-b border-white/10 px-3 font-mono text-[10.5px] uppercase tracking-widest text-[#B9C4BE]"><span className="h-1.5 w-1.5 rounded-full bg-[#8FD3B0] animate-pulse" /> {T('actividad del equipo', 'team activity')}</div>
              <div className="h-[190px] space-y-1 overflow-y-auto scroll-thin p-3 font-mono text-[11.5px] text-[#E6ECE8]">
                {acts.length === 0 && <div className="text-[#7F8C86]">{T('esperando al equipo…', 'waiting for the team…')}</div>}
                {acts.slice(-8).map((a, i, arr) => {
                  const Icon = ICON[a.kind] ?? Search
                  const isLast = i === arr.length - 1
                  return (
                    <motion.div key={`${a.ts}-${i}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: isLast ? 1 : 0.6, x: 0 }} className="flex items-center gap-2">
                      <span className="text-[#5E6B65]">{stamp(a.ts * (a.ts < 1e12 ? 1000 : 1))}</span>
                      <Icon size={11} className="shrink-0 text-[#8FD3B0]" />
                      <span className="truncate">{a.label}</span>{a.path && <span className="truncate text-[#7F8C86]">{a.path}</span>}
                      {isLast && <span className="caret" />}
                    </motion.div>
                  )
                })}
              </div>
            </div>
          </div>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

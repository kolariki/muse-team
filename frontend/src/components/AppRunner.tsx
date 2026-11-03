import { AlertTriangle, ChevronDown, Send, ExternalLink, Loader2, Maximize2, Minimize2, MonitorPlay, Play, RefreshCw, Square, Wrench } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { reconnectBuild, useBuild, type RunFix } from '../buildStore'
import { api, type RunService } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { toast } from './Toast'
import BlockedNotice, { BuilderBusyNotice } from './BlockedNotice'
import { PanelLoader } from './HomeLoader'

const STEP = (): Record<string, string> => ({
  installing: tr('Instalando dependencias…', 'Installing dependencies…'),
  starting: tr('Arrancando el servidor…', 'Starting the server…'),
  running: tr('Corriendo', 'Running'),
  stopped: tr('Detenida', 'Stopped'),
  error: tr('No arrancó', 'Did not start'),
  idle: tr('Lista para correr', 'Ready to run'),
})

// what the loader says as time goes by: never a dead app, just honest patience
const WAIT_START = (): [number, string, string][] => [
  [0, tr('Cargando…', 'Loading…'), tr('Preparando todo para abrir tu app.', 'Getting everything ready to open your app.')],
  [25, tr('Preparando tu app…', 'Preparing your app…'), tr('Instalando lo que necesita y arrancando el servidor.', 'Installing what it needs and starting the server.')],
  [70, tr('Estamos tardando más de lo habitual…', 'This is taking longer than usual…'), tr('La primera vez lleva un poco más: sigue avanzando.', 'The first time takes a bit longer: it keeps moving.')],
  [150, tr('Sigue cargando…', 'Still loading…'), tr('Falta poco: estamos terminando de levantarla.', 'Almost there: we are finishing starting it.')],
  [300, tr('Ya casi está, gracias por la paciencia', 'Almost done, thanks for your patience'), tr('Seguimos trabajando para que abra bien.', 'We keep working so it opens properly.')],
]
const WAIT_FIX = (): [number, string, string][] => [
  [0, tr('Cargando…', 'Loading…'), tr('Un momento, estamos preparando tu app.', 'One moment, we are preparing your app.')],
  [20, tr('Estamos tardando más de lo habitual…', 'This is taking longer than usual…'), tr('Encontramos algo para ajustar y ya lo estamos resolviendo.', 'We found something to adjust and are already on it.')],
  [60, tr('Ajustando unos detalles…', 'Adjusting a few details…'), tr('El equipo está corrigiendo la app para que funcione bien. No tenés que hacer nada.', 'The team is fixing the app so it works properly. You don\'t need to do anything.')],
  [180, tr('Seguimos ajustando…', 'Still adjusting…'), tr('Tu app va a estar lista en unos minutos; se abre sola acá.', 'Your app will be ready in a few minutes; it opens here by itself.')],
  [360, tr('Ya casi está, gracias por la paciencia', 'Almost done, thanks for your patience'), tr('Estamos terminando y la volvemos a abrir.', 'We are finishing and opening it again.')],
]

function RunWait({ since, fixing }: { since?: number; fixing: boolean }) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => window.clearInterval(id)
  }, [])
  const secs = Math.max(0, now - (since ?? now))
  const steps = fixing ? WAIT_FIX() : WAIT_START()
  const [, caption, sub] = [...steps].reverse().find(([t]) => secs >= t) ?? steps[0]
  return <PanelLoader caption={caption} sub={sub} />
}

/** Muse Team needs the user: a big fix to approve, an error that keeps coming back, or a fix that could not start by itself. */
function RunFixCard({ fix, onDone }: { fix: RunFix; onDone: () => void }) {
  const T = useT()
  const b = useBuild()
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (action: 'approve' | 'fix' | 'dismiss') => {
    if (!b.sessionId || !b.id || !fix.id) return
    setBusy(action)
    try { await api.appErrorAction(b.sessionId, b.id, fix.id, action); reconnectBuild(b.id); onDone() } catch (e) { toast.error(tr('No se pudo', 'Could not do it'), (e as Error).message) } finally { setBusy(null) }
  }
  const title = fix.state === 'needs_approval' ? T('Para que funcione hace falta un cambio grande', 'Making it work needs a big change')
    : fix.state === 'stuck' ? T('La app sigue con un problema', 'The app still has a problem')
    : T('La app tiene un problema para arrancar', 'The app has a problem starting')
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-gold/40 bg-gold/5 p-5 shadow-[0_14px_30px_-18px_rgba(30,38,34,.4)]">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-gold" />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink">{title}</div>
            {fix.what && <div className="mt-1 text-[13px] leading-snug text-ink-2">{fix.what}</div>}
          </div>
        </div>
        <dl className="mt-3 space-y-2 pl-7 text-[12.5px] leading-snug">
          {fix.state === 'stuck' && <div className="text-ink-2">{T('Lo intentamos arreglar dos veces y vuelve a pasar: conviene mirarlo con más calma.', 'We tried to fix it twice and it happens again: it deserves a closer look.')}</div>}
          {fix.state === 'manual' && <div className="text-ink-2">{fix.reason === 'busy' ? T('El constructor está terminando otro trabajo. Cuando quieras, lo arreglamos.', 'The builder is finishing other work. Whenever you want, we fix it.') : fix.reason === 'limit' ? T('Hoy ya hicimos varios arreglos automáticos en esta app: este lo hacemos cuando nos digas.', 'We already made several automatic fixes on this app today: we do this one when you say so.') : T('Cuando quieras, lo arreglamos.', 'Whenever you want, we fix it.')}</div>}
          {fix.fix && <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">{T('Cómo se arregla', 'How it gets fixed')}</dt><dd className="mt-0.5 text-ink-2">{fix.fix}</dd></div>}
          {fix.impact && <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">{T('Qué cambia para vos', 'What changes for you')}</dt><dd className="mt-0.5 text-ink-2">{fix.impact}</dd></div>}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2 pl-7">
          {fix.state === 'needs_approval'
            ? <button disabled={!!busy} onClick={() => act('approve')} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">{busy === 'approve' ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} {T('Aprobar y arreglar', 'Approve and fix')}</button>
            : <button disabled={!!busy || !fix.id} onClick={() => act('fix')} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">{busy === 'fix' ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} {fix.state === 'stuck' ? T('Intentar de nuevo', 'Try again') : T('Arreglarlo ahora', 'Fix it now')}</button>}
          {fix.state === 'needs_approval' && <button disabled={!!busy} onClick={() => act('dismiss')} className="flex h-9 items-center rounded-full border border-line bg-paper px-4 text-[12.5px] text-ink-2 transition hover:border-accent hover:text-accent">{T('Ahora no', 'Not now')}</button>}
        </div>
      </div>
    </div>
  )
}

/** The iOS Simulator / Android emulator screen, refreshed every second, inside a phone frame. Android takes taps. */
function DeviceView({ target, sessionId, buildId }: { target: 'ios' | 'android'; sessionId: string; buildId: string }) {
  const T = useT()
  const [src, setSrc] = useState<string>(() => api.runScreenUrl(sessionId, buildId, target) + Date.now())
  const [failed, setFailed] = useState(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const id = window.setInterval(() => setSrc(api.runScreenUrl(sessionId, buildId, target) + Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [sessionId, buildId, target])
  const onTap = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (target !== 'android' || !natural) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.round(((e.clientX - r.left) / r.width) * natural.w)
    const y = Math.round(((e.clientY - r.top) / r.height) * natural.h)
    await api.runTap(sessionId, buildId, target, x, y).catch(() => {})
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-paper/60 p-4">
      <div className="relative flex max-h-full items-center justify-center rounded-[38px] border-[10px] border-[#1E2622] bg-black shadow-[0_30px_60px_-24px_rgba(30,38,34,.7)]" style={{ aspectRatio: natural ? `${natural.w} / ${natural.h}` : '9 / 19.5', height: 'min(100%, 760px)' }}>
        {!failed ? (
          <img src={src} alt="" onLoad={(e) => { setFailed(false); const im = e.currentTarget; if (im.naturalWidth && (!natural || natural.w !== im.naturalWidth)) setNatural({ w: im.naturalWidth, h: im.naturalHeight }) }} onError={() => setFailed(true)} onClick={onTap} className={`h-full w-full rounded-[28px] object-contain ${target === 'android' ? 'cursor-pointer' : ''}`} draggable={false} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[28px] bg-[#111] px-6 text-center text-[12.5px] text-white/80">
            <Loader2 size={18} className="animate-spin text-white/60" />
            {T('Esperando al dispositivo… Expo lo enciende e instala Expo Go la primera vez (puede tardar un minuto).', 'Waiting for the device… Expo boots it and installs Expo Go the first time (it can take a minute).')}
            <button onClick={() => { setFailed(false); setSrc(api.runScreenUrl(sessionId, buildId, target) + Date.now()) }} className="mt-1 rounded-full border border-white/30 px-3 py-1 text-[11.5px] text-white/80 hover:bg-white/10">{T('Reintentar', 'Retry')}</button>
          </div>
        )}
      </div>
      <div className="text-[11.5px] text-ink-3">
        {target === 'android' ? T('Tocá la pantalla para interactuar (los toques van al emulador).', 'Tap the screen to interact (taps go to the emulator).') : T('Vista en vivo del simulador. Para interactuar, usá la ventana del Simulador de iOS que se abrió en tu Mac.', 'Live view of the simulator. To interact, use the iOS Simulator window that opened on your Mac.')}
      </div>
    </div>
  )
}

/** What the user is looking at inside the app (same origin when it runs through Muse Team): the visible text, the error messages
 *  on screen, the page's last failed requests and errors (kept by Muse Team's reporter) and a screenshot of the visible part. */
async function captureFrame(f: HTMLIFrameElement | null) {
  const out = { page: '', text: '', alerts: [] as string[], log: [] as unknown[], screenshot: '' }
  type FrameWin = Window & { __tably?: { log: unknown[] } }
  let doc: Document | null = null
  let win: FrameWin | null = null
  try { doc = f?.contentDocument ?? null; win = (f?.contentWindow as FrameWin | null) ?? null } catch { return out }
  if (!f || !doc?.body || !win) return out
  try { out.page = win.location.pathname + win.location.search } catch { /* cross-origin */ }
  out.text = (doc.body.innerText || '').slice(0, 2500)
  const sel = '[role=alert],[aria-live=assertive],[class*="error" i],[class*="danger" i],[class*="destructive" i],[class*="alert" i]'
  out.alerts = [...new Set([...doc.querySelectorAll<HTMLElement>(sel)].map((e) => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 400))].slice(0, 6)
  out.log = win.__tably?.log ?? []
  try {
    const { toJpeg } = await import('html-to-image')
    const w = f.clientWidth, h = f.clientHeight, sx = win.scrollX, sy = win.scrollY
    out.screenshot = await toJpeg(doc.documentElement, { quality: 0.75, pixelRatio: 1, width: w, height: h, backgroundColor: '#ffffff', style: { transform: `translate(${-sx}px, ${-sy}px)`, width: `${w}px` } })
  } catch { /* no screenshot: the text and the log still go */ }
  return out
}

/** "App real": run the built product on this machine and show it live (instead of the static prototype). */
export default function AppRunner({ autoStart = false }: { autoStart?: boolean }) {
  const T = useT()
  const b = useBuild()
  const run = b.appRun
  const [services, setServices] = useState<RunService[] | null>(null)
  const [service, setService] = useState<string>('')
  const [logsOpen, setLogsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])
  const logRef = useRef<HTMLPreElement>(null)
  const step = STEP()

  const load = () => {
    if (!b.sessionId || !b.id) return
    api.appRun(b.sessionId, b.id).then((d) => {
      setServices(d.services)
      setService((s) => s || d.run?.service || d.services.find((x) => x.web)?.id || d.services[0]?.id || '')
      // a run started earlier (or from another tab) is shown as it is, not as "ready to run"
      const r = d.run
      const cur = useBuild.getState().appRun
      if (r && (cur.status === 'idle' || cur.status === 'stopped' || cur.service !== r.service || cur.url !== r.url || cur.status !== r.status || JSON.stringify(cur.fix ?? null) !== JSON.stringify(r.fix ?? null))) {
        useBuild.getState().set({ appRun: { status: r.status, service: r.service, label: r.label, url: r.url ?? null, embedUrl: r.embed_url ?? null, port: r.port ?? null, error: r.error ?? null, logs: r.logs ?? cur.logs, fix: r.fix ?? null, started: r.started } })
        if (r.status === 'installing' || r.status === 'starting' || r.status === 'running') reconnectBuild(b.id!)
      }
    }).catch((e) => toast.error(tr('No pude analizar el proyecto', 'Could not analyze the project'), (e as Error).message))
  }
  useEffect(load, [b.sessionId, b.id, Object.keys(b.files).length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [run.logs.length])
  useEffect(() => {
    if (run.status === 'error' && !run.fix) setLogsOpen(true)
  }, [run.status, run.fix])
  // opened from "Correr la app": start right away if nothing is running yet
  const [autoDone, setAutoDone] = useState(false)
  useEffect(() => {
    if (!autoStart || autoDone || !services || !service || !b.sessionId || !b.id) return
    if (run.status === 'idle' || run.status === 'stopped') {
      setAutoDone(true)
      api.appStart(b.sessionId, b.id, service).then(() => reconnectBuild(b.id!)).catch((e) => { const msg = (e as Error).message; if (/ya está corriendo|already running/i.test(msg)) { load(); reconnectBuild(b.id!) } else setNotice(msg) })
    } else setAutoDone(true)
  }, [autoStart, autoDone, services, service, run.status, b.sessionId, b.id])

  const start = async () => {
    if (!b.sessionId || !b.id || !service) return
    setBusy(true)
    setNotice(null)
    try {
      await api.appStart(b.sessionId, b.id, service)
      reconnectBuild(b.id) // the build's websocket carries app.status / app.log
    } catch (e) {
      const msg = (e as Error).message
      if (/ya está corriendo|already running/i.test(msg)) {
        // not an error: show the run that is already there
        setNotice(tr('La app ya estaba corriendo: te la muestro tal como está.', 'The app was already running: showing it as it is.'))
        load()
        reconnectBuild(b.id)
      } else setNotice(msg)
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    if (!b.sessionId || !b.id) return
    await api.appStop(b.sessionId, b.id).catch(() => {})
  }
  const askFix = async () => {
    if (!b.id) return
    const tail = run.logs.slice(-40).join('\n')
    const text = `Al correr la app (${run.label ?? run.service}) falló: ${run.error ?? ''}\n\nÚltimas líneas del log:\n\`\`\`\n${tail}\n\`\`\`\nArreglalo para que arranque con \`${services?.find((s) => s.id === run.service)?.run ?? 'el comando de dev'}\` y quede navegable.`
    await api.buildMessage(b.id, text, b.sessionId).catch((e) => toast.error(tr('No se pudo enviar', 'Could not send'), (e as Error).message))
    useBuild.getState().set({ status: 'connecting', error: null, pane: 'code' })
    reconnectBuild(b.id)
  }

  const frameRef = useRef<HTMLIFrameElement>(null)
  const fullRef = useRef<HTMLIFrameElement>(null)
  const [sending, setSending] = useState(false)
  // «Enviar al constructor»: what the user is seeing right now (screenshot, error on screen, failed requests, server log)
  const report = async () => {
    if (!b.sessionId || !b.id || sending) return
    setSending(true)
    try {
      const cap = await captureFrame(fullRef.current ?? frameRef.current)
      const r = await api.runReport(b.sessionId, b.id, cap)
      toast.info(tr('Enviado al constructor', 'Sent to the builder'), r.queued ? tr('Lo toma apenas termine lo que está haciendo.', 'It picks it up as soon as it finishes what it is doing.') : tr('Está buscando dónde está el error; cuando lo arregle, la app vuelve a abrirse sola.', 'It is looking for where the error is; once fixed, the app opens again by itself.'))
      setFull(false)
      load()
    } catch (e) {
      toast.error(tr('No se pudo enviar', 'Could not send'), (e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const reportBtn = (small = false) => (
    <button onClick={report} disabled={sending} className={`flex ${small ? 'h-7 text-[11.5px]' : 'h-8 text-[12px]'} items-center gap-1.5 rounded-full bg-accent px-3 font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60`} title={T('Mandale al constructor lo que estás viendo (con captura y el error exacto) para que lo arregle', 'Send the builder what you are seeing (with a screenshot and the exact error) so it fixes it')}>
      {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {sending ? T('Enviando…', 'Sending…') : T('Enviar al constructor', 'Send to the builder')}
    </button>
  )

  const active = run.status === 'installing' || run.status === 'starting' || run.status === 'running'
  // Muse Team fixing the app by itself: a loader, never the dead app; a card only when it needs the user
  const fixWait = !!run.fix && (run.fix.state === 'fixing' || run.fix.state === 'restarting')
  const fixCard = !!run.fix && !fixWait
  useEffect(() => {  // a finished build may have no live socket: follow the fix until the app is back
    if (!fixWait) return
    const id = window.setInterval(load, 5000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixWait, b.sessionId, b.id])
  const sel = services?.find((s) => s.id === service)

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line">
        {services === null ? (
          <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3"><Loader2 size={12} className="animate-spin" /> {T('Analizando el proyecto…', 'Analyzing the project…')}</span>
        ) : services.length === 0 ? (
          <span className="text-[12.5px] text-ink-2">{T('No encontré nada que se pueda correr (sin package.json con script ', 'Found nothing runnable (no package.json with a ')}<code className="font-mono">dev</code>{T(', ni API Python, ni docker compose).', ' script, no Python API, no docker compose).')}</span>
        ) : (
          <>
            <select disabled={active} value={service} onChange={(e) => setService(e.target.value)} className="h-9 rounded-full border border-line bg-paper px-3 text-[12.5px] shadow-sm disabled:opacity-60">
              {services.map((s) => <option key={s.id} value={s.id}>{s.label}{s.web ? '' : T(' (sin UI)', ' (no UI)')}</option>)}
            </select>
            {!active ? (
              <button disabled={busy || !service || sel?.available === false} onClick={start} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {T('Correr la app', 'Run the app')}
              </button>
            ) : (
              <button onClick={stop} className="flex h-9 items-center gap-1.5 rounded-full border border-danger/40 bg-paper px-4 text-[12.5px] font-semibold text-danger shadow-sm transition hover:bg-danger/5"><Square size={13} /> {T('Detener', 'Stop')}</button>
            )}
            <span className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium ${fixWait ? 'border-accent/30 bg-accent-soft text-accent' : fixCard ? 'border-gold/40 bg-gold/10 text-gold' : run.status === 'running' ? 'border-ok/30 bg-ok/10 text-ok' : run.status === 'error' ? 'border-danger/30 bg-danger/5 text-danger' : 'border-line bg-paper text-ink-3'}`}>
              {(run.status === 'installing' || run.status === 'starting' || fixWait) && <Loader2 size={12} className="animate-spin" />}
              {run.status === 'running' && <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />}
              {fixWait ? T('Cargando…', 'Loading…') : fixCard ? T('En pausa', 'Paused') : (step[run.status] ?? run.status)}{run.status === 'running' && run.url && !fixWait ? ` ${T('en', 'at')} ${run.url}` : ''}
            </span>
            {run.status === 'running' && run.url && !fixWait && (
              <div className="ml-auto flex items-center gap-1.5">
                {!sel?.device && reportBtn()}
                <button onClick={() => setFrameKey((k) => k + 1)} className="flex h-8 items-center gap-1 rounded-full border border-line bg-paper px-2.5 text-[12px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent" title={T('Recargar la app', 'Reload the app')}><RefreshCw size={12} /> {T('recargar', 'reload')}</button>
                <a href={run.url} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1 rounded-full border border-line bg-paper px-2.5 text-[12px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent" title={T('Abrir en una pestaña nueva', 'Open in a new tab')}><ExternalLink size={12} /> {T('pestaña', 'tab')}</a>
                <button onClick={() => setFull(true)} className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-paper text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent" title={T('Ver la app a pantalla completa', 'View the app full screen')}><Maximize2 size={13} /></button>
              </div>
            )}
          </>
        )}
      </div>
      {sel?.device && sel.available === false && (
        <div className="border-b border-line px-3 py-2"><BlockedNotice kind="blocked" title={sel.device === 'ios' ? T('El simulador de iOS no está disponible en esta máquina', 'The iOS Simulator is not available on this machine') : T('El emulador de Android no está disponible en esta máquina', 'The Android emulator is not available on this machine')} text={sel.hint ?? ''} /></div>
      )}
      {sel && !active && run.status !== 'error' && (
        <div className="px-3 py-1.5 text-[11.5px] text-ink-3 border-b border-line font-mono">{sel.dir === '.' ? '' : `${sel.dir}/ · `}{sel.needs_install ? `${sel.install} → ` : ''}{sel.run.replace('{port}', T('<puerto libre>', '<free port>'))}</div>
      )}

      {(notice || (!fixWait && (b.status === 'running' || b.status === 'reviewing' || b.status === 'connecting'))) && (
        <div className="space-y-2 border-b border-line px-3 py-2">
          {notice && <BlockedNotice kind={/ya estaba|already/.test(notice) ? 'info' : 'blocked'} title={notice} action={{ label: T('Cerrar', 'Close'), onClick: () => setNotice(null) }} />}
          {!fixWait && <BuilderBusyNotice what={T('La app puede cambiar mientras corre: los archivos se están escribiendo.', 'The app may change while it runs: files are being written.')} />}
        </div>
      )}
      {/* body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {services === null ? (
          <PanelLoader caption={T('Analizando el proyecto…', 'Analyzing the project…')} sub={T('Buscando qué se puede correr: package.json, APIs en Python, docker compose.', 'Looking for what can run: package.json, Python APIs, docker compose.')} />
        ) : fixWait ? (
          <RunWait since={run.fix?.since ?? run.started} fixing />
        ) : fixCard && run.fix ? (
          <RunFixCard fix={run.fix} onDone={load} />
        ) : (run.status === 'installing' || run.status === 'starting') && !logsOpen ? (
          <RunWait since={run.started} fixing={false} />
        ) : run.status === 'running' && sel?.device && b.sessionId && b.id ? (
          <DeviceView target={sel.device} sessionId={b.sessionId} buildId={b.id} />
        ) : run.status === 'running' && run.url && sel?.web !== false ? (
          <div className="flex-1 min-h-0 p-3">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-white shadow-[0_14px_30px_-18px_rgba(30,38,34,.45)]">
              <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/70 px-3">
                <span className="h-2.5 w-2.5 rounded-full bg-[#E6A19A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#E9C97A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#9FCDA8]" />
                <span className="ml-3 flex h-5 items-center rounded-md border border-line bg-surface px-2 font-mono text-[10.5px] text-ink-2">{run.url}</span>
                <span className="ml-2 text-[10.5px] text-ink-3">{/\/r\//.test(run.url) ? T('la app real, corriendo en Muse Team', 'the real app, running on Muse Team') : T('la app real, corriendo en esta máquina', 'the real app, running on this machine')}</span>
                <button onClick={() => setFull(true)} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface hover:text-accent" title={T('Pantalla completa', 'Full screen')}><Maximize2 size={13} /></button>
              </div>
              {!full && <iframe ref={frameRef} key={frameKey} title={T('App corriendo', 'App running')} src={run.embedUrl ?? run.url} className="min-h-0 w-full flex-1 bg-white" />}
              {full && <div className="flex flex-1 items-center justify-center text-[12.5px] text-ink-3">{T('La app está a pantalla completa.', 'The app is in full screen.')}</div>}
            </div>
          </div>
        ) : run.status === 'error' ? (
          <div className="p-4">
            <div className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3">
              <div className="font-semibold text-danger">{run.error ?? T('La app no arrancó', 'The app did not start')}</div>
              <div className="mt-1 text-[12.5px] text-ink-2">{T('Pasa seguido en una primera corrida (una dependencia que falta, una variable de entorno, un puerto). Podés pedirle al constructor que lo arregle con el log, y volver a correrla.', 'This often happens on a first run (a missing dependency, an environment variable, a port). You can ask the builder to fix it using the log, then run it again.')}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={askFix} className="flex items-center gap-1.5 rounded-lg bg-accent text-white px-3 py-1.5 text-[12.5px] font-semibold hover:brightness-110"><Wrench size={13} /> {T('Pedirle al constructor que lo arregle', 'Ask the builder to fix it')}</button>
                <button onClick={start} className="flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12.5px]"><Play size={13} /> {T('Reintentar', 'Retry')}</button>
              </div>
            </div>
          </div>
        ) : run.status === 'installing' || run.status === 'starting' ? (
          <div className="p-6 text-center text-sm text-ink-2">
            <Loader2 size={22} className="mx-auto animate-spin text-accent" />
            <div className="mt-2 font-medium">{step[run.status]}</div>
            <div className="mt-1 text-[12px] text-ink-3">{run.status === 'installing' ? T('La primera vez puede tardar unos minutos.', 'The first time may take a few minutes.') : T('Esperando a que el servidor responda en el puerto asignado…', 'Waiting for the server to respond on the assigned port…')}</div>
          </div>
        ) : services && services.length > 0 ? (
          <div className="flex flex-1 items-center justify-center p-3 sm:p-6">
            <div className="w-full max-w-lg rounded-2xl border border-line bg-paper p-4 text-center sm:p-6 shadow-[0_14px_30px_-18px_rgba(30,38,34,.4)]">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent"><MonitorPlay size={22} /></span>
              <div className="mt-3 text-[17px] font-semibold text-ink">{T('Corré la app real acá adentro', 'Run the real app right here')}</div>
              <div className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-3">{T('Se instala lo que falte, se levanta el servidor de desarrollo en un puerto libre de esta máquina y la app se muestra en este panel. Las variables de «Servicios» se cargan como ', 'What is missing is installed, the dev server starts on a free port on this machine and the app shows in this panel. The variables from "Services" are loaded as ')}<code className="font-mono">.env</code>.</div>
              <ol className="mx-auto mt-4 grid max-w-md grid-cols-1 gap-2 text-left sm:grid-cols-3 text-[11.5px] text-ink-2">
                {[T('Instala dependencias', 'Installs dependencies'), T('Levanta el servidor', 'Starts the server'), T('La muestra acá', 'Shows it here')].map((t, i) => (
                  <li key={t} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-white">{i + 1}</span>{t}</li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}

        {/* full screen: the app takes the whole window; Esc or the corner button bring it back */}
        {full && run.status === 'running' && run.url && createPortal(
          <div className="fixed inset-0 z-[300] flex flex-col bg-white">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#E6A19A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#E9C97A]" /><span className="h-2.5 w-2.5 rounded-full bg-[#9FCDA8]" />
              <span className="ml-3 flex h-6 items-center rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink-2">{run.url}</span>
              <span className="ml-2 text-[11px] text-ink-3">{T('App real · pantalla completa · Esc para volver', 'Real app · full screen · Esc to go back')}</span>
              <span className="ml-auto">{reportBtn(true)}</span>
              <button onClick={() => setFrameKey((k) => k + 1)} className="flex h-7 items-center gap-1 rounded-full border border-line bg-paper px-2.5 text-[11.5px] text-ink-2 transition hover:border-accent hover:text-accent"><RefreshCw size={12} /> {T('recargar', 'reload')}</button>
              <button onClick={() => setFull(false)} className="flex h-7 items-center gap-1 rounded-full bg-accent px-3 text-[11.5px] font-semibold text-white transition hover:brightness-110"><Minimize2 size={12} /> {T('Volver', 'Back')}</button>
            </div>
            <iframe ref={fullRef} key={`full-${frameKey}`} title={T('App corriendo', 'App running')} src={run.embedUrl ?? run.url} className="min-h-0 w-full flex-1 bg-white" />
          </div>,
          document.body,
        )}

        {/* logs */}
        {(run.logs.length > 0 || active) && (
          <div className={`border-t border-line ${logsOpen ? 'h-56' : ''} flex flex-col shrink-0`}>
            <button onClick={() => setLogsOpen(!logsOpen)} className="flex items-center gap-1 px-3 py-1.5 text-[11.5px] text-ink-3 hover:text-ink"><ChevronDown size={12} className={`transition ${logsOpen ? 'rotate-180' : ''}`} /> {T('logs del servidor', 'server logs')} ({run.logs.length})</button>
            {logsOpen && <pre ref={logRef} className="flex-1 min-h-0 overflow-auto scroll-thin bg-[#1E2622] text-[#E6ECE8] px-3 py-2 text-[11px] font-mono whitespace-pre-wrap">{run.logs.join('\n')}</pre>}
          </div>
        )}
      </div>
    </div>
  )
}

import { AnimatePresence } from 'framer-motion'
import { TeamMemoryWatcher, TeamPage } from './components/TeamMemory'
import AnalyticsPage from './components/AnalyticsPage'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import ArenaGraph from './components/ArenaGraph'
import AgentDrawer from './components/AgentDrawer'
import BriefExport from './components/BriefExport'
import AuditSetup from './components/AuditSetup'
import Builder from './components/Builder'
import BuilderIntro from './components/BuilderIntro'
import Captions from './components/Captions'
import LiveFeed from './components/LiveFeed'
import { CostChart, LatencyChart, StatTiles, Timeline, TokensChart } from './components/Metrics'
import Landing from './components/Landing'
import Login from './components/Login'
import Settings from './components/Settings'
import Setup from './components/Setup'
import { ErrorBoundary, Toaster, notify, requestNotifications, toast } from './components/Toast'
import TopBar from './components/TopBar'
import { PauseModal, TeamModal } from './components/TeamModal'
import Verdict from './components/Verdict'
import VideoExport, { type VideoOptions } from './components/VideoExport'
import RunModal from './components/RunModal'
import AgentSessions from './components/AgentSessions'
import Marketplace from './components/Marketplace'
import Tickets from './components/Tickets'
import { TICKETS_ENABLED } from './lib/flags'
import ResearchOverlay from './components/ResearchOverlay'
import { api, auth, connect, connectBuild, replay } from './lib/api'
import { tr, useT } from './lib/i18n'
import { downloadBlob, requestTabStream, slug, startRecording } from './lib/recorder'
import { setSfx, sfx, sfxEnabled } from './lib/sfx'
import { LOOK_SWITCH, newLookOn, setBuilderLook, setNewLook } from './lib/look'
import { setReconnectBuild, useBuild } from './buildStore'
import { useArena } from './store'
import type { ArenaEvent, SessionConfig } from './types'
// the Ad Studio (uploads, the five agents, the renders) loads only when it opens
const AdStudio = lazy(() => import('./components/AdStudio'))
const AdTier = lazy(() => import('./components/AdTier'))

function onEvent(ev: ArenaEvent) {
  useArena.getState().apply(ev)
  if (ev.type === 'handoff') sfx.handoff()
  else if (ev.type === 'turn.started') sfx.turn()
  else if (ev.type === 'vote') sfx.vote()
  else if (ev.type === 'verdict') sfx.verdict()
  else if (ev.type === 'notice') toast.info(tr('Reintentando', 'Retrying'), String(ev.text ?? ''))
}

/** Red banner while the API is unreachable (e.g. the backend process was stopped). */
function OfflineBanner() {
  const T = useT()
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    let alive = true
    const check = () => api.health().then(() => alive && setOffline(false)).catch(() => alive && setOffline(true))
    check()
    const id = setInterval(check, 10000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  if (!offline) return null
  return (
    <div className="fixed top-0 inset-x-0 z-[100] bg-danger text-white text-sm text-center py-1.5 px-4 shadow">
      {T('El backend no responde en localhost:8000. Levantalo con', 'The backend is not responding on localhost:8000. Start it with')} <code className="font-mono bg-white/15 px-1 rounded">make dev</code> {T('en la carpeta del proyecto; esta pantalla se reconecta sola.', 'in the project folder; this screen reconnects on its own.')}
    </div>
  )
}

function AppInner() {
  const T = useT()
  const view = useArena((s) => s.view)
  useEffect(() => { setBuilderLook(view === 'builder') }, [view])
  const layout = useArena((s) => s.layout)
  const recMode = useArena((s) => s.recMode)
  const agentCount = useArena((s) => s.config?.agents.length ?? 4)
  const showVideoExport = useArena((s) => s.showVideoExport)
  const showTeam = useArena((s) => s.showTeam)
  const focus = useArena((s) => s.focus)
  const showBriefExport = useArena((s) => s.showBriefExport)
  const user = useArena((s) => s.user)
  const authChecked = useArena((s) => s.authChecked)
  const [gate, setGate] = useState<'landing' | 'login' | 'signup'>(location.hash === '#login' ? 'login' : location.hash === '#signup' ? 'signup' : 'landing')
  const cleanup = useRef<(() => void) | null>(null)
  const buildWs = useRef<(() => void) | null>(null)
  const [intro, setIntro] = useState<{ provider: string; model: string; title: string } | null>(null)

  const leave = () => {
    cleanup.current?.()
    cleanup.current = null
    useArena.getState().reset({ view: 'setup', source: 'live' })
    history.replaceState(null, '', location.pathname)
  }

  const start = async (cfg: SessionConfig) => {
    const { id } = await api.start(cfg)
    // the council in focus from the first turn: the agents talking are the show, feed and charts stay small
    useArena.getState().reset({ view: 'arena', source: 'live', status: 'connecting', sessionId: id, config: cfg, focus: true })
    history.replaceState(null, '', `#live=${id}`)
    cleanup.current = connect(id, onEvent, () => {})
  }

  /** Fast lane: the prompt becomes the brief, the builder starts, the builder view opens (no council). */
  const direct = async (cfg: SessionConfig) => {
    const engines = await api.engines().catch(() => [])
    const ok = engines.find((e) => e.ok)
    const providers = await api.providers().catch(() => [])
    const apiProv = providers.find((p) => p.configured && p.id !== 'mock') ?? providers.find((p) => p.id === 'mock')
    const provider = cfg.builder?.provider || (ok?.id ?? apiProv?.id ?? 'mock')
    const model = cfg.builder?.provider ? cfg.builder.model : ok ? 'default' : apiProv?.default_model ?? 'mock-1'
    const r = await api.directBuild({ topic: cfg.topic, title: cfg.title, platform: cfg.platform, references: cfg.references ?? [], deep_analysis: !!cfg.deep_analysis, context: cfg.context ?? null, language: cfg.language, agents: cfg.agents, provider, model, target: 'claude-code', design: true })
    await openSaved(r.session_id, true, true)
  }

  /** Same brief and team, from scratch (a failed turn, a model outage…). Run soon after and the cached role context is reused. */
  const rerun = async () => {
    const cfg = useArena.getState().config
    if (!cfg) return
    cleanup.current?.()
    useArena.getState().set({ showVerdict: false })
    try {
      await start({ ...cfg })
    } catch (e) {
      toast.error(tr('No se pudo volver a correr', 'Could not run again'), (e as Error).message)
    }
  }

  const verdictEl = (
    <Verdict
            onRerun={rerun}
            onRedebate={async (note, decisions) => {
              // a new debate on the same team: the previous decisions are the starting point, the user's request the priority
              const cfg = useArena.getState().config
              if (!cfg) return
              const topic = `${cfg.topic.trim()}\n\n## ${tr('Decisiones de la ronda anterior', 'Decisions from the previous round')}\n${decisions || '—'}\n\n## ${tr('Pedido del usuario para esta ronda (prioridad)', "User's request for this round (priority)")}\n${note}`
              cleanup.current?.()
              useArena.getState().set({ showVerdict: false })
              try {
                await start({ ...cfg, topic, title: cfg.title ? `${cfg.title} · ${tr('ronda 2', 'round 2')}` : cfg.title })
              } catch (e) {
                toast.error(tr('No se pudo volver a debatir', 'Could not debate again'), (e as Error).message)
              }
            }}
    />
  )

  /** Loads a finished session instantly (all events applied, no timing). */
  /** Audit sessions have no debate: open their (latest) build straight in the builder. */
  const openAuditSession = async (id: string, config: SessionConfig) => {
    const builds = await api.builds(id)
    useArena.getState().reset({ view: 'builder', sessionId: id, config, source: 'replay', status: 'completed' })
    history.replaceState(null, '', `#live=${id}`)
    if (builds[0]) await openBuild(builds[0].id)
    else useArena.getState().set({ view: 'setup' })
  }

  const openSaved = async (id: string, preferBuild = true, direct = false) => {
    const data = await api.session(id)
    if (data.config?.mode === 'audit') return openAuditSession(id, data.config)
    cleanup.current?.()
    // the arena state is loaded in any case (the builder's "← Consejo" needs it), but when the destination is the
    // builder the arena is never shown: the home loader stays up until the build is ready
    const toBuilder = preferBuild && data.config?.mode !== 'review'
    const prevView = useArena.getState().view
    useArena.getState().reset({ view: toBuilder ? prevView : 'arena', source: 'replay', status: 'connecting', sessionId: id })
    history.replaceState(null, '', `#live=${id}`)
    for (const ev of data.events) useArena.getState().apply(ev)
    // a finished council round opens on its verdict (the change list + "build with these changes"); debates open quiet
    useArena.getState().set({ showVerdict: data.config?.mode === 'review' && !!useArena.getState().council })
    // a project that already has a build opens on the build (the debate stays one click away: "← Consejo")
    if (toBuilder) {
      const builds = await api.builds(id).catch(() => [])
      // a build waiting for the user (design approval) or still working comes first; then the newest usable one
      const latest = builds.find((x) => ['design_review', 'running', 'reviewing'].includes(x.status)) ?? builds.find((x) => x.status !== 'error') ?? builds[0]
      if (latest?.pending_council && !direct) return openSaved(latest.pending_council, false)  // the council already spoke: decide first
      if (latest) return openBuild(latest.id)
    }
    useArena.getState().set({ view: 'arena' })
  }

  const startReplay = async (id: string) => {
    const data = await api.session(id)
    if (data.config?.mode === 'audit') return openAuditSession(id, data.config)
    cleanup.current?.()
    useArena.getState().reset({ view: 'arena', source: 'replay', status: 'connecting', sessionId: id })
    history.replaceState(null, '', `#replay=${id}`)
    cleanup.current = replay(data.events, () => useArena.getState().speed, onEvent, () => {})
  }

  /** Starts an in-app build from the cached brief: logo intro, then the builder UI streams the files. */
  const startBuild = async (provider: string, model: string, target: string, record = false, reviewRounds = 0, priorities = '', design = true, research: { research?: boolean; references?: string[]; deep_analysis?: boolean } = {}) => {
    const st = useArena.getState()
    const sessionId = st.sessionId!
    let stream: MediaStream | null = null
    if (record) {
      try {
        stream = await requestTabStream(false) // must happen inside the click gesture
      } catch {
        stream = null
      }
    }
    const { id } = await api.startBuild(sessionId, provider, model, target, reviewRounds, priorities, design, research)
    const title = st.config?.title || st.config?.topic || tr('proyecto', 'project')
    useBuild.getState().reset({ id, sessionId, provider, model, title, status: 'connecting' })
    st.set({ showBriefExport: false, view: 'builder' })
    setIntro({ provider, model, title })
    openBuildWs(id)
    if (stream) {
      await new Promise((r) => setTimeout(r, 700))
      const rec = await startRecording(stream, document.querySelector<HTMLElement>('[data-capture="builder"]'))
      useBuild.getState().set({ recording: true })
      const finish = async () => {
        unsub()
        const blob = await rec.stop()
        useBuild.getState().set({ recording: false })
        downloadBlob(blob, `tablyteam-construccion-${slug(title)}.${rec.mime.includes('mp4') ? 'mp4' : 'webm'}`)
      }
      // stop ~6 s after the build finishes (so the preview is on screen), or when the user ends the share
      const unsub = useBuild.subscribe((b, prev) => {
        if ((prev.status === 'running' || prev.status === 'reviewing') && (b.status === 'approved' || b.status === 'stopped' || b.status === 'error' || (b.status === 'completed' && !b.reviewPlan))) setTimeout(finish, 6000)
      })
      rec.ended.then(finish)
    }
  }

  /** Uploads a project and opens the builder in audit mode. */
  const startAudit = async (form: FormData) => {
    const { id, session_id, council } = await api.createAudit(form)
    const name = String(form.get('name') ?? tr('proyecto', 'project'))
    const provider = String(form.get('provider') ?? 'mock')
    const model = String(form.get('model') ?? '')
    if (council) {
      // the audit is a council round: watch the debate live; its verdict leads to «construir con estos cambios»
      useBuild.getState().reset({ id, sessionId: session_id, provider, model, title: name, status: 'completed', mode: 'build' })
      watchLive(council)
      return
    }
    useArena.getState().reset({ view: 'builder', sessionId: session_id, config: null })
    useBuild.getState().reset({ id, sessionId: session_id, provider, model, title: name, status: 'connecting', mode: 'audit' })
    setIntro({ provider, model, title: name })
    openBuildWs(id)
  }

  /** Opens the build socket; closing it on purpose (reconnect, leaving) must not look like a server crash. */
  const openBuildWs = (id: string) => {
    buildWs.current?.()
    let intentional = false
    const close = connectBuild(id, (ev) => useBuild.getState().apply(ev), () => { if (!intentional) onBuildClosed() }, useBuild.getState().sessionId)
    buildWs.current = () => { intentional = true; close() }
  }

  /** The build websocket closed: if the server didn't tell us the build ended, the server itself went away (restart). */
  const onBuildClosed = () => {
    const b = useBuild.getState()
    if (b.status === 'running' || b.status === 'reviewing' || b.status === 'connecting') {
      b.set({ status: 'stopped', liveTurn: null, livePhase: null, error: tr('Se perdió la conexión con el servidor (¿se reinició?). Lo escrito está guardado: reabrí el proyecto desde el inicio y apretá «Retomar la construcción».', 'Lost the connection to the server (did it restart?). What was written is saved: reopen the project from the home screen and press «Resume the build».') })
      toast.error(tr('Construcción interrumpida', 'Build interrupted'), tr('El servidor se desconectó. Reabrí el proyecto y retomala; no se pierde nada.', 'The server disconnected. Reopen the project and resume it; nothing is lost.'))
    }
  }

  /** Reopens a previous build (live → websocket, finished → saved snapshot). */
  const openBuild = async (id: string, show = true) => {
    const st = useArena.getState()
    const sessionId = st.sessionId!
    const d = await api.build(sessionId, id)
    const files = Object.fromEntries(Object.entries(d.files ?? {}).map(([k, v]) => [k, { ...(v as object), content: d.file_contents?.[k] } as never]))
    useBuild.getState().reset({
      id, sessionId, provider: d.provider, model: d.model, title: d.title, engineSession: d.engine_session ?? null, workdir: d.workdir ?? null, versions: d.versions ?? [], pendingCouncil: d.pending_council ?? null, status: d.status === 'running' || d.status === 'reviewing' ? 'connecting' : d.status, files, chat: d.chat, stages: d.stages, cost: d.cost_usd, buildSeconds: (d as { build_seconds?: number }).build_seconds ?? 0, usage: (d as { usage?: never }).usage ?? null, language: (d as { language?: string }).language ?? null, engineCost: (d as { engine_cost_usd?: number }).engine_cost_usd ?? 0, turns: (d as { turns?: number }).turns ?? 0, tokens: d.tokens, done: d.done,
      selected: Object.keys(files)[0] ?? null, team: d.team ?? [], reviews: d.reviews ?? [], reviewPlan: d.review_plan ?? null, mode: d.mode ?? 'build', auditReport: d.audit_report ?? null,
      runOpen: useBuild.getState().id === id && useBuild.getState().runOpen, previewHtml: d.preview_html ?? d.file_contents?.['preview/index.html'] ?? null, designHtml: d.design_html ?? d.file_contents?.['design/mockup.html'] ?? null, pane: d.audit_report ? 'report' : 'code', levels: d.levels ?? null,
    })
    if (show) st.set({ showBriefExport: false, view: 'builder' })
    buildWs.current?.()
    if (d.status === 'running' || d.status === 'reviewing' || d.status === 'design_review') openBuildWs(id)  // waiting for design approval is live too
  }

  /** Deep link to a build (#build=<session>~<build>): the session is loaded quietly (for «← Council») and the build opens. */
  const openBuildLink = async (sid: string, bid: string) => {
    const data = await api.session(sid).catch(() => null)
    cleanup.current?.()
    useArena.getState().reset({ view: useArena.getState().view, source: 'replay', status: 'connecting', sessionId: sid })
    if (data) for (const ev of data.events) useArena.getState().apply(ev)
    useArena.getState().set({ showVerdict: false })
    await openBuild(bid)
  }

  // while the builder is on screen the address names the build, so F5 comes back to it (and not to the council that sent it)
  useEffect(() => {
    const sync = () => {
      const a = useArena.getState(), b = useBuild.getState()
      if (a.view === 'builder' && b.id && b.sessionId) {
        const h = `#build=${b.sessionId}~${b.id}`
        if (location.hash !== h) history.replaceState(null, '', h)
      } else if (a.view === 'arena' && a.sessionId && location.hash.startsWith('#build=')) history.replaceState(null, '', `#live=${a.sessionId}`)
    }
    const u1 = useArena.subscribe(sync), u2 = useBuild.subscribe(sync)
    return () => { u1(); u2() }
  }, [])

  /** «Correr app» from the home: the run view opens right there, over the home, without entering the builder. */
  const [runOverlay, setRunOverlay] = useState(false)
  const runApp = async (sessionId: string) => {
    const builds = await api.builds(sessionId).catch(() => [])
    const latest = builds.find((x) => x.status !== 'error' && x.files) ?? builds[0]
    if (!latest) throw new Error(tr('Este proyecto todavía no tiene una construcción para correr.', 'This project has no build to run yet.'))
    useArena.getState().set({ sessionId })
    await openBuild(latest.id, false)
    setRunOverlay(true)
  }
  const runOverlayLayer = runOverlay ? (
    <RunModal
      onClose={() => setRunOverlay(false)}
      onDownload={async () => {
        const b = useBuild.getState()
        if (!b.sessionId || !b.id) return
        downloadBlob(await api.buildZip(b.sessionId, b.id), `${slug(b.title) || 'proyecto'}.zip`)
      }}
    />
  ) : null

  // user-facing feedback for long jobs (build/review/deploy/arena), including browser notifications when the tab is hidden
  useEffect(() => {
    requestNotifications()
    const unsubBuild = useBuild.subscribe((b, prev) => {
      if (prev.status === b.status) {
        if (b.deploys.length > prev.deploys.length) {
          const d = b.deploys[b.deploys.length - 1]
          if (d.ok) {
            toast.ok(tr('Deploy publicado', 'Deploy published'), d.url ?? undefined, d.url ? { label: tr('Abrir', 'Open'), onClick: () => window.open(d.url!, '_blank') } : undefined)
            notify(tr('Deploy publicado', 'Deploy published'), d.url ?? '')
          } else toast.error(tr('El deploy falló', 'Deploy failed'), d.error ?? undefined)
        }
        if (b.error && b.error !== prev.error) toast.error(tr('Error en la construcción', 'Build error'), b.error)
        return
      }
      const title = b.title || tr('Proyecto', 'Project')
      if (b.status === 'approved') {
        toast.ok(tr('Aprobado por el consejo', 'Approved by the council'), `${title}: ${tr('todos los roles dieron el visto bueno.', 'every role gave the go-ahead.')}`)
        notify(tr('Aprobado por el consejo', 'Approved by the council'), title)
      } else if (b.status === 'completed' && (prev.status === 'running' || prev.status === 'connecting')) {
        toast.ok(tr('Construcción terminada', 'Build finished'), `${title}: ${Object.keys(b.files).length} ${tr('archivos. Mirá la vista previa.', 'files. Check the preview.')}`)
        notify(tr('Construcción terminada', 'Build finished'), title)
      } else if (b.status === 'audited') {
        toast.ok(tr('Auditoría lista', 'Audit ready'), `${title}: ${tr('informe disponible en la pestaña Informe.', 'report available in the Report tab.')}`)
        notify(tr('Auditoría lista', 'Audit ready'), title)
      } else if (b.status === 'reviewing' && prev.status !== 'reviewing') toast.info(tr('El consejo está revisando', 'The council is reviewing'), title)
      else if (b.status === 'error') toast.error(tr('La construcción se interrumpió', 'The build was interrupted'), b.error ?? tr('Podés reanudarla desde el chat.', 'You can resume it from the chat.'))
    })
    const unsubArena = useArena.subscribe((a, prev) => {
      if (a.status !== prev.status && (a.status === 'completed' || a.status === 'stopped') && a.source === 'live') {
        toast.ok(a.status === 'completed' ? tr('Debate terminado', 'Debate finished') : tr('Debate detenido', 'Debate stopped'), a.config?.title || a.config?.topic)
        notify(tr('Debate terminado', 'Debate finished'), a.config?.title || a.config?.topic || '')
      }
      if (a.verdict && a.verdict !== prev.verdict && a.source === 'live') notify(tr('Veredicto listo', 'Verdict ready'), a.config?.title || '')
    })
    return () => {
      unsubBuild()
      unsubArena()
    }
  }, [])

  useEffect(() => {
    setReconnectBuild((id) => {
      openBuildWs(id)
    })
  }, [])

  /** Attach to a session that is running (or just finished) on the server, in the live arena UI. */
  const watchLive = (id: string) => {
    cleanup.current?.()
    buildWs.current?.()
    buildWs.current = null
    setIntro(null)
    useArena.getState().reset({ view: 'arena', source: 'live', status: 'connecting', sessionId: id })
    history.replaceState(null, '', `#live=${id}`)
    cleanup.current = connect(id, onEvent, () => {})
  }

  // the builder handed the project to the council → same arena UI as the design debate
  useEffect(() => {
    const unsub = useBuild.subscribe((b, prev) => {
      if (b.councilSession && b.councilSession !== prev.councilSession) {
        toast.info(tr('El consejo pasa a la arena', 'The council moves to the arena'), tr('El equipo debate el proyecto en vivo; al final te da la lista de cambios.', 'The team debates the project live; at the end it gives you the list of changes.'))
        watchLive(b.councilSession)
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "ver el debate del consejo" from the builder / dashboard → arena (live if still running, otherwise saved)
  useEffect(() => {
    const unsub = useArena.subscribe((a, prev) => {
      if (a.pendingLive && a.pendingLive !== prev.pendingLive) {
        const id = a.pendingLive
        useArena.getState().set({ pendingLive: null })
        api.sessions().then((list) => {
          if (list.find((x) => x.id === id)?.live) watchLive(id)
          else openSaved(id, false).catch((e) => toast.error(tr('No se pudo abrir', 'Could not open'), (e as Error).message))
        })
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the council's verdict was accepted → back to the builder, which is applying the changes
  useEffect(() => {
    const unsub = useArena.subscribe((a, prev) => {
      if (a.pendingBuild && a.pendingBuild !== prev.pendingBuild) {
        const { buildId, sessionId, fde } = a.pendingBuild
        cleanup.current?.()
        cleanup.current = null
        useArena.getState().set({ pendingBuild: null, sessionId })
        openBuild(buildId).then(() => { if (fde !== undefined) useBuild.getState().set({ fdePrefill: fde }) }).catch((e) => toast.error(tr('No se pudo abrir el constructor', 'Could not open the builder'), (e as Error).message))
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const leaveBuilder = () => {
    buildWs.current?.()
    buildWs.current = null
    setIntro(null)
    useArena.getState().set({ view: useArena.getState().config ? 'arena' : 'setup' })
  }

  /** Replays the current session from the top while recording the arena, then downloads the file. */
  const recordVideo = async (o: VideoOptions) => {
    const st = useArena.getState()
    const id = st.sessionId
    if (!id) return
    const prev = { layout: st.layout, recMode: st.recMode, speed: st.speed, sound: sfxEnabled }
    st.set({ showVideoExport: false, layout: o.layout, recMode: true, speed: o.speed })
    setSfx(o.sound)
    let stream: MediaStream
    try {
      stream = await requestTabStream(o.sound) // must run right after the click (user gesture)
    } catch {
      useArena.getState().set({ layout: prev.layout, recMode: prev.recMode, speed: prev.speed })
      return
    }
    const data = await api.session(id)
    cleanup.current?.()
    useArena.getState().reset({ view: 'arena', source: 'replay', status: 'connecting', sessionId: id, recording: true })
    await new Promise((r) => setTimeout(r, 700)) // let the layout settle before cropping
    const rec = await startRecording(stream, document.querySelector<HTMLElement>('[data-capture]'))
    await new Promise((r) => setTimeout(r, 600)) // a beat of the empty arena before it starts
    const finished = new Promise<void>((res) => {
      cleanup.current = replay(data.events, () => useArena.getState().speed, onEvent, res)
    })
    await Promise.race([finished.then(() => new Promise((r) => setTimeout(r, o.hold * 1000))), rec.ended])
    const blob = await rec.stop()
    const cfg = useArena.getState().config
    const ext = rec.mime.includes('mp4') ? 'mp4' : 'webm'
    downloadBlob(blob, `tablyteam-${slug(cfg?.title || cfg?.topic || id)}-${o.layout === 'vertical' ? '9x16' : '16x9'}.${ext}`)
    setSfx(prev.sound)
    useArena.getState().set({ recording: false, layout: prev.layout, recMode: prev.recMode, speed: prev.speed })
  }

  // session check: valid token → user, otherwise the login screen
  useEffect(() => {
    auth.onUnauthorized(() => {
      cleanup.current?.()
      useArena.getState().reset({ view: 'setup', user: null })
    })
    if (!auth.token) return useArena.getState().set({ authChecked: true })
    api
      .me()
      .then(({ user }) => useArena.getState().set({ user, authChecked: true }))
      .catch(() => useArena.getState().set({ user: null, authChecked: true }))
  }, [])

  const logout = async () => {
    await api.logout().catch(() => {})
    auth.set(null)
    leave()
    setGate('login')
    useArena.getState().set({ user: null })
  }

  // back from Stripe Checkout: ?checkout=<session>&order=<id> → confirm, tell the user, clean the URL (the hash stays)
  useEffect(() => {
    if (!user) return
    const q = new URLSearchParams(location.search)
    const checkout = q.get('checkout')
    if (!checkout) return
    history.replaceState(null, '', `${location.pathname}${location.hash}`)
    if (checkout === 'cancel') { toast.info(tr('Pago cancelado', 'Payment cancelled'), tr('No se cobró nada. Podés retomarlo cuando quieras.', 'Nothing was charged. You can resume whenever you want.')); return }
    api.confirmCheckout(checkout)
      .then((o) => { if (o.status === 'paid') toast.ok(tr('Pago recibido', 'Payment received'), `${o.name} · USD ${o.amount_usd}`); else toast.info(tr('Pago pendiente', 'Payment pending'), tr('Stripe todavía no lo confirmó; lo vemos en unos minutos.', 'Stripe has not confirmed it yet; we will check again in a few minutes.')) })
      .catch((e) => toast.error(tr('No pude confirmar el pago', 'Could not confirm the payment'), (e as Error).message))
  }, [user?.id])

  // deep links: #replay=<id> / #live=<id>  (handy for re-recording a take)
  useEffect(() => {
    if (!user) return
    const cm = location.hash.match(/^#(connected|connect_error)=(.*)$/)
    if (cm) {  // back from Google's consent screen: say how it went and return to where the user started (usually a build)
      let back = ''
      try { back = sessionStorage.getItem('tably.returnHash') ?? ''; sessionStorage.removeItem('tably.returnHash') } catch { /* private mode */ }
      history.replaceState(null, '', location.pathname + (back.startsWith('#build=') ? back : ''))
      if (cm[1] === 'connected') toast.ok(tr('Cuenta conectada', 'Account connected'), tr('Tus apps ya pueden leerla a través de Tably.', 'Your apps can now read it through Tably.'))
      else toast.error(tr('No se pudo conectar la cuenta', 'Could not connect the account'), decodeURIComponent(cm[2] || ''))
    }
    if (TICKETS_ENABLED && location.hash.startsWith('#tickets')) {  // back from Notion's OAuth consent: straight to the tickets screen
      const failed = location.hash === '#tickets=error'
      history.replaceState(null, '', location.pathname)
      useArena.getState().set({ view: 'tickets' })
      if (failed) toast.error('Notion no terminó de conectarse', 'Probá de nuevo o pegá el token de una integración interna.')
      return
    }
    const bm = location.hash.match(/^#build=([^~]+)~(.+)$/)
    if (bm) {  // a reload inside the builder: back to that same build, never to the council's verdict
      openBuildLink(bm[1], bm[2]).catch(() => openSaved(bm[1]).catch(leave))
      return () => cleanup.current?.()
    }
    const m = location.hash.match(/^#(replay|live)=(.+)$/)
    if (!m) return
    if (m[1] === 'replay') startReplay(m[2]).catch(leave)
    else {
      // live link: attach if the run is still in memory, otherwise load the saved session instantly
      api.sessions().then((list) => {
        const found = list.find((x) => x.id === m[2])
        if (found?.live) {
          useArena.getState().reset({ view: 'arena', source: 'live', status: 'connecting', sessionId: m[2] })
          cleanup.current = connect(m[2], onEvent, () => {})
        } else openSaved(m[2]).catch(leave)
      }).catch(leave)
    }
    return () => cleanup.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // #demo=research: the research screen with a scripted run, to look at the UI without launching a real benchmark
  const [demo, setDemo] = useState<string | null>(() => location.hash.match(/^#demo=(\w+)$/)?.[1] ?? null)
  useEffect(() => {
    const onHash = () => setDemo(location.hash.match(/^#demo=(\w+)$/)?.[1] ?? null)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const researching = useBuild((s) => s.researching)
  const demoLayer = demo === 'research' || demo === 'models'
    ? <ResearchOverlay demo hiddenDemo={demo === 'models'} onClose={() => { history.replaceState(null, '', location.pathname); setDemo(null) }} />
    : <AnimatePresence>{researching && <ResearchOverlay key="research" />}</AnimatePresence>

  const banner = <OfflineBanner />
  if (!authChecked) return <div className="h-full arena-bg">{banner}</div>
  if (!user) {
    if (gate === 'landing') return <>{banner}<Landing onLogin={() => setGate('login')} onSignup={() => setGate('signup')} /></>
    return <>{banner}<Login key={gate} initialMode={gate === 'signup' ? 'register' : 'login'} onAuthed={(u) => useArena.getState().set({ user: u })} onBack={() => setGate('landing')} /></>
  }
  if (view === 'builder') {
    return (
      <div data-capture="builder" className="h-full">
        {banner}
        {demoLayer}
        {intro ? <BuilderIntro provider={intro.provider} model={intro.model} title={intro.title} onDone={() => setIntro(null)} /> : <Builder onBack={leaveBuilder} onHome={() => { buildWs.current?.(); buildWs.current = null; setIntro(null); leave() }} />}
      </div>
    )
  }
  if (view === 'audit') return <>{banner}{demoLayer}<AuditSetup onBack={() => useArena.getState().set({ view: 'setup' })} onStart={startAudit} /></>
  if (view === 'settings') return <>{banner}{demoLayer}<Settings onBack={() => useArena.getState().set({ view: 'setup' })} /></>
  if (view === 'agents') return <>{banner}{demoLayer}<AgentSessions onBack={() => useArena.getState().set({ view: 'setup' })} /></>
  if (view === 'tickets' && TICKETS_ENABLED) return <>{banner}{demoLayer}<Tickets onBack={() => useArena.getState().set({ view: 'setup' })} /></>
  if (view === 'analytics') return <>{banner}{demoLayer}<AnalyticsPage onBack={() => useArena.getState().set({ view: 'setup' })} /></>
  if (view === 'team') return <>{banner}{demoLayer}<TeamPage onBack={() => useArena.getState().set({ view: 'setup' })} /></>
  if (view === 'adtier') return <>{banner}{demoLayer}<Suspense fallback={null}><AdTier onBack={() => useArena.getState().set({ view: 'setup' })} /></Suspense></>
  if (view === 'studio') return <>{banner}{demoLayer}<Suspense fallback={null}><AdStudio onBack={() => useArena.getState().set({ view: 'setup' })} /></Suspense></>
  if (view === 'market') return <>{banner}{demoLayer}<Marketplace onBack={() => useArena.getState().set({ view: 'setup' })} /></>
  if (view === 'setup') return <>{banner}{demoLayer}<Setup key={user.id} user={user} onLogout={logout} onSettings={() => useArena.getState().set({ view: 'settings' })} onAudit={() => useArena.getState().set({ view: 'audit' })} onStart={start} onDirect={direct} onReplay={startReplay} onOpen={(id, mode) => (mode === 'run' ? runApp(id) : openSaved(id, mode !== 'arena', mode === 'builder')).catch((e) => toast.error(tr('No se pudo abrir', 'Could not open'), (e as Error).message))} />{runOverlayLayer}</>

  const exporter = (
    <>
      {banner}
      {demoLayer}
      {showTeam && <TeamModal onClose={() => useArena.getState().set({ showTeam: false })} />}
      <AgentDrawer />
      {showVideoExport && <VideoExport onClose={() => useArena.getState().set({ showVideoExport: false })} onRecord={recordVideo} />}
      {showBriefExport && <BriefExport onClose={() => useArena.getState().set({ showBriefExport: false })} onBuild={startBuild} onOpenBuild={openBuild} />}
    </>
  )

  if (layout === 'vertical') {
    return (
      <div className="h-full w-full bg-[#E4E8E5] flex items-center justify-center">
        {exporter}
        <div data-capture className="relative h-full aspect-[9/16] max-w-full arena-bg flex flex-col overflow-hidden border-x border-line">
          <TopBar onRerun={rerun} onNew={leave} />
          <div className="relative flex-[1.7] min-h-0">
            <ArenaGraph />
          </div>
          <div className="px-3 -mt-2 mb-2"><Captions big={recMode} /></div>
          <div className="px-3 pb-2"><Timeline /></div>
          <div className="flex-1 min-h-0 max-h-[34%] border-t border-line"><LiveFeed compact /></div>
          {verdictEl}
          <PauseModal />
        </div>
      </div>
    )
  }

  return (
    <div data-capture className="relative h-full flex flex-col arena-bg overflow-hidden">
      {exporter}
      <TopBar onRerun={rerun} onNew={leave} />
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="relative flex-1 min-w-0 min-h-[64%] md:min-h-0 flex flex-col">
          <div className="relative flex-1 min-h-0">
            <ArenaGraph />
            <div className="absolute left-3 right-3 top-3 md:left-4 md:right-auto md:w-[520px] md:max-w-[60%]"><StatTiles /></div>
            <div className="absolute bottom-3 inset-x-0 hidden px-3 md:block md:px-6"><Captions big={recMode} /></div>
          </div>
          {/* on a phone the caption goes under the graph: over it, it covered the roles at the bottom of the tree */}
          <div className="shrink-0 px-3 pb-1 md:hidden"><Captions big={recMode} /></div>
          <div className="shrink-0 px-4 pb-3 space-y-2">
            <Timeline />
            {/* the three analytics cards stay under the graph in focus mode too (a bit shorter, so the stage keeps the room); only a recording hides them */}
            {!recMode && (
              <div className="hidden md:grid grid-cols-3 gap-2" style={{ height: focus ? Math.max(192, 80 + agentCount * 22) : Math.max(210, 84 + agentCount * 27) }}>
                <LatencyChart />
                <TokensChart />
                <CostChart />
              </div>
            )}
          </div>
        </div>
        {/* focus mode (councils by default): the debate is the show, the transcript is a narrow side column */}
        <div className={`${focus ? 'md:w-[300px]' : recMode ? 'md:w-[380px]' : 'md:w-[420px]'} h-[36%] w-full shrink-0 border-t border-line bg-surface flex flex-col md:h-auto md:border-l md:border-t-0`}>
          <div className="px-4 py-2.5 text-[11px] uppercase tracking-widest text-ink-3 border-b border-line">{T('Transcripción en vivo', 'Live transcript')}</div>
          <div className="flex-1 min-h-0"><LiveFeed compact={focus} all /></div>
        </div>
      </div>
      {verdictEl}
      <PauseModal />
    </div>
  )
}


export default function App() {
  return (
    <ErrorBoundary onReset={() => { history.replaceState(null, '', location.pathname); location.reload() }}>
      <AppInner />
      <LookSwitch />
      <TeamMemoryWatcher />
      <Toaster />
    </ErrorBoundary>
  )
}


/** Development only: compare the identity with the previous look. */
function LookSwitch() {
  const [on, setOn] = useState(newLookOn())
  if (!LOOK_SWITCH) return null
  const flip = () => {
    setNewLook(!on)
    setOn(!on)
    setBuilderLook(useArena.getState().view === 'builder')
  }
  return (
    <button onClick={flip} title="Solo en desarrollo" className="fixed bottom-3 left-3 z-[400] rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2 shadow-md transition hover:text-ink">
      Identidad: <b className="text-ink">{on ? 'nueva' : 'actual'}</b>
    </button>
  )
}

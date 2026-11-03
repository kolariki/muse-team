import { useAiConnect } from './AiConnect'
import InlineKey from './InlineKey'
import TeamTable from './TeamTable'
import { loadMyPhoto } from '../lib/myPhoto'
import { newLookOn } from '../lib/look'
import { useArena } from '../store'
import { EmployeePicker, employeeToAgent } from './MyTeam'
import { useBuild, type Activity } from '../buildStore'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeftRight, Bookmark, Check, Eye, FolderOpen, Globe, KeyRound, Loader2, MonitorSmartphone, Play, Plus, Puzzle, Settings2, Smartphone, Trash2, Users, X, Zap } from 'lucide-react'
import { toast, useConfirm, usePrompt } from './Toast'
import SkillPicker from './SkillPicker'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Employee, type EngineStatus, type User } from '../lib/api'
import { fmtUsd } from '../lib/parse'
import Dashboard from './Dashboard'
import HomeOverview from './HomeOverview'
import HomeLoader from './HomeLoader'
import LaneCards from './LaneCards'
import AgentAvatar from './AgentAvatar'
import { isMuseReco, museReco, museTeam, museTeamFor } from '../lib/muse'
import { HACKATHON_MODE, MUSE_FIRST, visibleEngines, visibleProviders } from '../lib/flags'
import { readCache, writeCache } from '../lib/cache'
import ModelSelect, { invalidateModels } from './ModelSelect'
import ArenaIntro, { ICON_STEP, PLAY_OUT, iconExitAt, introTeam } from './ArenaIntro'
import Intake from './Intake'
import PersonaField from './PersonaField'
import FieldTitle from './FieldTitle'
import { offerTour } from './ProductTour'
import { openTeam } from './TeamMemory'
import ProviderLogo, { BrandLogoRow, BrandStripes, LogoWatermark } from './ProviderLogo'
import { BRAND_COLOR, MODE_INFO, PALETTE, brandTheme } from '../lib/brand'
import type { AgentConfig, Mode, Preset, Provider, Role, SessionConfig, SessionSummary } from '../types'
import { getLang, pick, tr, useLang, useT } from '../lib/i18n'

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'agente'

interface Props {
  user: User
  onLogout: () => void
  onSettings: () => void
  onAudit: () => void
  onStart: (cfg: SessionConfig) => Promise<void>
  onDirect: (cfg: SessionConfig) => Promise<void>  // fast lane: brief from the prompt → builder, no council
  onReplay: (id: string) => void
  onOpen: (id: string, mode?: OpenMode) => void | Promise<unknown>
}

export type OpenMode = 'arena' | 'builder' | 'run'

export default function Setup({ user, onSettings, onAudit, onStart, onDirect, onReplay, onOpen }: Props) {
  const T = useT()
  const { prompt: askName, dialog: nameDialog } = usePrompt()
  const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm()
  const [refDraft, setRefDraft] = useState('')
  // the preset's own reference apps: never shown; used only when the user adds none (the user's always win)
  const [presetRefs, setPresetRefs] = useState<string[]>([])
  const effectiveRefs = (c: SessionConfig) => { const mine = (c.references ?? []).map((r) => r.trim()).filter(Boolean); return mine.length ? mine : presetRefs }
  const [rstatus, setRstatus] = useState<{ rea: { ok: boolean; fee_usd: number }; deep_fee_usd: number } | null>(null)
  useEffect(() => { api.researchStatus().then(setRstatus).catch(() => {}) }, [])
  // the direct lane's builder: a local engine (subscription) or an API provider + model; remembered, defaults to the first engine that is ready
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [builder, setBuilderState] = useState<{ provider: string; model: string }>(() => readCache<{ provider: string; model: string }>('direct-builder') ?? { provider: '', model: '' })
  const setBuilder = (b: { provider: string; model: string }) => { setBuilderState(b); writeCache('direct-builder', b) }
  useEffect(() => {
    api.engines().then((all) => {
      const es = visibleEngines(all)
      setEngines(es)
      setBuilderState((b) => {
        if (b.provider && (es.some((e) => e.id === b.provider && e.ok) || !es.some((e) => e.id === b.provider))) return b
        const ok = es.find((e) => e.ok)
        return ok ? { provider: ok.id, model: 'default' } : { provider: '', model: '' }
      })
    }).catch(() => {})
  }, [])
  const commitRefs = () => {
    const parts = refDraft.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
    if (parts.length) setCfg((c) => ({ ...c, references: [...new Set([...(c.references ?? []), ...parts])].slice(0, 6) }))
    setRefDraft('')
  }
  // a saved experiment opens a chooser: see the project (its build), edit the team, or see the council's last run
  const [chooser, setChooser] = useState<{ preset: Preset; run: SessionSummary | null | undefined } | null>(null)
  const teamRef = useRef<HTMLDivElement>(null)
  // while a project or council opens (the view switches when its data is in): the loader, so the click is never "nothing"
  const [opening, setOpening] = useState<string | null>(null)
  useEffect(() => {
    if (!opening) return
    const t = setTimeout(() => setOpening(null), 15000)
    return () => clearTimeout(t)
  }, [opening])
  const lastRunOf = (list: SessionSummary[], p: Preset) =>
    // the newest run of this experiment: same title (what the card saves) or same topic; council review rounds are not runs
    list.filter((x) => x.mode !== 'review' && x.mode !== 'audit' && ((x.title && x.title === p.title) || x.topic === p.topic)).sort((a, b) => b.created - a.created)[0] ?? null
  const openChooser = (p: Preset) => {
    const cached = readCache<SessionSummary[]>('sessions')
    setChooser({ preset: p, run: cached ? lastRunOf(cached, p) : undefined })  // remembered list: the options are ready at once
    api.sessions().then((list) => {
      writeCache('sessions', list)
      setChooser((c) => (c && c.preset.id === p.id ? { ...c, run: lastRunOf(list, p) } : c))
    }).catch(() => setChooser((c) => (c && c.preset.id === p.id && c.run === undefined ? { ...c, run: null } : c)))
  }
  useEffect(() => {
    if (!chooser) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setChooser(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chooser])
  const lang = useLang()
  useEffect(() => { loadMyPhoto() }, [])
  const [providers, setProviders] = useState<Provider[]>(() => visibleProviders(readCache<Provider[]>('providers') ?? []))
  const trialProvider = providers.find((x) => x.id === 'baseten' && x.source === 'trial')
  const ai = useAiConnect(providers, (np) => { setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x))); invalidateModels(np.id) })
  const apiProviders = providers.filter((p) => p.id !== 'mock' || !providers.some((x) => x.configured && x.id !== 'mock'))
  const isApiBuilder = !!builder.provider && !engines.some((e) => e.id === builder.provider)
  const [roles, setRoles] = useState<{ groups: string[]; groups_en?: string[]; roles: Role[] }>({ groups: [], roles: [] })
  const [presets, setPresets] = useState<Preset[]>(() => readCache<Preset[]>('presets') ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [launching, setLaunching] = useState(false) // intro animation (button → arena)
  const [starting, setStarting] = useState(false) // intro done, waiting for the backend to open the session
  const [connecting, setConnecting] = useState<string | null>(null) // provider chip opened to paste an API key
  const [suggesting, setSuggesting] = useState(false)
  const [idea, setIdea] = useState('') // the user's own words (the topic until a prompt is generated)
  const [promptMd, setPromptMd] = useState<string | null>(null) // generated brief the council will debate
  const [cfg, setCfg] = useState<SessionConfig>({
    topic: '',
    mode: 'handoff',
    agents: [],
    max_turns: 10,
    min_turns: 4,
    language: 'español rioplatense',
    final_vote: true,
    closing_round: true,
    max_tokens: 1800,
    pace_ms: 700,
  })

  // the loader stays until providers, experiments and projects are in (or 8 s, whichever comes first)
  // what was remembered from the last visit counts as loaded: the page paints at once and refreshes quietly behind
  const [loaded, setLoaded] = useState(() => ({ providers: !!readCache('providers'), presets: !!readCache('presets'), dashboard: !!readCache('dashboard'), timeout: false }))
  const mark = (k: keyof typeof loaded) => setLoaded((l) => (l[k] ? l : { ...l, [k]: true }))
  const booting = !loaded.timeout && !(loaded.providers && loaded.presets && loaded.dashboard)
  useEffect(() => {
    const cachedPresets = readCache<Preset[]>('presets')
    if (cachedPresets?.[0]) applyPreset(cachedPresets[0])
    api.providers().then((p) => { if (writeCache('providers', p)) setProviders(visibleProviders(p)) }).catch((e) => setError(`${tr('No hay backend', 'No backend')}: ${e.message}`)).finally(() => mark('providers'))
    api.presets().then((p) => {
      const changed = writeCache('presets', p)
      if (changed) setPresets(p)
      if (!cachedPresets?.[0] && p[0]) applyPreset(p[0])
    }).catch(() => {}).finally(() => mark('presets'))
    api.roles().then(setRoles).catch(() => {})
    const t = setTimeout(() => mark('timeout'), 8000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the preset's default texts (title, topic, agent names/personas, debate language) follow the UI language until the
  // user edits them; what finally runs is saved in whatever language it was written
  const baseline = useRef<{ preset: Preset; title: string; topic: string; language: string; agents: Record<string, { name: string; persona: string }> } | null>(null)
  const defaultLanguage = () => (getLang() === 'en' ? 'English' : 'español rioplatense')
  function applyPreset(p: Preset) {
    const title = pick(p, 'title')
    const topic = pick(p, 'topic')
    const language = defaultLanguage()
    const base = p.agents.map((a, i) => ({ ...a, name: pick(a, 'name') || a.name, persona: pick(a, 'persona') || a.persona, color: a.provider === 'mock' || a.provider === 'baseten' ? BRAND_COLOR[a.wanted_provider ?? ''] ?? PALETTE[i % PALETTE.length] : null }))
    // Muse first: every seat of the preset lands on the Muse model recommended for its role (simulated until the Meta key is loaded)
    const agents = MUSE_FIRST ? museTeamFor(base, !!providers.find((x) => x.id === 'meta')?.configured, trialProvider?.default_model) : base
    baseline.current = { preset: p, title, topic, language, agents: Object.fromEntries(agents.map((a) => [a.id, { name: a.name, persona: a.persona }])) }
    setIdea(topic)
    setPromptMd(null)
    setCfg((c) => ({ ...c, topic, title, language, mode: p.mode, max_turns: p.max_turns, agents, platform: p.platform ?? 'web', references: [] }))
    setPresetRefs(p.references ?? [])
  }
  // Muse first: as soon as the Meta key is connected, the seats that were waiting for it (simulated) move to Muse with their recommended model
  // the free trial showed up after the team was laid out: the simulated seats move to it
  useEffect(() => {
    if (!MUSE_FIRST || !trialProvider || providers.find((x) => x.id === 'meta')?.configured) return
    setCfg((c) => (c.agents.some((a) => a.provider === 'mock' && a.wanted_provider === 'meta') ? { ...c, agents: c.agents.map((a) => (a.provider === 'mock' && a.wanted_provider === 'meta' ? { ...a, provider: 'baseten', model: trialProvider.default_model } : a)) } : c))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])
  useEffect(() => {
    if (!MUSE_FIRST || !providers.find((x) => x.id === 'meta')?.configured) return
    const waiting = (a: AgentConfig) => (a.provider === 'mock' || a.provider === 'baseten') && a.wanted_provider === 'meta'
    setCfg((c) => (c.agents.some(waiting) ? { ...c, agents: c.agents.map((a) => (waiting(a) ? { ...a, provider: 'meta', wanted_provider: undefined, model: museReco(a).model, color: null } : a)) } : c))
  }, [providers])
  useEffect(() => {
    // language switched: swap every default that is still untouched to the other language
    const b = baseline.current
    if (!b) return
    const p = b.preset
    const title = pick(p, 'title')
    const topic = pick(p, 'topic')
    const language = defaultLanguage()
    setCfg((c) => {
      const next = { ...c }
      if (c.title === b.title) next.title = title
      if (c.topic === b.topic) { next.topic = topic; setIdea((i) => (i === b.topic ? topic : i)) }
      if (c.language === b.language) next.language = language
      next.agents = c.agents.map((a) => {
        const src = p.agents.find((x) => x.id === a.id)
        const was = b.agents[a.id]
        if (!src || !was) return a
        return { ...a, name: a.name === was.name ? pick(src, 'name') || a.name : a.name, persona: a.persona === was.persona ? pick(src, 'persona') || a.persona : a.persona }
      })
      return next
    })
    baseline.current = { ...b, title, topic, language, agents: Object.fromEntries(p.agents.map((a) => [a.id, { name: pick(a, 'name') || a.name, persona: pick(a, 'persona') || a.persona }])) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  const updateAgent = (i: number, patch: Partial<AgentConfig>) =>
    setCfg((c) => ({ ...c, agents: c.agents.map((a, j) => (j === i ? { ...a, ...patch } : a)) }))

  const setRole = (i: number, roleId: string) => {
    const a = cfg.agents[i]
    const prev = roles.roles.find((r) => r.id === a.role)
    const next = roles.roles.find((r) => r.id === roleId)
    const patch: Partial<AgentConfig> = { role: roleId === 'custom' ? null : roleId }
    // only overwrite what the user hasn't customised
    if (next && next.id !== 'custom' && (!a.persona.trim() || a.persona === prev?.persona)) patch.persona = next.persona
    if (next && next.id !== 'custom' && (!a.name.trim() || a.name === prev?.label || /^Agente \d+$/.test(a.name))) {
      patch.name = next.label
      patch.id = slug(next.label)
    }
    updateAgent(i, patch)
  }

  const addAgent = () => {
    const p = providers.find((x) => x.configured && x.id !== 'mock') ?? providers.find((x) => x.id === 'mock')!
    const n = cfg.agents.length + 1
    setCfg((c) => ({ ...c, agents: [...c.agents, { id: `agente-${n}`, name: `Agente ${n}`, provider: p.id, model: p.default_model, persona: '', color: p.id === 'mock' ? PALETTE[(n - 1) % PALETTE.length] : null }] }))
  }

  const validate = () => {
    setError(null)
    const ids = cfg.agents.map((a) => a.id)
    if (new Set(ids).size !== ids.length) { setError(tr('Los ids de agentes deben ser únicos', 'Agent ids must be unique')); return false }
    if (!cfg.topic.trim()) { setError(tr('Falta el tema', 'The topic is missing')); return false }
    return true
  }

  // context the debate opens with: the user's own notes plus the benchmark of the references (researched first)
  const launchContext = useRef<string | null>(null)

  /** Benchmark the references first, with the reverse-engineering screen; then the team intro; then the council. */
  const [directBusy, setDirectBusy] = useState(false)
  // how the user wants to build: alone with the builder (direct) or with the whole team (council first)
  const [lane, setLaneState] = useState<'direct' | 'team' | null>(() => { if (HACKATHON_MODE) return 'team'; try { const v = localStorage.getItem('tably.lane'); return v === 'direct' || v === 'team' ? v : null } catch { return null } })  // hackathon edition: only the development-team lane
  const [showAllProviders, setShowAllProviders] = useState(false)  // Muse first: the other providers' chips stay behind a link
  const [editAgent, setEditAgent] = useState<number | null>(null)  // direct lane: the role being edited in its dialog
  const [laneAsk, setLaneAsk] = useState(false)  // «crear el primer proyecto»: direct or team, then the form scrolls into view
  const pickLaneAndGo = (l: 'direct' | 'team') => {
    setLaneAsk(false)
    setLane(l)
    setTimeout(() => document.querySelector('[data-lane]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }
  const setLane = (l: 'direct' | 'team' | null) => { if (HACKATHON_MODE) l = 'team'; setLaneState(l); if (l) offerTour(l); try { if (l) localStorage.setItem('tably.lane', l); else localStorage.removeItem('tably.lane') } catch { /* private mode */ } }
  const research = async (direct = false) => {
    if (!validate()) return
    let context = cfg.context ?? null
    const refs = effectiveRefs(cfg)
    if (refs.length) {
      setBusy(true)
      try {
        const job = await api.researchJobStart(refs, `${cfg.title ?? ''}\n\n${cfg.topic}`, !!cfg.deep_analysis)
        useBuild.getState().set({ researching: { refs, hidden: !(cfg.references ?? []).some((r) => r.trim()), started: Date.now(), visited: [], finished: false }, activity: [] })
        const md = await new Promise<string>((resolve) => {
          const tick = async () => {
            try {
              const j = await api.researchJob(job.id)
              const st = useBuild.getState()
              st.set({ researching: st.researching ? { ...st.researching, visited: j.visited, finished: j.status !== 'running' } : st.researching, activity: j.activity.map((a) => ({ kind: a.kind as Activity['kind'], label: a.label, path: a.path, ts: a.ts })) })
              if (j.status === 'done') return resolve(j.md)
              if (j.status === 'error') { toast.error(tr('La investigación falló', 'The research failed'), j.error ?? ''); return resolve('') }
            } catch { /* next tick */ }
            window.setTimeout(tick, 2000)
          }
          tick()
        })
        if (md) context = (context ? `${context}\n\n` : '') + md
      } catch (e) {
        useBuild.getState().set({ researching: null })
        setError((e as Error).message)
        setBusy(false)
        return
      }
      useBuild.getState().set({ researching: null, activity: [] })
      setBusy(false)
    }
    launchContext.current = context
    if (direct) {
      // no council: the brief is written from the prompt and the builder starts; the home shows the opening loader meanwhile
      setDirectBusy(true)
      setOpening(T('Escribiendo el brief y arrancando el constructor…', 'Writing the brief and starting the builder…'))
      try {
        await onDirect({ ...cfg, references: effectiveRefs(cfg), references_auto: !(cfg.references ?? []).some((r) => r.trim()), context, builder: builder.provider ? builder : undefined })
      } catch (e) {
        setError((e as Error).message)
        setOpening(null)
      } finally {
        setDirectBusy(false)
      }
      return
    }
    setLaunching(true)
  }

  const start = async () => {
    setBusy(true)
    try {
      await onStart({ ...cfg, references: effectiveRefs(cfg), references_auto: !(cfg.references ?? []).some((r) => r.trim()), context: launchContext.current ?? cfg.context ?? null, min_turns: Math.min(cfg.min_turns, cfg.max_turns) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const presetCard = (p: Preset) => (
            <button key={p.id} onClick={() => (p.custom ? openChooser(p) : applyPreset(p))} className={`group relative text-left rounded-2xl border overflow-hidden transition hover:shadow-md ${cfg.title === p.title ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`} style={{ minHeight: 150 }}>
              {/* looping animated scene as the card's "video" background (SVG with SMIL in public/scenes; drop a <id>.mp4 next to it to use a real clip) */}
              <img src={p.scene_url ?? `/scenes/${p.id}.svg`} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover transition duration-500 group-hover:scale-[1.04]" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
              <div className="absolute inset-0 bg-gradient-to-t from-paper via-paper/80 to-transparent" />
              {p.custom && (
                <span
                  role="button"
                  title={T('Borrar este experimento', 'Delete this experiment')}
                  onClick={async (e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    if (!(await confirmDelete(tr(`¿Borrar el experimento «${p.title}»? Se borra la tarjeta y su video; los proyectos ya corridos no se tocan.`, `Delete the experiment “${p.title}”? The card and its video are removed; projects already run are untouched.`)))) return
                    try {
                      await api.deletePreset(p.id)
                      setPresets((ps) => ps.filter((x) => x.id !== p.id))
                      toast.ok(tr('Experimento borrado', 'Experiment deleted'))
                    } catch (er) {
                      toast.error(tr('No se pudo borrar', 'Could not delete'), (er as Error).message)
                    }
                  }}
                  className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-paper/90 text-ink-3 hover:text-danger flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                ><X size={12} /></span>
              )}
              <div className="relative p-4 pt-16">
                <div className="font-semibold text-sm leading-tight">{pick(p, 'title')}</div>
                <div className="mt-1 text-[11px] text-ink-3">{p.agents.length} {T('agentes', 'agents')} · {pick(MODE_INFO[p.mode], 'label')}</div>
              </div>
            </button>
  )
  const input = 'w-full rounded-lg bg-surface border border-line px-3 py-2 text-sm outline-none focus:border-accent transition'

  /** The saved employees become the team: each seat keeps its model when that provider is connected, otherwise the usual stand-in. */
  const applyEmployees = (picked: Employee[]) => {
    const metaOn = !!providers.find((x) => x.id === 'meta')?.configured
    const ids = new Set<string>()
    const agents = picked.map((e, i) => {
      let a = employeeToAgent(e, 0)
      if (ids.has(a.id)) a = employeeToAgent(e, i)
      ids.add(a.id)
      const p = providers.find((x) => x.id === a.provider)
      if (p?.configured && p.id !== 'mock') return { ...a, model: a.model || (p.id === 'meta' ? museReco(a).model : p.default_model), color: null }
      return MUSE_FIRST ? museTeamFor([a], metaOn, trialProvider?.default_model)[0] : { ...a, wanted_provider: a.provider, provider: 'mock', model: 'mock-1' }
    })
    baseline.current = null  // the user's own roles: the language switch leaves their names and prompts alone
    setCfg((c) => ({ ...c, agents }))
    toast.ok(tr(`Tu equipo: ${agents.length} roles`, `Your team: ${agents.length} roles`), tr('Con su prompt, su conocimiento y lo que aprendieron.', 'With their prompt, knowledge and what they learned.'))
  }

  /** The catalog picks skills for one role from the task (same call as «Sugerir skills», applied to a single seat). */
  const suggestSkillsFor = async (i: number) => {
    const a = cfg.agents[i]
    if (!a || !cfg.topic.trim()) { toast.error(tr('Contá primero qué querés construir', 'Describe what you want to build first')); return }
    setSuggesting(true)
    try {
      const role = roles.roles.find((x) => x.id === a.role)
      const r = await api.suggestSkills(cfg.topic, [{ id: a.id, label: role?.label ?? a.name, group: role?.group, mandate: role?.mandate }], 3)
      const sug = (r.per_role[a.id] ?? []).filter((x) => (x.score ?? 0) >= 15 && !(a.skills ?? []).includes(x.id)).map((x) => x.id)
      if (sug.length) updateAgent(i, { skills: [...(a.skills ?? []), ...sug] })
      toast.ok(sug.length ? `${sug.length} ${sug.length === 1 ? tr('skill sugerida para', 'skill suggested for') : tr('skills sugeridas para', 'skills suggested for')} ${pick(a, 'name')}` : tr('Sin sugerencias claras para este rol', 'No clear suggestions for this role'))
    } catch (e) {
      toast.error(tr('No se pudieron sugerir skills', 'Could not suggest skills'), (e as Error).message)
    } finally {
      setSuggesting(false)
    }
  }

  /** One role's card: company, model, name, role, persona and skills. Used by the team list and by the role dialog of the direct lane. */
  const renderAgentCard = (a: AgentConfig, i: number) => {
    const p = providers.find((x) => x.id === a.provider)
    const color = a.color || p?.color || '#8A9299'
    return (
      <div key={i} className="relative isolate overflow-hidden rounded-xl border p-3" style={{ background: brandTheme(a.wanted_provider ?? a.provider).bg, borderColor: brandTheme(a.wanted_provider ?? a.provider).border }}>
        <LogoWatermark provider={a.wanted_provider ?? a.provider} opacity={0.1} />
        <div className="relative">
        <div className="flex flex-wrap items-center gap-2 pt-3 sm:grid sm:grid-cols-[auto_auto_1fr_1fr_1.6fr_auto]">
          <ProviderLogo provider={a.wanted_provider ?? a.provider} size={26} />
          <input type="color" value={color} onChange={(e) => updateAgent(i, { color: e.target.value })} className="w-7 h-7 rounded bg-transparent cursor-pointer" title="color" />
          <input className={`${input} min-w-[110px] flex-1`} value={a.name} onChange={(e) => updateAgent(i, { name: e.target.value, id: slug(e.target.value) })} placeholder={T('nombre', 'name')} />
          <select
            className={`${input} min-w-[110px] flex-1`}
            value={a.provider}
            onChange={(e) => {
              const np = providers.find((x) => x.id === e.target.value)!
              updateAgent(i, { provider: np.id, model: np.default_model, wanted_provider: undefined, color: np.id === 'mock' ? a.color : null })
            }}
          >
            {providers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}{x.configured || x.id === 'mock' ? '' : T(' · conectar', ' · connect')}
              </option>
            ))}
          </select>
          {p && !p.configured && p.id !== 'mock' ? (
            <InlineKey
              provider={p}
              onConnected={(np) => {
                setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x)))
                invalidateModels(np.id)
                setCfg((c) => ({ ...c, agents: c.agents.map((ag) => (ag.provider === np.id ? { ...ag, model: ag.model || np.default_model } : ag)) }))
              }}
              trash={<button onClick={() => setCfg({ ...cfg, agents: cfg.agents.filter((_, j) => j !== i) })} disabled={cfg.agents.length <= 2} className="text-ink-3 hover:text-danger disabled:opacity-20"><Trash2 size={16} /></button>}
            />
          ) : (
            <>
              <div className="relative mt-3 min-w-0 flex-1 basis-[calc(100%-2.5rem)] sm:mt-0 sm:basis-auto">
                {/* the Muse hint floats above the select, so the row's controls stay aligned */}
                {!MUSE_FIRST ? null : isMuseReco(a) ? (
                  <div className="absolute -top-[15px] left-1 max-w-full truncate text-[10px] font-semibold leading-none text-[#0064E0]" title={T(museReco(a).why, museReco(a).why_en)}>✓ {T('Muse recomendado', 'Muse recommended')}{museReco(a).tool ? ` · ${museReco(a).tool}` : ''}</div>
                ) : (
                  <button type="button" onClick={() => updateAgent(i, { provider: 'meta', model: museReco(a).model, wanted_provider: undefined, color: null })} className="absolute -top-[15px] left-1 max-w-full truncate text-[10px] leading-none text-[#0064E0] underline-offset-2 hover:underline" title={T(museReco(a).why, museReco(a).why_en)}>{T('Recomendado', 'Recommended')}: Muse {museReco(a).model.replace('muse-', '').replace('-1.0', '').replace('-1.3', ' 1.3')}</button>
                )}
                <ModelSelect provider={a.provider} value={a.model} onChange={(m) => updateAgent(i, { model: m })} enabled={!!p?.configured} className="text-xs" />
              </div>
              <button onClick={() => setCfg({ ...cfg, agents: cfg.agents.filter((_, j) => j !== i) })} disabled={cfg.agents.length <= 2} className="text-ink-3 hover:text-danger disabled:opacity-20"><Trash2 size={16} /></button>
            </>
          )}
        </div>
        <div className="mt-2 grid grid-cols-1 items-start gap-2 sm:grid-cols-[230px_1fr]">
          <div>
            <select className={input} value={a.role ?? 'custom'} onChange={(e) => setRole(i, e.target.value)} title={T('Rol en el equipo', 'Role in the team')}>
              {roles.groups.map((g) => (
                <optgroup key={g} label={lang === 'en' ? roles.groups_en?.[roles.groups.indexOf(g)] ?? g : g}>
                  {roles.roles.filter((r) => r.group === g).map((r) => <option key={r.id} value={r.id}>{pick(r, 'label')}</option>)}
                </optgroup>
              ))}
            </select>
            {(() => {
              const r = roles.roles.find((x) => x.id === a.role)
              return r?.mandate ? <div className="mt-1 text-[11px] leading-snug text-ink-3">{T('Debe resolver:', 'Must resolve:')} {pick(r, 'mandate')}</div> : <div className="mt-1 text-[11px] text-ink-4">{T('Sin rol fijo: define la personalidad a la derecha.', 'No fixed role: define the personality on the right.')}</div>
            })()}
          </div>
          <PersonaField value={a.persona} onChange={(v) => updateAgent(i, { persona: v })} placeholder={T('personalidad (opcional, se suma al rol)', 'personality (optional, adds to the role)')} roleLabel={a.name} />
        </div>
        <div className="mt-1.5"><SkillPicker value={a.skills ?? []} onChange={(ids) => updateAgent(i, { skills: ids })} /></div>
        {a.wanted_provider && a.provider === 'baseten' && <div className="mt-1 text-[11px] text-gold">{T('Prueba gratis: corre en', 'Free trial: runs on')} {a.model} {T('(modelo abierto vía Baseten)', '(open model via Baseten)')}{trialProvider?.trial_left != null ? T(`, te quedan ${trialProvider.trial_left} rondas`, `, ${trialProvider.trial_left} rounds left`) : ''}. <button className="underline hover:text-accent" onClick={onSettings}>{T('Cargá la key de', 'Add the key for')} {a.wanted_provider}</button>{T(' para usar el modelo real.', ' to use the real model.')}</div>}
        {a.wanted_provider && a.provider !== 'baseten' && <div className="mt-1 text-[11px] text-gold">{T('Simulado: falta la key de', 'Simulated: missing the key for')} {a.wanted_provider}. <button className="underline hover:text-accent" onClick={onSettings}>{T('Cargala en Configuración', 'Add it in Settings')}</button>{T(' para usar el modelo real.', ' to use the real model.')}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto scroll-thin arena-bg">
      <AnimatePresence>{booting ? <HomeLoader key="loader" /> : opening ? <HomeLoader key="opening" caption={opening} /> : null}</AnimatePresence>
      {laneAsk && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={() => setLaneAsk(false)}>
          <div className="w-full max-w-[720px] rounded-3xl border border-line bg-surface p-7 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Primer proyecto', 'First project')}</div>
            <h3 className="serif mt-1 text-[28px] leading-tight">{T('¿Cómo querés construirlo?', 'How do you want to build it?')}</h3>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => pickLaneAndGo('direct')} className="group rounded-2xl border border-line p-5 text-left transition hover:border-accent hover:bg-accent-soft/50">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-ink-3"><Zap size={13} className="text-accent" /> {T('Un prompt → una app', 'One prompt → one app')}</div>
                <div className="mt-2 text-[19px] leading-tight">{T('Constructor directo', 'Direct builder')}</div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{T('Tu pedido pasa por prompt engineering y el constructor arranca ya. Lo más rápido y lo más barato.', 'Your request goes through prompt engineering and the builder starts right away. Fastest and cheapest.')}</p>
              </button>
              <button type="button" onClick={() => pickLaneAndGo('team')} className="group rounded-2xl border border-line p-5 text-left transition hover:border-accent hover:bg-accent-soft/50">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-ink-3"><Users size={13} className="text-accent" /> {T('Debate → brief → construcción', 'Debate → brief → build')}</div>
                <div className="mt-2 text-[19px] leading-tight">{T('Constructor con equipo de desarrollo', 'Builder with a development team')}</div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{T('CEO, CTO, Producto, Diseño y QA debaten tu idea, acuerdan el brief y recién entonces construyen.', 'CEO, CTO, Product, Design and QA debate your idea, agree on the brief and only then build.')}</p>
              </button>
            </div>
            <div className="mt-4 text-right"><button type="button" onClick={() => setLaneAsk(false)} className="rounded-full px-3 py-1.5 text-[13px] text-ink-3 hover:text-ink">{T('Cancelar', 'Cancel')}</button></div>
          </div>
        </div>
      )}
      {editAgent !== null && cfg.agents[editAgent] && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={() => setEditAgent(null)}>
          <div className="w-full max-w-[900px] rounded-3xl border border-line bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Rol del equipo', 'Team role')}</div>
                <h3 className="serif mt-1 text-[24px] leading-tight">{pick(cfg.agents[editAgent], 'name')}</h3>
              </div>
              <button type="button" onClick={() => setEditAgent(null)} className="rounded-full p-1.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={18} /></button>
            </div>
            {renderAgentCard(cfg.agents[editAgent], editAgent)}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <button type="button" disabled={suggesting} onClick={() => suggestSkillsFor(editAgent)} className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-3.5 py-2 text-[13px] font-semibold text-accent transition hover:bg-accent hover:text-white disabled:opacity-40" title={T('Elegir del catálogo las skills que mejor encajan con la tarea para este rol', 'Pick from the catalog the skills that best fit the task for this role')}>{suggesting ? <Loader2 size={14} className="animate-spin" /> : <Puzzle size={14} />} {T('Sugerir skills para este rol', 'Suggest skills for this role')}</button>
              <button type="button" onClick={() => setEditAgent(null)} className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110">{T('Listo', 'Done')}</button>
            </div>
          </div>
        </div>
      )}
      {nameDialog}
      {deleteDialog}
      {chooser && (() => {
        const p = chooser.preset
        const run = chooser.run
        const team = p.agents.map((a) => a.wanted_provider ?? a.provider)
        const option = (icon: ReactNode, title: string, desc: string, onClick: () => void, disabled = false) => (
          <button type="button" disabled={disabled} onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
            <span className="min-w-0"><span className="block text-sm font-semibold text-ink">{title}</span><span className="block text-[12px] text-ink-3">{desc}</span></span>
          </button>
        )
        const noRun = run === null
        const loading = run === undefined
        const runHint = loading ? T('buscando la última corrida…', 'looking for the last run…') : noRun ? T('Todavía no corriste este experimento.', 'You have not run this experiment yet.') : `${T('Última corrida', 'Last run')}: ${new Date(run.created * 1000).toLocaleString()}${run.turns ? ` · ${run.turns} ${T('turnos', 'turns')}` : ''}`
        return (
          <div className="fixed inset-0 z-[150] flex items-center justify-center bg-paper/70 p-4 backdrop-blur-sm" onClick={() => setChooser(null)}>
            <div className="panel relative w-full max-w-md overflow-hidden rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
              <BrandStripes providers={team} logos={false} />
              <div className="absolute inset-0 bg-surface/60" aria-hidden />
              <div className="relative">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs uppercase tracking-widest text-ink-3">{T('Tu experimento', 'Your experiment')}</div>
                    <div className="mt-0.5 text-[17px] font-semibold leading-tight text-ink">{pick(p, 'title')}</div>
                  </div>
                  <button type="button" onClick={() => setChooser(null)} className="shrink-0 text-ink-3 hover:text-ink" title={T('Cerrar', 'Close')}><X size={16} /></button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                  <BrandLogoRow providers={team} compact />
                  <span>{p.agents.length} {T('agentes', 'agents')} · {pick(MODE_INFO[p.mode], 'label')}</span>
                </div>
                <div className="mt-1 text-[12px] text-ink-3">{runHint}</div>
                <div className="mt-4 space-y-2">
                  {option(<FolderOpen size={17} />, T('Ver el proyecto', 'See the project'), T('Abre lo construido en la última corrida: código, vista previa y versiones.', 'Opens what the last run built: code, preview and versions.'), () => { setChooser(null); if (run) { setOpening(T('Abriendo el proyecto…', 'Opening the project…')); onOpen(run.id) } }, loading || noRun)}
                  {option(<Users size={17} />, T('Cambiar la configuración de los agentes', 'Change the agents’ setup'), T('Carga el experimento acá abajo para editar roles, modelos, prompts y skills antes de volver a correrlo.', 'Loads the experiment below to edit roles, models, prompts and skills before running it again.'), () => { setChooser(null); applyPreset(p); setTimeout(() => teamRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80) })}
                  {option(<Eye size={17} />, T('Ver el consejo', 'See the council'), T('Muestra el último debate tal como quedó, sin correr nada ni gastar tokens.', 'Shows the last debate as it ended, without running anything or spending tokens.'), () => { setChooser(null); if (run) { setOpening(T('Abriendo el consejo…', 'Opening the council…')); useArena.getState().set({ pendingLive: run.id }) } }, loading || noRun)}
                </div>
              </div>
            </div>
          </div>
        )
      })()}
      {launching && (
        <ArenaIntro
          team={introTeam(cfg.agents.map((a) => ({ ...a, roleLabel: roles.roles.find((r) => r.id === a.role)?.label })), (p) => providers.find((x) => x.id === p)?.label.split(' · ')[0] ?? p)}
          onDone={async () => {
            // the stage fades out → start the debate; if it cannot start (missing topic, API error…) come back to the setup
            setStarting(true)
            try {
              await start()
            } finally {
              setStarting(false)
              setLaunching(false)
            }
          }}
        />
      )}
      {starting && (
        <div className="fixed inset-0 z-[119] flex flex-col items-center justify-center gap-3 bg-paper/80 backdrop-blur-sm">
          <div className="flex items-center -space-x-1">
            {[...new Set(cfg.agents.map((a) => a.wanted_provider ?? a.provider))].map((p) => (
              <span key={p} className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white ring-1 ring-black/10 shadow-sm"><ProviderLogo provider={p} size={20} /></span>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm text-ink-2"><Loader2 size={15} className="animate-spin" /> {T('Conectando con los modelos y abriendo la arena…', 'Connecting to the models and opening the arena…')}</div>
          {error && <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-1.5 text-[12.5px] text-danger">{error}</div>}
        </div>
      )}
      <div className="w-full px-4 py-5 sm:px-8 sm:py-10 2xl:px-12">
        {/* the sections live in the side bar (AppShell); on a phone only the brand, the tab bar is at the bottom */}
        <div className="-mb-2 flex items-center gap-3 md:hidden">
          <img src="/icon.svg?v=3" alt="" aria-hidden className="h-9 w-9 rounded-xl shadow-sm" draggable={false} />
          <span className="serif text-xl">Muse <em className="text-accent">Team</em></span>
        </div>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-3 md:mt-0">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Tu tablero', 'Your dashboard')}</div>
            <h1 className="serif mt-1 text-[30px] leading-tight">{T(`Hola, ${user.name.split(' ')[0]}`, `Hi, ${user.name.split(' ')[0]}`)}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => document.getElementById('projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-ink-2 shadow-sm transition hover:border-accent hover:text-accent"><FolderOpen size={16} /> {T('Mis proyectos', 'My projects')}</button>
            <button onClick={() => document.getElementById('new-project')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="flex h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white shadow-md transition hover:brightness-110"><Plus size={16} /> {T('Nuevo proyecto', 'New project')}</button>
          </div>
        </div>
        <HomeOverview onOpenProject={(id) => onOpen(id, 'builder')} />
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-6 md:mt-5">
          {/* no hero on the home: the brand is in the header, the companies' row is the first thing */}
          <div className="flex flex-wrap gap-2 text-[11px]">
            {providers.filter((p) => !MUSE_FIRST || showAllProviders || p.id === 'meta' || p.id === 'mock' || p.configured).map((p) => (
              <ProviderChip key={p.id} provider={p} active={connecting === p.id} onSettings={onSettings} onOpen={() => setConnecting(p.id)} />
            ))}
            {MUSE_FIRST && !showAllProviders && providers.some((p) => !(p.id === 'meta' || p.id === 'mock' || p.configured)) && (
              <button type="button" onClick={() => setShowAllProviders(true)} className="rounded-full border border-dashed border-line px-2.5 py-1 font-mono text-[11px] text-ink-3 transition hover:border-accent hover:text-accent">{T('+ otros proveedores compatibles', '+ other compatible providers')}</button>
            )}
          </div>
          {/* the chip being connected travels down here, alone and centred, so the others keep their place */}
          <AnimatePresence>
            {connecting && providers.find((x) => x.id === connecting) && (
              <ProviderConnect
                key={connecting}
                provider={providers.find((x) => x.id === connecting)!}
                onClose={() => setConnecting(null)}
                onConnected={(np) => {
                  setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x)))
                  invalidateModels(np.id)
                  setConnecting(null)
                }}
              />
            )}
          </AnimatePresence>
        </motion.div>

        {newLookOn() && <TeamTable />}

        <div id="new-project" className="scroll-mt-4" />
        {/* the two ways in: the builder alone (one good prompt) or the whole team (council first) */}
        {HACKATHON_MODE ? null : lane === null ? (
          <LaneCards onPick={setLane} />
        ) : (
          <div className="mt-8 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.3em] text-ink-3">{T('Modo de construcción', 'Build mode')}</div>
              <div className="mt-1 text-[22px] leading-tight">{lane === 'direct' ? T('Constructor directo', 'Direct builder') : T('Constructor con equipo de desarrollo', 'Builder with a development team')}</div>
              <div className="mt-1 text-[13px] text-ink-2">{lane === 'direct' ? T('Tu pedido pasa por prompt engineering y va directo al constructor, sin consejo previo.', 'Your request goes through prompt engineering and straight to the builder, with no council first.') : T('El equipo debate tu idea, acuerda el brief y recién entonces construye.', 'The team debates your idea, agrees on the brief and only then builds.')}</div>
            </div>
            {!HACKATHON_MODE && <span className="lane-ring lane-ring-pill inline-flex shrink-0"><button type="button" onClick={() => setLane(null)} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent"><ArrowLeftRight size={14} /> {T('Cambiar de modo', 'Change mode')}</button></span>}
          </div>
        )}
        {lane === 'team' && presets.some((p) => p.custom) && (
          <>
            <h2 className="mt-10 flex items-center gap-2 font-sans text-xs uppercase tracking-widest text-ink-3"><Bookmark size={13} /> {T('Tus experimentos', 'Your experiments')} <span className="text-ink-4">({presets.filter((p) => p.custom).length})</span></h2>
            <div className="mt-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">{presets.filter((p) => p.custom).map(presetCard)}</div>
          </>
        )}
        {lane === 'team' && (
          <>
            <h2 className="mt-10 font-sans text-xs uppercase tracking-widest text-ink-3">{T('Experimentos', 'Experiments')}</h2>
            <div data-tour="experiments" className="mt-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
              {presets.filter((p) => !p.custom).map(presetCard)}
            </div>
          </>
        )}

        {lane !== null && (
        <div data-lane={lane} className={`mt-8 grid grid-cols-1 gap-6 [&>*]:min-w-0 ${lane === 'direct' ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]'}`}>
          <div className="panel relative isolate flex flex-col rounded-2xl p-4 sm:p-5">
            {/* the companies in the team as vertical brand stripes behind the brief (one per AI, its colour); the stripes and the veil carry the card's radius themselves, so the border and shadow stay intact */}
            <BrandStripes providers={cfg.agents.map((a) => a.wanted_provider ?? a.provider)} logos={false} />
            <div className="absolute inset-0 rounded-[inherit] bg-surface/35" aria-hidden />
            <div className="relative space-y-4">
            <label className="block">
              <FieldTitle title={T('Nombre de la app', 'App name')} />
              <input className={`${input} mt-1`} value={cfg.title ?? ''} onChange={(e) => setCfg({ ...cfg, title: e.target.value })} placeholder={T('cómo se va a llamar', 'what it will be called')} />
            </label>
            {/* idea + attachments → prompt-engineered brief; until one is generated, the user's own text is the topic */}
            <Intake
              idea={idea}
              onIdea={(t) => { setIdea(t); if (!promptMd) setCfg((c) => ({ ...c, topic: t })) }}
              providers={providers}
              onConnected={(np) => { setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x))); invalidateModels(np.id) }}
              promptActive={!!promptMd}
              onPrompt={(md, ctx) => { setPromptMd(md); setCfg((c) => ({ ...c, topic: md, context: ctx ?? c.context ?? null })) }}
              onDiscardPrompt={() => { setPromptMd(null); setCfg((c) => ({ ...c, topic: idea, context: null })) }}
              team={cfg.agents.map((a) => { const r = roles.roles.find((x) => x.id === a.role); return { id: a.id, name: a.name, role: a.role, label: r ? pick(r, 'label') : undefined, mandate: r ? pick(r, 'mandate') : undefined, persona: a.persona } })}
              onRolePrompts={(prompts) => {
                // tailored prompts replace the personalities; they are the user's now, so the language switch leaves them alone
                setCfg((c) => ({ ...c, agents: c.agents.map((a) => (prompts[a.id] ? { ...a, persona: prompts[a.id] } : a)) }))
                if (baseline.current) baseline.current = { ...baseline.current, agents: {} }
              }}
            />
            {/* the direct lane: who builds, a local agent on the subscription (Muse Code) or an API model */}
            {lane === 'direct' && (
              <div data-tour="builder">
                <FieldTitle title={T('Constructor', 'Builder')} sub={T('Quién escribe el código: Muse Code instalado en esta máquina o Muse por API con tu key.', 'Who writes the code: Muse Code installed on this machine or Muse via API with your key.')} />
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {engines.map((e) => {
                    const on = builder.provider === e.id
                    return (
                      <button key={e.id} type="button" disabled={!e.ok} onClick={() => setBuilder({ provider: e.id, model: 'default' })} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'} disabled:cursor-not-allowed disabled:opacity-50`}>
                        <ProviderLogo provider={e.logo} size={22} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{e.label.split(' · ')[0]} · {T('escritorio', 'desktop')}</span>
                          <span className="block truncate text-[11.5px] text-ink-3">{e.ok ? T('Con tu suscripción, sin gastar API', 'On your subscription, no API spend') : e.installed ? T('Instalado, falta iniciar sesión', 'Installed, sign in first') : T('No instalado en esta máquina', 'Not installed on this machine')}</span>
                        </span>
                      </button>
                    )
                  })}
                  <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 transition sm:col-span-2 ${isApiBuilder ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                    <button type="button" onClick={() => { if (!isApiBuilder) { const p = apiProviders[0]; if (p) setBuilder({ provider: p.id, model: p.default_model }) } }} className="flex items-center gap-3 text-left">
                      {isApiBuilder ? <ProviderLogo provider={builder.provider} size={22} /> : <KeyRound size={20} className="text-ink-3" />}
                      <span>
                        <span className="block text-sm font-medium">{T('Por API', 'Via API')}</span>
                        <span className="block text-[11.5px] text-ink-3">{T('Un modelo con tu API key; se cobran los tokens', 'A model with your API key; tokens are billed')}</span>
                      </span>
                    </button>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <select value={isApiBuilder ? builder.provider : ''} onChange={(e) => { if (ai.ask(e.target.value, (np) => setBuilder({ provider: np.id, model: np.default_model }))) return; const p = apiProviders.find((x) => x.id === e.target.value); if (p) setBuilder({ provider: p.id, model: p.default_model }) }} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm outline-none">
                        {!isApiBuilder && <option value="">{T('elegir proveedor…', 'pick a provider…')}</option>}
                        {apiProviders.filter((p) => p.configured).map((p) => <option key={p.id} value={p.id}>{p.label.split(' · ')[0]}</option>)}
                        {ai.options}
                      </select>
                      {ai.dialog}
                      {isApiBuilder && <span className="w-[220px]"><ModelSelect provider={builder.provider} value={builder.model} onChange={(m) => setBuilder({ ...builder, model: m })} /></span>}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/* the direct lane does not debate, but the team is who reviews and audits afterwards: show each role with its Muse model */}
            {lane === 'direct' && (
              <div data-tour="direct-team">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldTitle className="min-w-[min(100%,220px)] flex-1" title={T('Tu equipo', 'Your team')} sub={T('No debate antes de construir: son los roles que revisan y auditan la app cuando está lista. Tocá uno para editarlo.', 'It does not debate before building: these are the roles that review and audit the app once it is ready. Tap one to edit it.')} />
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                  <EmployeePicker onUse={applyEmployees} />
                  <button type="button" onClick={() => openTeam()} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-2 transition hover:border-accent hover:text-accent"><Settings2 size={14} /> {T('Editar mi equipo', 'Edit my team')}</button>
                  <button type="button" disabled={cfg.agents.length >= 8} onClick={() => { const n = cfg.agents.length; addAgent(); setEditAgent(n) }} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"><Plus size={14} /> {T('Agregar rol', 'Add role')}</button>
                  {MUSE_FIRST && !cfg.agents.every(isMuseReco) && <button type="button" onClick={() => setCfg((c) => ({ ...c, agents: museTeam(c.agents) }))} className="flex items-center gap-1.5 rounded-full border border-[#BBD5FA] bg-[#EEF5FF] px-3 py-1 text-[12px] font-semibold text-[#0B2E66] transition hover:border-[#0082FB]"><ProviderLogo provider="meta" size={13} /> {T('Usar los modelos recomendados', 'Use the recommended models')}</button>}
                  </div>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {cfg.agents.map((a, i) => {
                    const r = museReco(a)
                    const ok = isMuseReco(a)
                    return (
                      <button type="button" key={a.id} onClick={() => setEditAgent(i)} title={T('Editar rol: modelo, prompt y skills', 'Edit role: model, prompt and skills')} className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition hover:border-accent hover:shadow-sm ${ok ? 'border-[#BBD5FA] bg-[#EEF5FF]/60' : 'border-line bg-surface'}`}>
                        <AgentAvatar agent={a} size={38} ring={false} logo={0.34} chip />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{pick(a, 'name')}</div>
                          <div className="truncate font-mono text-[10.5px] text-ink-3">{ok ? a.model : `${a.provider} · ${a.model}`}</div>
                          {MUSE_FIRST && <div className="truncate text-[10.5px] text-[#0064E0]" title={T(r.why, r.why_en)}>{ok ? '✓ ' + T('Muse recomendado', 'Muse recommended') : `${T('Recomendado', 'Recommended')}: ${r.model}`}{r.tool ? ` · ${r.tool}` : ''}</div>}
                        </div>
                        {(a.skills?.length ?? 0) > 0 && <span className="shrink-0 rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] text-ink-2" title={(a.skills ?? []).join(' · ')}>🧩 {a.skills!.length} {a.skills!.length === 1 ? 'skill' : 'skills'}</span>}
                        <Settings2 size={14} className="shrink-0 text-ink-4" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {/* what gets built: the brief, the designer, the builder and «Correr la app» all follow this */}
            <div>
              <FieldTitle title={T('Plataforma', 'Platform')} sub={T('Qué construye el equipo: una web app, una app móvil para iOS y Android (con Expo, se corre en el simulador y el emulador desde acá) o las dos con un solo código.', 'What the team builds: a web app, a mobile app for iOS and Android (with Expo, run on the simulator and the emulator from here) or both from one codebase.')} />
              <div className="mt-1 grid grid-cols-3 gap-2">
                {([
                  { id: 'web' as const, icon: <Globe size={15} />, title: T('Web app', 'Web app'), text: T('Navegador, escritorio y móvil', 'Browser, desktop and mobile') },
                  { id: 'mobile' as const, icon: <Smartphone size={15} />, title: T('App móvil', 'Mobile app'), text: T('iOS y Android · Expo', 'iOS and Android · Expo') },
                  { id: 'both' as const, icon: <MonitorSmartphone size={15} />, title: T('Ambas', 'Both'), text: T('Un solo código, web + tiendas', 'One codebase, web + stores') },
                ]).map((o) => {
                  const on = (cfg.platform ?? 'web') === o.id
                  return (
                    <button key={o.id} type="button" onClick={() => setCfg((c) => ({ ...c, platform: o.id }))} className={`flex min-w-0 flex-col items-start gap-1.5 rounded-xl border px-2.5 py-2.5 text-left transition sm:flex-row sm:gap-2.5 sm:px-3 ${on ? 'border-accent bg-accent-soft shadow-[0_0_0_3px_rgba(47,107,93,.12)]' : 'border-line bg-surface hover:border-accent hover:bg-accent-soft'}`}>
                      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${on ? 'bg-accent text-white' : 'bg-surface-2 text-ink-3'}`}>{o.icon}</span>
                      <span className="min-w-0 break-words"><span className={`block text-[13px] font-semibold ${on ? 'text-accent' : 'text-ink'}`}>{o.title}</span><span className="block text-[11px] leading-snug text-ink-3">{o.text}</span></span>
                    </button>
                  )
                })}
              </div>
            </div>
            {/* reference apps: the build's research phase visits them before designing (empty → the team proposes them) */}
            <div>
              <FieldTitle title={T('Apps de referencia', 'Reference apps')} sub={T('Apps o sitios parecidos que el equipo va a mirar antes de diseñar: entra, saca capturas y anota qué emular y qué evitar. Podés dejarlo vacío y el equipo propone los líderes de la categoría.', 'Similar apps or sites the team studies before designing: it visits them, takes screenshots and notes what to emulate and avoid. Leave it empty and the team proposes the category leaders.')} />
              <div className={`${input} mt-1 flex flex-wrap items-center gap-1.5 py-1.5`}>
                {(cfg.references ?? []).map((r) => (
                  <span key={r} className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] text-accent">
                    {r}
                    <button type="button" onClick={() => setCfg((c) => ({ ...c, references: (c.references ?? []).filter((x) => x !== r) }))} className="text-accent/70 hover:text-danger" title={T('Quitar', 'Remove')}><X size={11} /></button>
                  </span>
                ))}
                <input
                  value={refDraft}
                  onChange={(e) => setRefDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitRefs() } }}
                  onBlur={commitRefs}
                  placeholder={(cfg.references ?? []).length ? T('otra…', 'another…') : T('ej. apple.com/weather, windy.com (Enter para agregar)', 'e.g. apple.com/weather, windy.com (Enter to add)')}
                  className="min-w-[200px] flex-1 bg-transparent text-sm outline-none placeholder:text-ink-4"
                />
              </div>
              {/* level 2: REA reverse-engineers those apps during the build (needs REA installed + Muse Code as builder) */}
              <label className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${rstatus && !rstatus.rea.ok ? 'opacity-60' : ''}`}>
                <input type="checkbox" className="accent-accent h-4 w-4 shrink-0" checked={cfg.deep_analysis ?? false} disabled={!!rstatus && !rstatus.rea.ok} onChange={(e) => setCfg({ ...cfg, deep_analysis: e.target.checked })} />
                <span>{T('Análisis profundo e ingeniería inversa', 'Deep analysis and reverse engineering')}</span>
                <span className="basis-full pl-6 text-[12.5px] leading-snug text-ink-3">{rstatus && !rstatus.rea.ok ? T('REA no está instalado en esta máquina: corré `npx rea-agents setup`. Hasta entonces el equipo solo observa las apps (capturas y notas), que es gratis.', 'REA is not installed on this machine: run `npx rea-agents setup`. Until then the team only observes the apps (screenshots and notes), which is free.') : T('Durante la construcción, REA analiza bundles, rutas y APIs de las apps de referencia para entender cómo están hechas. Requiere Muse Code como constructor. Corre con tu suscripción o tu API key.', 'During the build, REA analyses the reference apps\' bundles, routes and APIs to understand how they are built. Requires Muse Code as builder. Runs on your subscription or your API key.')}</span>
              </label>
            </div>
            <div className="team-only">
              <FieldTitle title={T('Modo', 'Mode')} sub={T('Cómo se organiza el debate del equipo.', 'How the team organises its debate.')} />
              <div className="mt-1 grid grid-cols-3 gap-2">
                {(Object.keys(MODE_INFO).filter((m) => m !== 'audit' && m !== 'review') as Mode[]).map((m) => (
                  <button key={m} onClick={() => setCfg({ ...cfg, mode: m })} className={`rounded-xl border px-3 py-2 text-left text-sm ${cfg.mode === m ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
                    {pick(MODE_INFO[m], 'label')}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-3">{pick(MODE_INFO[cfg.mode], 'desc')}</p>
            </div>
            <div className="team-only grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Range label={T('Turnos máx.', 'Max turns')} help={T('Cantidad máxima de intervenciones en total. Al llegar, el debate termina aunque nadie haya dicho FIN.', 'Maximum number of interventions overall. When reached, the debate ends even if nobody said END.')} value={cfg.max_turns} min={2} max={40} onChange={(v) => setCfg({ ...cfg, max_turns: v })} />
              <Range label={T('Turnos mín. antes de FIN', 'Min turns before END')} help={T('Antes de este turno ningún agente puede cerrar el debate: garantiza un mínimo de discusión.', 'Before this turn no agent can close the debate: it guarantees a minimum of discussion.')} value={cfg.min_turns} min={1} max={20} onChange={(v) => setCfg({ ...cfg, min_turns: v })} />
              <Range label={T('Pausa entre turnos', 'Pause between turns')} help={T('Espera entre una intervención y la siguiente, para que la cámara y el espectador puedan seguir el ritmo. No afecta el costo.', 'Wait between one intervention and the next, so the camera and the viewer can follow. Does not affect cost.')} value={cfg.pace_ms} min={0} max={3000} step={100} fmt={(v) => `${v}ms`} onChange={(v) => setCfg({ ...cfg, pace_ms: v })} />
              <Range label={T('Tokens máx. por turno', 'Max tokens per turn')} help={T('Largo máximo de cada intervención (≈ 1 token por cada 3-4 caracteres). Más tokens: respuestas más largas y más costo por turno.', 'Maximum length of each intervention (≈ 1 token per 3-4 characters). More tokens: longer answers and more cost per turn.')} value={cfg.max_tokens} min={300} max={6000} step={100} onChange={(v) => setCfg({ ...cfg, max_tokens: v })} />
            </div>
            <div className="team-only"><CostEstimate cfg={cfg} align="left" /></div>
            <div className="grid grid-cols-1 gap-4 items-start sm:grid-cols-2">
              <label className="block">
                <FieldTitle title={T('Idioma', 'Language')} sub={T('El idioma en el que van a hablar los agentes del consejo durante el debate y en el brief. Es independiente del idioma de esta interfaz.', 'The language the council agents will speak in during the debate and in the brief. Independent from the language of this interface.')} />
                <select className={`${input} mt-1`} value={cfg.language} onChange={(e) => setCfg({ ...cfg, language: e.target.value })}>
                  {(DEBATE_LANGUAGES.includes(cfg.language) ? DEBATE_LANGUAGES : [cfg.language, ...DEBATE_LANGUAGES]).map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <div className="team-only space-y-1.5 pb-1">
                {([
                  { key: 'closing_round', checked: cfg.closing_round ?? true, label: T('Ronda de cierre', 'Closing round'), help: T('Al terminar el debate, cada rol entrega sus decisiones finales en un turno propio. Sirve para que el brief tenga conclusiones de todos, no solo de quien habló último.', 'When the debate ends, each role delivers its final decisions in its own turn. It makes the brief carry conclusions from everyone, not just whoever spoke last.'), set: (v: boolean) => setCfg({ ...cfg, closing_round: v }) },
                  { key: 'final_vote', checked: cfg.final_vote, label: T('Votación final', 'Final vote'), help: T('Cada agente vota quién aportó el argumento más sólido y el juez explica el veredicto. Si lo apagás, el debate termina sin ganador.', 'Each agent votes for who made the strongest argument and the judge explains the verdict. Turn it off and the debate ends without a winner.'), set: (v: boolean) => setCfg({ ...cfg, final_vote: v }) },
                  { key: 'auto_skills', checked: cfg.auto_skills ?? false, label: T('El consejo elige skills', 'The council picks skills'), help: T('Antes de arrancar, cada rol recibe las skills del catálogo que mejor encajan con la tarea. Se suman a las que elegiste; nunca las reemplazan.', 'Before starting, each role gets the catalog skills that best fit the task. They are added to the ones you chose; never replaced.'), set: (v: boolean) => setCfg({ ...cfg, auto_skills: v }) },
                ] as const).map((o) => (
                  <label key={o.key} className="flex min-h-7 items-start gap-2 text-sm leading-tight">
                    <input type="checkbox" checked={o.checked} onChange={(e) => o.set(e.target.checked)} className="accent-accent mt-0.5 h-4 w-4 shrink-0" />
                    <span><span className="block font-medium text-ink">{o.label}</span><span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{o.help}</span></span>
                  </label>
                ))}
              </div>
            </div>
            </div>
            {/* the logos live under the fields and follow the scroll (sticky) until the box ends; they never rise above this point */}
            <div className="team-only relative mt-2 flex-1 min-h-[150px]">
              <div className="sticky top-24">
                <BrandLogoRow providers={cfg.agents.map((a) => ({ provider: a.wanted_provider ?? a.provider, model: a.model }))} align="start" />
              </div>
            </div>
          </div>
          <div ref={teamRef} data-tour="agents" className="team-only panel flex h-full flex-col rounded-2xl p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-y-2">
              <FieldTitle className="w-full" title={`${T('Agentes', 'Agents')} (${cfg.agents.length}/8)`} sub={T('Cada tarjeta es un rol: elegí qué IA lo ocupa y cómo piensa.', 'Each card is a role: choose which AI takes it and how it thinks.')} />
              <button
                disabled={suggesting || !cfg.topic.trim()}
                onClick={async () => {
                  // the catalog picks skills per role from the task; they are added on top of what the user chose
                  setSuggesting(true)
                  try {
                    const r = await api.suggestSkills(cfg.topic, cfg.agents.map((a) => { const role = roles.roles.find((x) => x.id === a.role); return { id: a.id, label: role?.label ?? a.name, group: role?.group, mandate: role?.mandate } }), 2)
                    let added = 0
                    const agents = cfg.agents.map((a) => { const sug = (r.per_role[a.id] ?? []).filter((x) => (x.score ?? 0) >= 15 && !(a.skills ?? []).includes(x.id)).map((x) => x.id); added += sug.length; return sug.length ? { ...a, skills: [...(a.skills ?? []), ...sug] } : a })
                    setCfg((c) => ({ ...c, agents }))
                    toast.ok(added ? `${added} skill${added === 1 ? '' : 's'} ${added === 1 ? tr('del catálogo sugerida', 'suggested from the catalog') : tr('del catálogo sugeridas', 'suggested from the catalog')}` : tr('Sin sugerencias claras', 'No clear suggestions'), added ? tr('Quedaron cargadas en cada rol; sacá las que no quieras.', 'They are loaded on each role; remove the ones you do not want.') : tr('Escribí más detalle en la consigna o buscá en el catálogo de cada rol.', "Add more detail to the brief or search each role's catalog."))
                  } catch (e) {
                    toast.error(tr('No se pudieron sugerir skills', 'Could not suggest skills'), (e as Error).message)
                  } finally {
                    setSuggesting(false)
                  }
                }}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5 text-[13px] font-semibold text-accent shadow-sm transition hover:bg-accent hover:text-white disabled:opacity-40 disabled:hover:bg-accent-soft disabled:hover:text-accent"
                title={T('Elegir del catálogo las skills que mejor encajan con la tarea, rol por rol', 'Pick from the catalog the skills that best fit the task, role by role')}
              >{suggesting ? <Loader2 size={14} className="animate-spin" /> : <Puzzle size={14} />} {T('Sugerir skills', 'Suggest skills')}</button>
              <div className="ml-2"><EmployeePicker onUse={applyEmployees} /></div>
              {MUSE_FIRST && <button type="button" onClick={() => setCfg((c) => ({ ...c, agents: museTeam(c.agents) }))} disabled={cfg.agents.every(isMuseReco)} className="ml-2 flex items-center gap-1.5 rounded-lg border border-[#BBD5FA] bg-[#EEF5FF] px-3 py-1.5 text-[13px] font-semibold text-[#0B2E66] shadow-sm transition hover:border-[#0082FB] disabled:opacity-40" title={T('Cada rol con el modelo de Muse que mejor hace su trabajo: Wonder para dirección e ingeniería, Spark para producto, diseño y QA', 'Every role on the Muse model that does its job best: Wonder for direction and engineering, Spark for product, design and QA')}><ProviderLogo provider="meta" size={14} /> {T('Equipo recomendado con Muse', 'Recommended Muse team')}</button>}
              <button disabled={cfg.agents.length >= 8} onClick={addAgent} className="ml-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40" title={T('Sumar un rol al equipo (hasta 8)', 'Add a role to the team (up to 8)')}><Plus size={15} />{T('Agregar rol', 'Add role')}</button>
            </div>
            <div className="mt-3 space-y-3">
              {cfg.agents.map(renderAgentCard)}
            </div>
            {/* with a small team the panel has room to spare: invite more roles instead of leaving it blank */}
            {cfg.agents.length < 4 && (
              <button type="button" onClick={addAgent} className="mt-3 flex w-full flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line px-4 py-8 text-center transition hover:border-accent hover:bg-accent-soft/40">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent"><Plus size={20} /></span>
                <span className="text-[14px] font-semibold text-ink">{T('Sumá más roles al equipo', 'Add more roles to the team')}</span>
                <span className="max-w-sm text-[12.5px] leading-snug text-ink-3">{T('Con 4 a 6 roles el debate cubre producto, técnica, diseño y calidad. Cada rol puede ser de una IA distinta.', 'With 4 to 6 roles the debate covers product, engineering, design and quality. Each role can be a different AI.')}</span>
              </button>
            )}
            {/* the table rules: who opens, who judges */}
            <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
              <label className="block">
                <FieldTitle title={T('Quién arranca', 'Who opens')} sub={T('El rol que abre el debate con la primera intervención. Después, cada agente elige a quién le pasa la palabra.', 'The role that opens the debate with the first intervention. After that, each agent chooses who gets the floor next.')} />
                <select className={`${input} mt-1`} value={cfg.starter ?? ''} onChange={(e) => setCfg({ ...cfg, starter: e.target.value || null })}>
                  <option value="">{cfg.agents[0]?.name ?? '—'} {T('(primero de la lista)', '(first in the list)')}</option>
                  {cfg.agents.slice(1).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label className={`block ${cfg.final_vote ? '' : 'opacity-50'}`}>
                <FieldTitle title={T('Juez del veredicto', 'Verdict judge')} sub={T('Al terminar, cada agente vota y un juez neutral explica por qué ganó quien ganó y qué se decidió. Acá elegís qué modelo hace de juez: usa el modelo del rol que marques. Requiere "Votación final" activada.', 'At the end each agent votes and a neutral judge explains why the winner won and what was decided. Pick which model acts as judge: it uses the model of the role you choose. Requires "Final vote" on.')} />
                <select className={`${input} mt-1`} disabled={!cfg.final_vote} value={cfg.judge ?? ''} onChange={(e) => setCfg({ ...cfg, judge: e.target.value || null })}>
                  <option value="">{cfg.agents[0] ? `${cfg.agents[0].name} · ${cfg.agents[0].model}` : '—'}</option>
                  {cfg.agents.slice(1).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}
                  <option value="none">{T('sin juez', 'no judge')}</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        )}

        {lane !== null && error && <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
        {lane !== null && (
        <div className="mt-6 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end sm:gap-4 [&>button]:justify-center [&>button]:whitespace-nowrap">
          {lane === 'team' && (
          <button
              type="button"
              onClick={async () => {
                const title = await askName(tr('Guardar como experimento', 'Save as experiment'), cfg.title || cfg.topic.slice(0, 60), { hint: tr('Nombre del experimento (así va a aparecer en la tarjeta). Se guarda el tema, el modo, el equipo y las skills, con su propio video.', 'Experiment name (as it will appear on the card). Saves the topic, mode, team and skills, with its own video.') })
                if (!title?.trim()) return
                try {
                  const p = await api.savePreset(cfg, title.trim())
                  setPresets((ps) => [...ps, p])
                  toast.ok(tr('Experimento guardado', 'Experiment saved'), tr('Ya tiene su tarjeta con video; la encontrás al final de la lista.', 'It has its own video card; find it at the end of the list.'))
                } catch (e) {
                  toast.error(tr('No se pudo guardar', 'Could not save'), (e as Error).message)
                }
              }}
              className="flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-sm hover:bg-surface-2"
              title={T('Guarda esta configuración (tema, modo, equipo, skills) como una tarjeta propia', 'Saves this setup (topic, mode, team, skills) as your own card')}
            ><Bookmark size={15} />{T(' Guardar como experimento', ' Save as experiment')}</button>
          )}
            {(() => {
              // the start button wears the team: one horizontal band per company (same soft blend as the panel) and their small logos side by side
              const team = cfg.agents.map((a) => a.wanted_provider ?? a.provider)
              const order = [...new Set(team)]
              const stops = order.map((p, i) => `${brandTheme(p).tint} ${(((i + 0.5) / order.length) * 100).toFixed(2)}%`).join(', ')
              const background = order.length === 1 ? brandTheme(order[0]).tint : `linear-gradient(90deg, ${stops})`
              return (
                <>
                {lane === 'direct' && (
                <button
                  data-tour="start"
                  onClick={() => research(true)}
                  disabled={busy || launching || directBusy}
                  title={T('Sin consejo: el pedido (con prompt engineering) se convierte en brief y el constructor arranca ya. Más rápido y más barato; el consejo queda a un clic después.', 'No council: the (prompt-engineered) request becomes the brief and the builder starts right away. Faster and cheaper; the council is one click away afterwards.')}
                  className="group flex items-center gap-2.5 rounded-2xl bg-accent px-6 py-3.5 text-lg font-bold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
                >
                  {directBusy ? <Loader2 size={20} className="animate-spin" /> : <Zap size={20} className="transition group-hover:scale-110" />}
                  {directBusy ? tr('Arrancando…', 'Starting…') : tr('Build', 'Build')}
                </button>
                )}
                {lane === 'team' && (
                <button data-tour="start" onClick={() => research(false)} disabled={busy || launching || directBusy || cfg.agents.length < 2} style={{ background }} className="group relative flex items-center gap-3 overflow-hidden rounded-2xl border border-black/10 text-ink px-6 py-3.5 font-bold text-lg shadow-sm hover:scale-[1.02] transition disabled:opacity-50" title={order.join(' · ')}>
                  {/* launch: the play icon slides out to the right, then the logos follow one by one (each one shows up big on stage as it leaves) */}
                  <span className="flex items-center -space-x-1">
                    {order.map((p, i) => (
                      <motion.span
                        key={p}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/80 ring-1 ring-black/10 shadow-sm"
                        animate={launching ? { x: 260, opacity: 0, scale: 1.3 } : { x: 0, opacity: 1, scale: 1 }}
                        transition={launching ? { duration: ICON_STEP * 1.6, ease: 'easeIn', delay: iconExitAt(order.length - 1 - i) } : { duration: 0.2 }}
                      >
                        <ProviderLogo provider={p} size={16} />
                      </motion.span>
                    ))}
                  </span>
                  <motion.span animate={launching ? { x: 220, opacity: 0 } : { x: 0, opacity: 1 }} transition={{ duration: PLAY_OUT, ease: 'easeIn' }} className="inline-flex">
                    <Play size={20} className="group-hover:translate-x-0.5 transition" />
                  </motion.span>
                  {launching ? tr('Reuniendo el equipo…', 'Gathering the team…') : busy ? tr('Investigando referencias…', 'Researching references…') : HACKATHON_MODE ? tr('Empezar a construir', 'Start building') : tr('Iniciar experimento', 'Start experiment')}
                </button>
                )}
                </>
              )
            })()}
        </div>
        )}

        <Dashboard onCreate={() => (HACKATHON_MODE ? pickLaneAndGo('team') : setLaneAsk(true))} onOpen={(id, mode) => { if (mode !== 'run') setOpening(mode === 'arena' ? T('Convocando al equipo…', 'Gathering the team…') : T('Abriendo el constructor…', 'Opening the builder…')); return onOpen(id, mode) }} onCouncil={(id) => { setOpening(T('Abriendo el consejo…', 'Opening the council…')); useArena.getState().set({ pendingLive: id }) }} onReplay={onReplay} onSettings={onSettings} onAudit={onAudit} onLoaded={() => mark('dashboard')} />
      </div>
    </div>
  )
}

/** Debounced server-side estimate of what the debate will cost in API tokens. */
function CostEstimate({ cfg, align = 'right' }: { cfg: SessionConfig; align?: 'left' | 'right' }) {
  const T = useT()
  const [est, setEst] = useState<{ total_usd: number } | null>(null)
  useEffect(() => {
    if (cfg.agents.length < 2) return
    const t = setTimeout(() => api.estimate({ ...cfg, min_turns: Math.min(cfg.min_turns, cfg.max_turns) }).then(setEst).catch(() => setEst(null)), 400)
    return () => clearTimeout(t)
  }, [cfg])
  const sim = cfg.agents.every((a) => a.provider === 'mock')
  if (!est) return null
  return (
    <div className={`${align === 'left' ? 'mt-2 flex flex-wrap items-baseline gap-x-2 rounded-lg border border-line bg-surface/70 px-3 py-1.5 text-left' : 'text-right'} text-[12px] text-ink-3`}>
      <div>{T('Costo estimado en API: ', 'Estimated API cost: ')}<b className="text-ink font-mono">{sim ? fmtUsd(0) : `≈ ${fmtUsd(est.total_usd)}`}</b></div>
      <div className="text-[11px] text-ink-4">{sim ? T('todos los agentes son simulados', 'all agents are simulated') : T('aprox., según el largo real de las respuestas', 'approx., depending on the actual length of the replies')}</div>
    </div>
  )
}

function Range({ label, help, value, min, max, step = 1, fmt, onChange }: { label: string; help?: string; value: number; min: number; max: number; step?: number; fmt?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="flex items-start gap-2">
        <FieldTitle className="min-w-0 flex-1" title={label} sub={help} />
        <span className="ml-auto w-14 shrink-0 text-right font-mono text-[13px] tabular-nums text-ink-2">{fmt ? fmt(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-accent mt-2" />
    </label>
  )
}

/** Small "?" that shows its explanation in a real tooltip on hover / focus / tap (native `title` is too slow and unreliable). */
const DEBATE_LANGUAGES = ['español rioplatense', 'español neutro', 'English', 'Português (Brasil)', 'Français', 'Deutsch', 'Italiano']

/** Key input in the model slot for a provider without key: "Probar" validates the key, saves it and the slot turns into the model list. */
/** Provider chip in the header. Configured (or simulated) → Settings. Without key → it travels down to the connect panel. */
function ProviderChip({ provider: p, active, onSettings, onOpen }: { provider: Provider; active: boolean; onSettings: () => void; onOpen: () => void }) {
  const T = useT()
  const openable = p.id !== 'mock'
  if (active) {
    // keeps the chip's room in the row while it is down in the panel, so nothing else moves
    return <span aria-hidden className="invisible rounded-full border px-2.5 py-1 font-mono">{p.label} {T('· conectar', '· connect')}</span>
  }
  return (
    <motion.span layoutId={`chip-${p.id}`} onClick={() => (openable ? onOpen() : onSettings())} title={p.configured ? tr('Ver o cambiar la API key', 'View or change the API key') : openable ? tr('Conectar con tu API key', 'Connect with your API key') : tr('Configurar', 'Settings')} className={`cursor-pointer rounded-full border px-2.5 py-1 font-mono hover:border-accent/50 ${p.configured ? 'border-line text-ink' : 'border-line text-ink-4'}`}>
      <ProviderLogo provider={p.id} size={14} className={`align-[-2px] mr-1 ${p.configured ? '' : 'opacity-30 grayscale'}`} />{p.id === 'mock' ? T('Simulado (sin API)', 'Simulated (no API)') : p.label} {p.configured ? '✓' : p.id === 'mock' ? '' : T('· conectar', '· connect')}
    </motion.span>
  )
}

/**
 * Connect panel under the chips: API-key input + "Probar". While testing the logo pulses with "conectando…"; on success
 * it says "conectado", the logo grows and fades and the chip goes back up as a connected one; on error the message shows
 * and the input returns so another key can be tried. Closing sends the chip back to its place.
 */
function ProviderConnect({ provider: p, onClose, onConnected }: { provider: Provider; onClose: () => void; onConnected: (p: Provider) => void }) {
  const T = useT()
  const [stage, setStage] = useState<'configured' | 'input' | 'testing' | 'ok'>(p.configured ? 'configured' : 'input')
  const [key, setKey] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<{ last4: string | null; source: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!p.configured) return
    api.settings().then((st) => {
      const mine = st.providers.find((x) => x.id === p.id)
      setInfo({ last4: mine?.user_key_last4 ?? null, source: mine?.source ?? 'none' })
    }).catch(() => setInfo({ last4: null, source: 'none' }))
  }, [p.id, p.configured])
  const disconnect = async () => {
    setBusy(true)
    try {
      await api.saveProvider(p.id, { clear_key: true })
      const fresh = (await api.providers()).find((x) => x.id === p.id)
      toast.ok(`${p.label} ${tr('desconectado', 'disconnected')}`, tr('La key se borró de tu cuenta.', 'The key was removed from your account.'))
      onConnected(fresh ?? { ...p, configured: false })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const go = async () => {
    const k = key.trim()
    if (!k) return
    setStage('testing')
    setErr(null)
    try {
      const r = await api.testKey(p.id, k)
      if (!r.ok) throw new Error(r.error || tr('La key no respondió', 'The key did not respond'))
      await api.saveProvider(p.id, { api_key: k })
      const fresh = (await api.providers()).find((x) => x.id === p.id)
      setStage('ok')
      setTimeout(() => onConnected(fresh ?? { ...p, configured: true }), 1400)
    } catch (e) {
      setErr((e as Error).message)
      setStage('input')
    }
  }
  const theme = brandTheme(p.id)
  return (
    <motion.div layoutId={`chip-${p.id}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -6 }} className="mx-auto mt-3 flex w-fit max-w-full flex-col items-stretch rounded-2xl border px-4 py-2.5 font-sans text-[12px] shadow-sm" style={{ borderColor: theme.border, background: theme.bg }}>
      <AnimatePresence mode="wait" initial={false}>
        {stage === 'configured' && (
          <motion.span key="configured" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-2">
            <ProviderLogo provider={p.id} size={16} />
            <span className="font-mono text-ink">{p.label}</span>
            <span className="text-ink-2">
              {T('ya tiene API key', 'already has an API key')}{info?.source === 'server' && !info.last4 ? T(' (del servidor)', ' (server key)') : ''}
              {info?.last4 && <span className="ml-1 font-mono text-ink">••••••••{info.last4}</span>}
            </span>
            <button type="button" onClick={() => { setStage('input'); setErr(null) }} className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 font-semibold text-white">{T('Usar otra API key', 'Use another API key')}</button>
            {info?.source === 'user' && (
              <button type="button" onClick={disconnect} disabled={busy} className="flex items-center gap-1 rounded-lg border border-line bg-white/70 px-2.5 py-1 text-ink-2 hover:text-danger disabled:opacity-50">{busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} {T('Desconectar', 'Disconnect')}</button>
            )}
            <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink" title={T('Cerrar', 'Close')}><X size={13} /></button>
          </motion.span>
        )}
        {stage === 'input' && (
          <motion.span key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-2">
            <ProviderLogo provider={p.id} size={16} />
            <span className="font-mono text-ink">{p.label}</span>
            <input
              autoFocus
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => { setKey(e.target.value); setErr(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onClose() }}
              placeholder={p.configured ? T('pegá la API key nueva', 'paste the new API key') : T('pegá tu API key', 'paste your API key')}
              className={`w-64 rounded-lg border bg-white/80 px-2 py-1 font-mono text-[12px] outline-none focus:border-accent ${err ? 'border-danger' : 'border-line'}`}
            />
            <button type="button" onClick={go} disabled={!key.trim()} className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 font-semibold text-white disabled:opacity-40"><Check size={12} />{T(' Probar', ' Test')}</button>
            <button type="button" onClick={() => (p.configured ? setStage('configured') : onClose())} className="text-ink-3 hover:text-ink" title={p.configured ? T('Volver', 'Back') : T('Cerrar', 'Close')}><X size={13} /></button>
          </motion.span>
        )}
        {stage === 'testing' && (
          <motion.span key="testing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-1 px-8 py-1">
            <motion.span animate={{ scale: [1, 1.18, 1], opacity: [1, 0.6, 1] }} transition={{ repeat: Infinity, duration: 1.1, ease: 'easeInOut' }} className="flex"><ProviderLogo provider={p.id} size={30} /></motion.span>
            <span className="text-ink-2">{T('conectando', 'connecting')}<motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1 }}>…</motion.span></span>
          </motion.span>
        )}
        {stage === 'ok' && (
          <motion.span key="ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-1 px-8 py-1">
            <motion.span initial={{ scale: 1, opacity: 1 }} animate={{ scale: 2.4, opacity: 0 }} transition={{ duration: 1.1, ease: 'easeOut' }} className="flex"><ProviderLogo provider={p.id} size={30} /></motion.span>
            <span className="font-semibold text-ok">{T('conectado ✓', 'connected ✓')}</span>
          </motion.span>
        )}
      </AnimatePresence>
      {err && (stage === 'input' || stage === 'configured') && <span className="mt-1 max-w-[420px] text-[11px] text-danger">{err}</span>}
    </motion.div>
  )
}

/** ES / EN switch in the header: every visible text on the start screens follows it. */

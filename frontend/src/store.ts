import { create } from 'zustand'
import { PALETTE } from './lib/brand'
import type { User } from './lib/api'
import type { AgentConfig, ArenaEvent, Handoff, SessionConfig, Turn, Vote } from './types'

export type Status = 'idle' | 'connecting' | 'running' | 'paused' | 'voting' | 'completed' | 'stopped' | 'error'

export interface PauseInfo {
  agent_id: string
  provider: string
  model: string
  error: string
  attempts: number
  kind?: 'transient' | 'account' | string
  phase?: string
}
export type Layout = 'wide' | 'vertical'

interface Live {
  agentId: string
  turn: number
  raw: string
  reasoning: string
  callerId: string | null
  reason: string | null
  phase: 'closing' | null
}

export interface Verdict {
  winner: string | null
  tally: Record<string, number>
  tie?: boolean
  tiebreak?: { rule: string; tied: string[]; confidence: Record<string, number | null> } | null
}

export interface CouncilVerdictData {
  session_id?: string | null  // the council session it came from (the arena's sessionId can move to the project's afterwards)
  approved: boolean
  headline: string
  why: string
  changes: { severity: 'bloqueante' | 'mejora'; role: string; text: string }[]
  priorities?: { id: string; text: string; status: string; note: string }[]
  level?: { current: number; next: number | null; label: string | null; pct: number; status: { id: string; text: string; status: string; note: string }[] } | null
  judge_id: string
  model: string
}

export interface Explanation {
  headline: string
  why: string
  key_moment: string
  others: string
  judge_id: string
  model: string
}

interface ArenaState {
  view: 'setup' | 'arena' | 'settings' | 'builder' | 'audit' | 'agents' | 'market' | 'tickets' | 'team' | 'analytics' | 'studio' | 'adtier' | 'metaads' | 'backoffice' | 'profile'
  sessionId: string | null
  source: 'live' | 'replay'
  status: Status
  pause: PauseInfo | null
  showTeam: boolean
  selectedAgent: string | null  // role circle clicked in the graph: its data + editor open in a side drawer
  config: SessionConfig | null
  providerColors: Record<string, string>
  providerLabels: Record<string, string>
  langfuseUrl: string | null
  turns: Turn[]
  live: Live | null
  voteStreams: Record<string, string>
  handoffs: Handoff[]
  votes: Vote[]
  closing: boolean
  verdict: Verdict | null
  judge: { id: string; model: string } | null
  judgeStream: string
  explanation: Explanation | null
  council: CouncilVerdictData | null
  pendingBuild: { buildId: string; sessionId: string; fde?: string } | null
  pendingLive: string | null
  focus: boolean  // council view: the agents talking are the show; feed and charts shrink
  errors: { agent_id: string; error: string; turn: number | null }[]
  startedAt: number | null
  lastEventTs: number | null
  lastSeq: number
  endedAt: number | null
  stats: Record<string, unknown> | null
  // ui
  user: User | null
  authChecked: boolean
  recMode: boolean
  recording: boolean
  showVideoExport: boolean
  showBriefExport: boolean
  studioOpen: string | null  // an ad the Ad Studio opens when it mounts (made from somewhere else, e.g. an AdTier reel idea)
  decisionNotes: string  // the closing decisions as the user edited them in the verdict (go into the brief)
  layout: Layout
  speed: number
  showVerdict: boolean

  reset: (patch?: Partial<ArenaState>) => void
  apply: (ev: ArenaEvent) => void
  set: (patch: Partial<ArenaState>) => void
}

const empty = {
  sessionId: null,
  status: 'idle' as Status,
  pause: null as PauseInfo | null,
  config: null,
  langfuseUrl: null,
  turns: [],
  live: null,
  voteStreams: {},
  handoffs: [],
  votes: [],
  closing: false,
  verdict: null,
  judge: null,
  judgeStream: '',
  explanation: null,
  council: null as CouncilVerdictData | null,
  pendingBuild: null as { buildId: string; sessionId: string; fde?: string } | null,
  pendingLive: null as string | null,
  focus: false,
  errors: [],
  startedAt: null,
  lastEventTs: null,
  lastSeq: -1,
  endedAt: null,
  stats: null,
  showVerdict: false,
}

export const useArena = create<ArenaState>((set, get) => ({
  view: 'setup',
  source: 'live',
  providerColors: {},
  providerLabels: {},
  user: null,
  authChecked: false,
  recMode: false,
  recording: false,
  showVideoExport: false,
  showTeam: false,
  selectedAgent: null as string | null,
  showBriefExport: false,
  studioOpen: null,
  decisionNotes: '',
  layout: 'wide',
  speed: 1,
  ...empty,

  set: (patch) => set(patch),
  reset: (patch) => set({ ...empty, ...patch }),

  apply: (ev) => {
    const s = get()
    const d = ev as Record<string, any>
    // dedupe: a stream may be attached twice (React StrictMode, reconnects)
    if (typeof ev.seq === 'number') {
      if (ev.seq <= s.lastSeq) return
      set({ lastSeq: ev.seq, lastEventTs: ev.ts })
    }
    switch (ev.type) {
      case 'session.started': {
        const providers = d.providers as Record<string, { label: string; color: string }>
        set({
          sessionId: d.session_id,
          config: d.config,
          focus: d.config?.mode === 'review' ? true : s.focus,
          langfuseUrl: d.langfuse_url ?? null,
          status: 'running',
          startedAt: ev.ts,
          providerColors: { ...s.providerColors, ...Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.color])) },
          providerLabels: { ...s.providerLabels, ...Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.label])) },
        })
        break
      }
      case 'turn.started':
        set({ live: { agentId: d.agent_id, turn: d.turn, raw: '', reasoning: '', callerId: d.caller_id, reason: d.reason, phase: d.phase ?? null } })
        break
      case 'closing.started':
        set({ closing: true })
        break
      case 'token':
        if (d.judge) {
          set({ judgeStream: s.judgeStream + d.delta })
        } else if (d.vote) {
          set({ voteStreams: { ...s.voteStreams, [d.agent_id]: (s.voteStreams[d.agent_id] ?? '') + d.delta } })
        } else if (s.live && s.live.agentId === d.agent_id) {
          set({
            live: d.kind === 'reasoning' ? { ...s.live, reasoning: s.live.reasoning + d.delta } : { ...s.live, raw: s.live.raw + d.delta },
          })
        }
        break
      case 'turn.completed':
        set({ turns: [...s.turns, d as Turn], live: s.live ? { ...s.live, raw: s.live.raw } : null })
        break
      case 'handoff':
        set({ handoffs: [...s.handoffs, { ...(d as Handoff), ts: ev.ts }] })
        break
      case 'session.paused':
        set({ status: 'paused', pause: d as unknown as PauseInfo })
        break
      case 'session.resumed':
        set({ status: 'running', pause: null })
        break
      case 'agent.updated': {
        if (!s.config) break
        const agents = s.config.agents.map((a) => (a.id === d.agent_id ? { ...a, provider: d.provider as string, model: d.model as string, skills: (d.skills as string[] | undefined) ?? a.skills } : a))
        set({ config: { ...s.config, agents }, providerColors: { ...s.providerColors, [d.provider as string]: d.color as string } })
        break
      }
      case 'agent.error':
        set({ errors: [...s.errors, { agent_id: d.agent_id, error: d.error, turn: d.turn }] })
        break
      case 'vote.started':
        set({ status: 'voting', live: null, voteStreams: {} })
        break
      case 'vote':
        set({ votes: [...s.votes, d as Vote] })
        break
      case 'verdict':
        set({ verdict: { winner: d.winner, tally: d.tally, tie: d.tie, tiebreak: d.tiebreak }, showVerdict: true })
        break
      case 'judge.started':
        set({ judge: { id: d.judge_id, model: d.model }, judgeStream: '' })
        break
      case 'verdict.explained':
        set({ explanation: d as Explanation })
        break
      case 'council.verdict':
        set({ council: { session_id: get().sessionId, approved: !!d.approved, headline: d.headline ?? '', why: d.why ?? '', changes: d.changes ?? [], priorities: d.priorities ?? [], level: d.level ?? null, judge_id: d.judge_id, model: d.model }, verdict: { winner: null, tally: {} }, showVerdict: true, live: null })
        break
      case 'session.completed':
        set({ status: (d.status as Status) ?? 'completed', stats: d.stats, endedAt: ev.ts, live: null })
        break
    }
  },
}))

export function agentMap(config: SessionConfig | null): Record<string, AgentConfig> {
  return Object.fromEntries((config?.agents ?? []).map((a) => [a.id, a]))
}

/** Every role gets its own colour (ring, handoff arrows, charts, transcript) by its position in the team, so two
 * roles on the same company never look alike; an explicit per-agent colour still wins. */
export function useAgentColor() {
  const config = useArena((s) => s.config)
  const colors = useArena((s) => s.providerColors)
  return (a?: AgentConfig) => {
    if (!a) return '#8A9299'
    const i = config?.agents.findIndex((x) => x.id === a.id) ?? -1
    if (i >= 0) return PALETTE[i % PALETTE.length]
    return a.color || colors[a.provider] || '#8A9299'
  }
}

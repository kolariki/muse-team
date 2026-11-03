export type Mode = 'handoff' | 'debate' | 'roundtable' | 'audit' | 'review'
export type Stance = 'agree' | 'disagree' | 'propose' | 'neutral'

export interface Provider {
  id: string
  label: string
  color: string
  configured: boolean
  default_model: string
  source?: string  // user | server | trial | none
  trial_left?: number  // free Baseten rounds left (source "trial")
}

export interface AgentConfig {
  id: string
  name: string
  provider: string
  model: string
  persona: string
  role?: string | null
  color?: string | null
  temperature?: number
  wanted_provider?: string
  skills?: string[]
  name_en?: string
  persona_en?: string
}

export interface SessionConfig {
  topic: string
  title?: string | null
  mode: Mode
  agents: AgentConfig[]
  max_turns: number
  min_turns: number
  language: string
  final_vote: boolean
  closing_round?: boolean
  auto_skills?: boolean
  platform?: 'web' | 'mobile' | 'both'  // what gets built: web app, mobile app (iOS + Android) or both
  references?: string[]  // reference apps / URLs the team studies before designing
  references_auto?: boolean  // the references are Muse Team's (the preset's): used, never shown; the user's replace them
  deep_analysis?: boolean  // REA reverse engineering of those apps during the build (on the user's own key / subscription)
  builder?: { provider: string; model: string }  // direct lane: who builds (a local engine or an API provider + model)
  starter?: string | null
  max_tokens: number
  pace_ms: number
  judge?: string | null
  context?: string | null
  review_of?: { build_id: string; session_id: string; title: string; round: number; version?: number; priorities?: string } | null
}

export interface Role {
  id: string
  label: string
  group: string
  persona: string
  mandate: string
  label_en?: string
  group_en?: string
  persona_en?: string
  mandate_en?: string
}

export interface Preset {
  id: string
  title: string
  emoji: string
  custom?: boolean
  scene_url?: string
  topic: string
  mode: Mode
  max_turns: number
  agents: AgentConfig[]
  title_en?: string
  topic_en?: string
  platform?: 'web' | 'mobile' | 'both'
  references?: string[]  // reference apps the team benchmarks first (and reverse-engineers with REA when enabled)
}

export interface Metrics {
  latency_ms: number
  ttft_ms: number | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cost_usd: number
  estimated: boolean
  tokens_per_s: number
}

export interface Turn {
  turn: number
  phase?: 'closing'
  agent_id: string
  responding_to: string | null
  thinking: string
  native_reasoning: string
  message: string
  stance: Stance
  confidence: number | null
  next: string
  reason: string
  metrics: Metrics
}

export interface Handoff {
  turn: number
  from: string
  to: string
  reason: string
  requested: string
  forced_reason: string | null
  ts: number
}

export interface Vote {
  voter: string
  target: string | null
  reason: string
  thinking: string
}

export interface ArenaEvent {
  type: string
  seq: number
  ts: number
  [k: string]: unknown
}

export interface SessionSummary {
  id: string
  status: string
  topic: string
  mode: Mode
  agents: { name: string; provider: string; model: string }[]
  created: number
  live: boolean
  title?: string | null
  cost_usd?: number
  turns?: number
  has_brief?: boolean
  review_of?: { build_id: string; session_id: string; title: string; round: number; version?: number } | null
}

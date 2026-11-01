import type { RunFix } from '../buildStore'
import { getLang, tr } from './i18n'
import type { AgentConfig, ArenaEvent, Preset, Provider, Role, SessionConfig, SessionSummary } from '../types'

const TOKEN_KEY = 'arena.token'
export const getToken = () => token
let token: string | null = null
try {
  token = localStorage.getItem(TOKEN_KEY)
} catch {
  /* storage blocked */
}
let onUnauthorized: () => void = () => {}

export const auth = {
  get token() {
    return token
  },
  set(t: string | null) {
    token = t
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t)
      else {
        localStorage.removeItem(TOKEN_KEY)
        for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('arena.cache.')) localStorage.removeItem(k) }
      }
    } catch {
      /* storage blocked: session lasts until reload */
    }
  },
  onUnauthorized(fn: () => void) {
    onUnauthorized = fn
  },
}

const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } })

async function j<T>(res: Promise<Response>): Promise<T> {
  const r = await res
  if (r.status === 401 && token) {
    auth.set(null)
    onUnauthorized()
  }
  if (!r.ok) {
    let detail = r.statusText
    try {
      detail = (await r.json()).detail ?? detail
    } catch {
      /* not json */
    }
    if (!detail || detail === 'Internal Server Error')  // HTTP/2 has no status text: never an empty error
      detail = r.status >= 500 ? tr('Falló algo de nuestro lado. Ya quedó registrado; probá de nuevo en un rato.', 'Something failed on our side. It was logged; try again in a while.') : `Error ${r.status}`
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  const body = await r.json()
  return (getLang() === 'en' ? useEnglish(body) : body) as T
}

/** Small backend objects carry English twins (hint / hint_en, label / label_en…): with the UI in English the twin wins. */
function useEnglish(v: unknown, depth = 0): unknown {
  if (depth > 4 || !v || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    for (const x of v) useEnglish(x, depth + 1)
    return v
  }
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (k.endsWith('_en')) {
      const base = k.slice(0, -3)
      if (base in o && ((typeof o[k] === 'string' && o[k]) || (Array.isArray(o[k]) && (o[k] as unknown[]).length))) o[base] = o[k]
    } else if (o[k] && typeof o[k] === 'object') useEnglish(o[k], depth + 1)
  }
  return v
}

export interface RoleInsight {
  id: string
  role: string
  role_label: string
  role_label_en: string
  text: string
  evidence: string
  status: 'pending' | 'accepted'
  created: number
  updated: number
}
export interface TeamMemory {
  insights: RoleInsight[]
  memory: RoleInsight[]
}
export interface Employee {
  avatar: import('./avatar').AvatarConfig | null
  id: string
  key: string
  role: string | null
  name: string
  persona: string
  provider: string
  model: string
  skills: string[]
  role_label: string
  role_label_en: string
  docs: number
  knowledge_chars: number
  lessons: number
  projects: number
  last_used: number
}
export interface KnowledgeDoc {
  id: string
  title: string
  kind: 'note' | 'file' | 'url'
  source: string
  chars: number
  preview: string
  created: number
}
export interface RoleScore {
  role: string
  role_label: string
  role_label_en: string
  score: number | null
  provisional: boolean
  asked: number
  kept: number
  acceptance: number | null
  blocking: number
  blocking_precision: number | null
  rounds_reviewed: number
  approvals: number
  open_builds: number
  convergence: number | null
  avg_rounds_to_approval: number | null
  trend: 'up' | 'down' | 'flat' | null
  lessons: number
}

export interface User {
  id: string
  email: string
  name: string
}

const post = (url: string, body: unknown) => authed(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  authConfig: () => j<{ allow_signup: boolean }>(fetch('/api/auth/config')),
  register: (email: string, password: string, name?: string) => j<{ token?: string; user: User; pending?: boolean; email?: string; dev_code?: string }>(post('/api/auth/register', { email, password, name })),
  verifyEmail: (email: string, code: string) => j<{ token: string; user: User }>(post('/api/auth/verify', { email, code })),
  resendCode: (email: string) => j<{ ok: boolean; dev_code?: string }>(post('/api/auth/resend', { email })),
  login: (email: string, password: string) => j<{ token: string; user: User }>(post('/api/auth/login', { email, password })),
  logout: () => j(post('/api/auth/logout', {})),
  me: () => j<{ user: User }>(authed('/api/auth/me')),
  health: () => j<{ ok: boolean; langfuse: boolean; langfuse_host: string | null; stripe?: StripeStatus }>(fetch('/api/health')),
  providers: () => j<Provider[]>(authed('/api/providers')),
  models: (p: string) => j<{ models: string[]; error?: string }>(authed(`/api/providers/${p}/models`)),
  roles: () => j<{ groups: string[]; roles: Role[] }>(authed('/api/roles')),
  teamMemory: () => j<TeamMemory>(authed('/api/team/memory')),
  employees: () => j<{ employees: Employee[] }>(authed('/api/team/employees')),
  createEmployee: (body: { role?: string | null; name?: string; persona?: string; provider?: string; model?: string }) => j<{ employees: Employee[] }>(post('/api/team/employees', body)),
  updateEmployee: (id: string, body: Partial<Pick<Employee, 'name' | 'persona' | 'provider' | 'model' | 'skills' | 'avatar'>>) => j<{ employees: Employee[] }>(authed(`/api/team/employees/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  deleteEmployee: (id: string) => j<{ employees: Employee[] }>(authed(`/api/team/employees/${id}`, { method: 'DELETE' })),
  generateFace: (id: string, traits: Record<string, string>) => j<{ src: string }>(post(`/api/team/employees/${id}/generate-face`, traits)),
  faceFromPhoto: (id: string, file: File, extra: string) => { const form = new FormData(); form.append('file', file, file.name); form.append('extra', extra); return j<{ src: string }>(authed(`/api/team/employees/${id}/face-from-photo`, { method: 'POST', body: form })) },
  suggestRolePrompt: (id: string, hint: string, lang: string) => j<{ prompt: string; model: string }>(post(`/api/team/employees/${id}/suggest-prompt`, { hint, lang })),
  employeeDocs: (id: string) => j<{ docs: KnowledgeDoc[] }>(authed(`/api/team/employees/${id}/docs`)),
  addEmployeeNote: (id: string, title: string, text: string) => j<{ docs: KnowledgeDoc[] }>(post(`/api/team/employees/${id}/docs`, { title, text })),
  addEmployeeUrl: (id: string, url: string) => j<{ docs: KnowledgeDoc[] }>(post(`/api/team/employees/${id}/docs`, { url })),
  addEmployeeFile: (id: string, file: File) => { const form = new FormData(); form.append('file', file, file.name); return j<{ docs: KnowledgeDoc[] }>(authed(`/api/team/employees/${id}/docs/file`, { method: 'POST', body: form })) },
  deleteEmployeeDoc: (id: string, did: string) => j<{ docs: KnowledgeDoc[] }>(authed(`/api/team/employees/${id}/docs/${did}`, { method: 'DELETE' })),
  buildLevelPending: (sessionId: string, buildId: string, scope?: { focus?: 'analytics' | 'identify'; ids?: string[] }) => j<{ ok: boolean; items: number }>(post(`/api/sessions/${sessionId}/builds/${buildId}/levels/build-pending`, scope ?? {})),
  accountExport: async () => {
    const r = await authed('/api/account/export', { method: 'POST' })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`)
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'tably.tably'
    return { blob: await r.blob(), code: r.headers.get('x-tably-code') ?? '', name, summary: JSON.parse(r.headers.get('x-tably-summary') ?? '{}') as { session_files: number; project_files: number; rows: Record<string, number> } }
  },
  accountImport: (file: File, code: string) => { const form = new FormData(); form.append('file', file, file.name); form.append('code', code); return j<{ ok: boolean; files: number; skipped_files: number; rows: Record<string, number> }>(authed('/api/account/import', { method: 'POST', body: form })) },
  analyticsErrors: (slug: string, days: number) => j<{ issues: ErrorIssue[]; build_id: string }>(authed(`/api/analytics/${slug}/errors?days=${days}`)),
  analyticsAi: (slug: string, days: number) => j<AiSummary>(authed(`/api/analytics/${slug}/ai?days=${days}`)),
  analyticsExperiments: (slug: string, days: number, goals: Record<string, string>) => j<Experiments>(authed(`/api/analytics/${slug}/experiments?days=${days}&goals=${encodeURIComponent(JSON.stringify(goals))}`)),
  analyticsAsk: (slug: string, kind: 'ab' | 'ai', text = '') => j<{ ok: boolean; build_id: string; session_id: string }>(post(`/api/analytics/${slug}/ask`, { kind, text })),
  analyticsDetail: (slug: string, days: number) => j<AnalyticsDetail>(authed(`/api/analytics/${slug}?days=${days}`)),
  analytics: () => j<{ apps: AnalyticsApp[]; collector: string; collector_public: boolean }>(authed('/api/analytics')),
  siteCreate: (body: { title: string; url: string; repo: string; pr?: boolean }) => j<{ slug: string; pr?: { ok: boolean; url?: string; files?: string[]; error?: string } }>(post('/api/analytics/sites', body)),
  githubRepos: () => j<{ connected: boolean; error?: string | null; login?: string | null; repos: GithubRepo[] }>(authed('/api/analytics/github/repos')),
  githubLive: (repo: string) => j<{ url: string | null }>(authed(`/api/analytics/github/live?repo=${encodeURIComponent(repo)}`)),
  siteUpdate: (slug: string, body: { title?: string; url?: string; repo?: string }) => j<{ slug: string }>(authed(`/api/analytics/sites/${slug}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  siteDelete: (slug: string) => j<{ ok: boolean }>(authed(`/api/analytics/sites/${slug}`, { method: 'DELETE' })),
  sitePr: (slug: string) => j<{ ok: boolean; url: string; files: string[] }>(post(`/api/analytics/sites/${slug}/pr`, {})),
  siteCheck: (slug: string) => j<{ hits: number; online: boolean | null; connected: boolean }>(post(`/api/analytics/sites/${slug}/check`, {})),
  teamScores: () => j<{ roles: RoleScore[] }>(authed('/api/team/scores')),
  teamMemoryDecide: (id: string, action: 'accept' | 'dismiss' | 'edit' | 'forget', text?: string) => j<TeamMemory>(post(`/api/team/memory/${id}`, { action, text })),
  fdePackages: () => j<{ packages: FdePackage[]; booking_url: string | null; stripe: StripeStatus }>(authed('/api/fde/packages')),
  checkout: (body: { kind: 'fde' | 'fees'; ref?: string; build_id?: string; session_id?: string; hours?: number }) => j<Order & { url: string }>(post('/api/billing/checkout', body)),
  confirmCheckout: (checkout: string) => j<Order>(post('/api/billing/confirm', { checkout })),
  orders: (buildId?: string | null) => j<Order[]>(authed(`/api/billing/orders${buildId ? `?build_id=${encodeURIComponent(buildId)}` : ''}`)),
  fdeRequests: (sessionId?: string | null) => j<FdeRequest[]>(authed(`/api/fde/requests${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`)),
  fdeCreate: (body: { session_id: string; build_id: string; package: string; notes: string; contact: string }) => j<FdeRequest>(post('/api/fde/requests', body)),
  fdeUpdate: (id: string, body: { status?: string; notes?: string }) => j<FdeRequest>(authed(`/api/fde/requests/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  fdeTicket: async (id: string) => {
    const r = await authed(`/api/fde/requests/${id}/ticket.md`)
    if (!r.ok) throw new Error(await r.text())
    return r.text()
  },
  skills: () => j<{ skills: SkillSummary[]; templates: SkillSummary[] }>(authed('/api/skills')),
  skill: (id: string) => j<SkillSummary & { body: string }>(authed(`/api/skills/${id}`)),
  catalog: (q = '', category = '', limit = 80) => j<{ skills: CatalogSkill[]; categories: CatalogCategory[]; total: number; sync: CatalogSync }>(authed(`/api/skills/catalog?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&limit=${limit}`)),
  catalogSync: () => j<CatalogSync & { started: boolean }>(authed('/api/skills/catalog/sync', { method: 'POST' })),
  catalogSyncStatus: () => j<CatalogSync>(authed('/api/skills/catalog/sync')),
  catalogTranslate: (provider: string, model: string) => j<{ running: boolean; done: number; total: number; error: string | null; translated: number; total_skills: number }>(post('/api/skills/catalog/translate', { provider, model })),
  catalogTranslateStatus: () => j<{ running: boolean; done: number; total: number; error: string | null; translated: number; total_skills: number }>(authed('/api/skills/catalog/translate')),
  suggestSkills: (text: string, roles: { id: string; label: string; group?: string; mandate?: string }[], k = 4) => j<{ general: CatalogSkill[]; per_role: Record<string, CatalogSkill[]> }>(post('/api/skills/suggest', { text, roles, k })),
  saveSkill: (sk: { id?: string; name: string; body: string; description?: string; tags?: string }) => j<SkillSummary & { body: string }>(post('/api/skills', sk)),
  documentText: (file: File) => { const form = new FormData(); form.append('file', file, file.name); return j<{ text: string; chars: number; truncated: boolean; filename: string }>(authed('/api/documents/text', { method: 'POST', body: form })) },
  uploadSkill: (file: File, name = '') => { const form = new FormData(); form.append('file', file, file.name); form.append('name', name); return j<SkillSummary & { body: string; truncated: boolean; chars_total: number }>(authed('/api/skills/upload', { method: 'POST', body: form })) },
  deleteSkill: (id: string) => j(authed(`/api/skills/${id}`, { method: 'DELETE' })),
  setAgentSkills: (sessionId: string, agentId: string, skills: string[]) => j(authed(`/api/sessions/${sessionId}/agents/${agentId}/skills`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skills }) })),
  setTeam: (buildId: string, sessionId: string | null, team: Partial<import('../buildStore').TeamMember>[]) => j<{ ok: boolean; team: import('../buildStore').TeamMember[] }>(authed(`/api/builds/${buildId}/team`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team, session_id: sessionId }) })),
  setTeamSkills: (buildId: string, sessionId: string | null, agentId: string, skills: string[]) => j(authed(`/api/builds/${buildId}/team/${agentId}/skills`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skills, session_id: sessionId }) })),
  presets: () => j<Preset[]>(authed('/api/presets?fallback=true')),
  savePreset: (cfg: SessionConfig, title: string) => j<Preset>(post('/api/presets', { ...cfg, title })),
  deletePreset: (id: string) => j(authed(`/api/presets/${id}`, { method: 'DELETE' })),
  sessions: () => j<SessionSummary[]>(authed('/api/sessions')),
  updateTeam: (sessionId: string, agents: AgentConfig[]) => j<{ agents: AgentConfig[] }>(authed(`/api/sessions/${sessionId}/team`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents }) })),
  session: (id: string) => j<{ id: string; status: string; config?: SessionConfig; events: ArenaEvent[] }>(authed(`/api/sessions/${id}`)),
  start: (cfg: SessionConfig) => j<{ id: string }>(post('/api/sessions', cfg)),
  directBuild: (body: Record<string, unknown>) => j<{ session_id: string; id: string; brief_by: string }>(post('/api/direct-builds', body)),
  stop: (id: string) => j(post(`/api/sessions/${id}/stop`, {})),
  councilRedo: (id: string) => j<Record<string, unknown>>(post(`/api/sessions/${id}/council/redo`, {})),
  resumeSession: (id: string, action = 'retry') => j(post(`/api/sessions/${id}/resume`, { action })),
  updateAgent: (id: string, agentId: string, provider: string, model: string) =>
    j(authed(`/api/sessions/${id}/agents/${agentId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, model }) })),
  estimate: (cfg: SessionConfig) => j<{ total_usd: number; per_agent: Record<string, number>; note: string }>(post('/api/sessions/estimate', cfg)),
  dashboard: () => j<DashboardData>(authed('/api/dashboard')),
  deleteSession: (id: string) => j(authed(`/api/sessions/${id}`, { method: 'DELETE' })),
  renameSession: (id: string, title: string) => j(authed(`/api/sessions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })),
  engines: () => j<EngineStatus[]>(authed('/api/engines')),
  buildDesignApprove: (id: string, session_id?: string | null) => j<{ ok: boolean }>(post(`/api/builds/${id}/design/approve`, { session_id })),
  designSummary: (sessionId: string, id: string, lang: string, refresh = false) => j<{ text: string | null; reason?: string; model?: string; ts?: number }>(authed(`/api/sessions/${sessionId}/builds/${id}/design/summary?lang=${lang}${refresh ? '&refresh=true' : ''}`)),
  designRequest: (id: string, text: string, session_id?: string | null) => j<{ ok: boolean; mode: 'redo' | 'queued' | 'resumed' }>(post(`/api/builds/${id}/design/request`, { text, session_id })),
  buildDesignRedo: (id: string, feedback: string, session_id?: string | null) => j<{ ok: boolean }>(post(`/api/builds/${id}/design/redo`, { feedback, session_id })),
  startBuild: (session_id: string, provider: string, model: string, target: string, review_rounds = 0, priorities = '', design = true, opts: { research?: boolean; references?: string[]; deep_analysis?: boolean } = {}) =>
    j<{ id: string }>(post('/api/builds', { session_id, provider, model, target, review_rounds, priorities, design, research: opts.research ?? false, references: opts.references ?? [], deep_analysis: opts.deep_analysis ?? false })),
  sceneStatus: (sessionId: string) => j<{ ready: boolean; pending: boolean; failed_recently: boolean }>(authed(`/api/sessions/${sessionId}/scene/status`)),
  sceneRegenerate: (sessionId: string) => j<{ ready: boolean; pending: boolean }>(authed(`/api/sessions/${sessionId}/scene/regenerate`, { method: 'POST' })),
  researchJobStart: (references: string[], brief: string, deep_analysis: boolean) => j<ResearchJob>(post('/api/research/jobs', { references, brief, deep_analysis })),
  researchJob: (id: string) => j<ResearchJob>(authed(`/api/research/jobs/${id}`)),
  researchStatus: () => j<{ chrome: string | null; rea: { ok: boolean; cli: string | null; registered: boolean; fee_usd: number }; deep_fee_usd: number; max_references: number }>(authed('/api/research/status')),
  buildCouncil: (id: string, session_id: string | null, max_rounds: number, priorities = '', references: string[] = [], deep_analysis = false, focus: 'production' | 'design' = 'production') => j<{ session_id: string | null; researching?: number }>(post(`/api/builds/${id}/council`, { session_id, max_rounds, priorities, references, deep_analysis, focus })),
  councilApply: (id: string, session_id: string | null, changes: { severity: string; role: string; text: string }[], max_rounds: number, council_session: string | null, priorities = '', references: string[] = [], deep_analysis = false, builder?: { provider: string; model: string }) =>
    j<{ ok: boolean; researching?: number }>(post(`/api/builds/${id}/council/apply`, { session_id, changes, max_rounds, council_session, priorities, references, deep_analysis, ...(builder ?? {}) })),
  buildReview: (id: string, session_id: string | null, max_rounds: number) => j(post(`/api/builds/${id}/review`, { session_id, max_rounds })),
  builds: (sessionId: string) => j<BuildSummary[]>(authed(`/api/sessions/${sessionId}/builds`)),
  build: (sessionId: string, id: string) => j<Record<string, any> & { file_contents?: Record<string, string> }>(authed(`/api/sessions/${sessionId}/builds/${id}`)),
  buildMessage: (id: string, text: string, session_id?: string | null) => j(post(`/api/builds/${id}/message`, { text, session_id })),
  buildStop: (id: string) => j(post(`/api/builds/${id}/stop`, {})),
  buildResume: (id: string, session_id: string | null) => j(post(`/api/builds/${id}/resume`, { session_id })),
  createAudit: (form: FormData) => j<{ id: string; session_id: string; files: number ; council?: string | null}>(authed('/api/audits', { method: 'POST', body: form })),
  buildApply: (id: string, session_id: string | null, requests: { role_label: string; name: string; text: string }[], max_rounds: number) =>
    j(post(`/api/builds/${id}/apply`, { session_id, requests, max_rounds })),
  services: (sessionId: string, id: string) => j<ServicesInfo>(authed(`/api/sessions/${sessionId}/builds/${id}/services`)),
  setBuildLanguage: (sessionId: string, id: string, language: string) =>
    j<{ language: string; code: 'es' | 'en' }>(authed(`/api/sessions/${sessionId}/builds/${id}/language`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language }) })),
  saveFile: (sessionId: string, id: string, path: string, content: string) =>
    j<{ ok: boolean; path: string; lines: number; size: number }>(authed(`/api/sessions/${sessionId}/builds/${id}/files`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) })),
  serviceGuide: (sessionId: string, id: string, service: string, lang: string, refresh = false) =>
    j<ServiceGuideData>(authed(`/api/sessions/${sessionId}/builds/${id}/services/guide?service=${encodeURIComponent(service)}&lang=${lang}${refresh ? '&refresh=true' : ''}`)),
  saveServices: (sessionId: string, id: string, values: Record<string, string>) =>
    j<{ ok: boolean; configured: string[] }>(authed(`/api/sessions/${sessionId}/builds/${id}/services`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) })),
  envFile: async (sessionId: string, id: string) => {
    const r = await authed(`/api/sessions/${sessionId}/builds/${id}/env`)
    if (!r.ok) throw new Error(r.statusText)
    return r.text()
  },
  versions: (sessionId: string, id: string) => j<{ versions: import('../buildStore').BuildVersion[]; current: number; status: string }>(authed(`/api/sessions/${sessionId}/builds/${id}/versions`)),
  versionDiff: async (sessionId: string, id: string, n: number, path: string) => {
    const r = await authed(`/api/sessions/${sessionId}/builds/${id}/versions/${n}/diff?path=${encodeURIComponent(path)}`)
    if (!r.ok) throw new Error(await r.text())
    return r.text()
  },
  appRun: (sessionId: string, id: string) => j<{ services: RunService[]; run: AppRunState | null }>(authed(`/api/sessions/${sessionId}/builds/${id}/run`)),
  appStart: (sessionId: string, id: string, service: string) => j(post(`/api/sessions/${sessionId}/builds/${id}/run`, { service })),
  appStop: (sessionId: string, id: string) => j(authed(`/api/sessions/${sessionId}/builds/${id}/run`, { method: 'DELETE' })),
  agentSessions: (engine: 'muse' | 'claude' | 'codex') => j<AgentSessionList>(authed(`/api/agents/sessions?engine=${engine}`)),
  agentChat: (engine: 'muse' | 'claude' | 'codex', id: string, text: string) => post(`/api/agents/sessions/${engine}/${id}/message`, { text }),
  agentSession: (engine: 'muse' | 'claude' | 'codex', id: string) => j<AgentSessionDetail>(authed(`/api/agents/sessions/${engine}/${id}`)),
  saveClaudeToken: (token: string | null, clear = false) => j<{ status: { set: boolean; last4: string | null }; engines: EngineStatus[] }>(authed('/api/settings/claude-token', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, clear }) })),
  devices: () => j<{ ios: { ok: boolean; hint: string | null; booted: string | null }; android: { ok: boolean; hint: string | null; booted: string | null } }>(authed('/api/devices')),
  runScreenUrl: (sessionId: string, id: string, target: 'ios' | 'android') => `/api/sessions/${sessionId}/builds/${id}/run/screen?target=${target}&token=${encodeURIComponent(getToken() ?? '')}&t=`,
  runTap: (sessionId: string, id: string, target: 'ios' | 'android', x: number, y: number) => j<{ ok: boolean }>(post(`/api/sessions/${sessionId}/builds/${id}/run/tap`, { target, x, y })),
  deploy: (sessionId: string, id: string, target: string) => j(post(`/api/sessions/${sessionId}/builds/${id}/deploy`, { target })),
  cloudStatus: () => j<CloudStatus & { github: { set: boolean; last4: string | null; error?: string | null }; apps: CloudApp[] }>(authed('/api/cloud/status')),
  saveGithubToken: (token: string | null, clear = false) =>
    j<{ set: boolean; last4: string | null }>(authed('/api/settings/github', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, clear }) })),
  cloud: (sessionId: string, id: string) => j<CloudInfo>(authed(`/api/sessions/${sessionId}/builds/${id}/cloud`)),
  notionStatus: () => j<{ set: boolean; last4: string | null; me: { name: string; workspace: string | null } | null; error: string | null; oauth?: boolean }>(authed('/api/notion/status')),
  deployFailures: (days = 90) => j<DeployFailures>(authed(`/api/admin/deploy-failures?days=${days}`)),
  myPhoto: () => j<{ image: string | null }>(authed('/api/me/photo')),
  setMyPhoto: (image: string) => j<{ image: string | null }>(authed('/api/me/photo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) })),
  deleteMyPhoto: () => j<{ image: string | null }>(authed('/api/me/photo', { method: 'DELETE' })),
  connections: () => j<{ connections: Connection[]; google_ready: boolean; redirect_uri: string }>(authed('/api/connections')),
  connectionStart: (provider: string) => j<{ url: string }>(post(`/api/connections/${provider}/start`, {})),
  connectionDelete: (provider: string) => j<{ ok: boolean; connections: Connection[] }>(authed(`/api/connections/${provider}`, { method: 'DELETE' })),
  googleApp: () => j<{ admin: boolean; client_id: string | null; has_secret: boolean; configured: boolean; redirect_uri: string; origin: string; from_env: boolean }>(authed('/api/settings/google-app')),
  saveGoogleApp: (body: { client_id?: string; client_secret?: string; clear?: boolean }) =>
    j<{ admin: boolean; client_id: string | null; has_secret: boolean; configured: boolean; redirect_uri: string; origin: string; from_env: boolean }>(authed('/api/settings/google-app', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })),
  notionApp: () => j<{ admin: boolean; client_id: string | null; has_secret: boolean; configured: boolean; redirect_uri: string; from_env: boolean }>(authed('/api/settings/notion-app')),
  saveNotionApp: (body: { client_id?: string; client_secret?: string; clear?: boolean }) =>
    j<{ admin: boolean; client_id: string | null; has_secret: boolean; configured: boolean; redirect_uri: string; from_env: boolean }>(authed('/api/settings/notion-app', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  notionOauthUrl: () => j<{ url: string | null }>(authed('/api/notion/oauth/url')),
  saveNotionToken: (token: string | null, clear = false) =>
    j<{ set: boolean; last4: string | null; me: { name: string; workspace: string | null } | null; error: string | null }>(authed('/api/settings/notion', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, clear }) })),
  notionDatabases: () => j<{ databases: { id: string; title: string; url: string | null }[] }>(authed('/api/notion/databases')),
  ticketsConfig: () => j<TicketsConfig>(authed('/api/tickets/config')),
  saveTicketsConfig: (body: Record<string, unknown>) => j<TicketsConfig>(authed('/api/tickets/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  tickets: (all = false) => j<{ link: TicketsConfig['link']; tickets: Ticket[]; runs: Record<string, TicketRun>; groupable: GroupableProp[]; classify?: ClassifyJob | null }>(authed(`/api/tickets${all ? '?all=true' : ''}`)),
  ticketsClassify: (pageIds?: string[]) => j<ClassifyJob>(post('/api/tickets/classify', pageIds ? { page_ids: pageIds } : {})),
  ticketsClassifyStatus: () => j<ClassifyJob>(authed('/api/tickets/classify')),
  ticketSetProject: (pageId: string, body: { session_id: string | null; build_id: string | null }) => j<{ ok: boolean }>(authed(`/api/tickets/${pageId}/project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  ticket: (pageId: string) => j<{ id: string; title: string; url: string | null; fields: Record<string, string>; markdown: string }>(authed(`/api/tickets/${pageId}`)),
  ticketResolve: (pageId: string) => j<{ ok: boolean; build_id: string; session_id: string; branch: string; repo_url: string | null }>(post(`/api/tickets/${pageId}/resolve`, {})),
  ads: (sessionId: string, id: string) => j<AdsPayload>(authed(`/api/sessions/${sessionId}/builds/${id}/ads`)),
  adsNew: (sessionId: string, id: string, instructions: string, template?: string | null, look?: Record<string, unknown>) => j<AdsPayload>(post(`/api/sessions/${sessionId}/builds/${id}/ads`, { instructions, template, look })),
  adsAnalyze: (sessionId: string, id: string) => j<AdsPayload>(post(`/api/sessions/${sessionId}/builds/${id}/ads/analyze`, {})),
  adsSummary: (sessionId: string, id: string, summary: Partial<AppSummary>) =>
    j<AdsPayload>(authed(`/api/sessions/${sessionId}/builds/${id}/ads/summary`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary) })),
  adsEdit: (sessionId: string, id: string, adId: string, changes: Partial<AdScript>) =>
    j<AdsPayload>(authed(`/api/sessions/${sessionId}/builds/${id}/ads/${adId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes) })),
  adsRetry: (sessionId: string, id: string, adId: string) => j<AdsPayload>(post(`/api/sessions/${sessionId}/builds/${id}/ads/${adId}/retry`, {})),
  adsDelete: (sessionId: string, id: string, adId: string) => j<AdsPayload>(authed(`/api/sessions/${sessionId}/builds/${id}/ads/${adId}`, { method: 'DELETE' })),
  adFileUrl: (sessionId: string, id: string, adId: string, name: string, v: number | string = '', download = false) =>
    `/api/sessions/${sessionId}/builds/${id}/ads/${adId}/${name}?token=${encodeURIComponent(getToken() ?? '')}&v=${v}${download ? '&download=1' : ''}`,
  adsToMeta: (sessionId: string, id: string, adId: string, body: MetaPublish) => j<AdsPayload>(post(`/api/sessions/${sessionId}/builds/${id}/ads/${adId}/meta`, body)),
  metaAdsStart: (forWhat?: 'instagram') => j<{ url: string }>(post('/api/meta-ads/start', forWhat ? { for: forWhat } : {})),
  metaAdsAssets: () => j<{ accounts: { id: string; name: string; currency: string; active: boolean }[]; pages: { id: string; name: string }[] }>(authed('/api/meta-ads/assets')),
  metaAdsDisconnect: () => j<{ ok: boolean }>(authed('/api/meta-ads', { method: 'DELETE' })),
  studioList: () => j<StudioList>(authed('/api/studio')),
  studioCreate: (body: { title: string; instructions: string; link: string; goal: string; lang: string }) => j<StudioProject>(post('/api/studio', body)),
  studio: (id: string) => j<StudioProject>(authed(`/api/studio/${id}`)),
  studioPatch: (id: string, body: Partial<Pick<StudioProject, 'title' | 'instructions' | 'link' | 'goal'>>) =>
    j<StudioProject>(authed(`/api/studio/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  studioDelete: (id: string) => j<{ ok: boolean }>(authed(`/api/studio/${id}`, { method: 'DELETE' })),
  studioDeleteMedia: (id: string, mid: string) => j<StudioProject>(authed(`/api/studio/${id}/media/${mid}`, { method: 'DELETE' })),
  studioRun: (id: string) => j<StudioProject>(post(`/api/studio/${id}/run`, {})),
  twin: () => j<TwinState>(authed('/api/twin')),
  twinKeys: (body: { heygen?: string; pexels?: string; pixabay?: string }) => j<TwinState>(authed('/api/twin/keys', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  twinFootage: (file: File, onProgress: (p: number) => void) => new Promise<TwinState>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', '/api/twin/footage')
    x.setRequestHeader('Authorization', `Bearer ${getToken() ?? ''}`)
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    x.onload = () => { let d: { detail?: string } = {}; try { d = JSON.parse(x.responseText) } catch { /* not JSON */ } if (x.status < 300) resolve(d as TwinState); else reject(new Error(d.detail ?? `HTTP ${x.status}`)) }
    x.onerror = () => reject(new Error('No se pudo subir el video'))
    const form = new FormData()
    form.append('file', file, file.name)
    x.send(form)
  }),
  twinConsent: () => j<TwinState>(post('/api/twin/consent', {})),
  twinForget: () => j<TwinState>(authed('/api/twin', { method: 'DELETE' })),
  studioGenPlan: (id: string) => j<StudioGen>(post(`/api/studio/${id}/generate/plan`, {})),
  studioGenerate: (id: string, body: { voice: string; broll: { query: string; shows: string }[]; app_url?: string }) => j<StudioProject>(post(`/api/studio/${id}/generate`, body)),
  studioTour: (id: string, url: string) => j<StudioProject>(post(`/api/studio/${id}/tour`, { url })),
  studioStop: (id: string) => j<StudioProject>(post(`/api/studio/${id}/stop`, {})),
  studioFileUrl: (id: string, name: string, v: number | string = '', download = false) => `/api/studio/${id}/file/${name}?token=${encodeURIComponent(getToken() ?? '')}&v=${v}${download ? '&download=1' : ''}`,
  /** One upload with progress (XHR: fetch has no upload progress). */
  studioUpload: (id: string, file: File, onProgress: (p: number) => void) => new Promise<StudioProject>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/studio/${id}/media`)
    x.setRequestHeader('Authorization', `Bearer ${getToken() ?? ''}`)
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    x.onload = () => { let d: { detail?: string } = {}; try { d = JSON.parse(x.responseText) } catch { /* not JSON */ } if (x.status < 300) resolve(d as StudioProject); else reject(new Error(d.detail ?? `HTTP ${x.status}`)) }
    x.onerror = () => reject(new Error('No se pudo subir el archivo'))
    const form = new FormData()
    form.append('file', file, file.name)
    x.send(form)
  }),
  adtier: (qs = '') => j<AdTierHome>(authed(`/api/adtier${qs}`)),
  adtierVideos: (qs: string) => j<AdTierPage>(authed(`/api/adtier/videos${qs}`)),
  adtierVideo: (id: string) => j<AdTierDetail>(authed(`/api/adtier/videos/${id}`)),
  adtierBrands: () => j<{ brands: { brand: string; videos: number }[] }>(authed('/api/adtier/brands')),
  adtierMasters: () => j<AdTierMasters>(authed('/api/adtier/masters')),
  adtierMakeMaster: (format: string, tier: string) => j<AdTierMasters>(post('/api/adtier/admin/masters', { format, tier })),
  adtierAdd: (url: string, evidence: AdTierEvidence[], meta: Record<string, string>) => j<AdTierDetail>(post('/api/adtier/admin/videos', { url, evidence, meta })),
  adtierBatch: (csv: string) => j<{ added: string[]; errors: string[] }>(post('/api/adtier/admin/batch', { csv })),
  adtierQueue: () => j<{ drafts: AdTierCard[]; review: AdTierCard[]; unreviewed: AdTierCard[]; running: string[]; agreement: AdTierAgreement; columns: string[] }>(authed('/api/adtier/admin/queue')),
  adtierEdit: (id: string, body: Record<string, unknown>) => j<AdTierDetail>(authed(`/api/adtier/admin/videos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  adtierReingest: (id: string) => j<AdTierDetail>(post(`/api/adtier/admin/videos/${id}/ingest`, {})),
  adtierReview: (id: string, body: { tier: string; template?: Record<string, unknown> | null; publish: boolean; note?: string }) => j<AdTierDetail>(post(`/api/adtier/admin/videos/${id}/review`, body)),
  adtierDelete: (id: string) => j<{ ok: boolean }>(authed(`/api/adtier/admin/videos/${id}`, { method: 'DELETE' })),
  adtierRetry: () => j<{ retrying: number }>(post('/api/adtier/admin/retry', {})),
  adtierSeed: () => j<{ added: string[]; errors: string[] }>(post('/api/adtier/admin/seed', {})),
  adtierAutopublish: (on: boolean) => j<{ autopublish: boolean }>(authed('/api/adtier/admin/autopublish', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) })),
  foryou: () => j<ForYouHome>(authed('/api/adtier/foryou')),
  foryouCreate: (body: Record<string, string | string[]>) => j<ForYouMatches>(post('/api/adtier/foryou', body)),
  foryouGet: (id: string) => j<ForYouMatches>(authed(`/api/adtier/foryou/${id}`)),
  foryouEdit: (id: string, body: Record<string, unknown>) => j<ForYouMatches>(authed(`/api/adtier/foryou/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  foryouSearch: (id: string) => j<ForYouMatches>(post(`/api/adtier/foryou/${id}/search`, {})),
  foryouIdeas: (id: string, accounts?: string[]) => j<ForYouMatches>(post(`/api/adtier/foryou/${id}/ideas`, accounts ? { accounts } : {})),
  metaApp: () => j<MetaApp>(authed('/api/settings/meta-app')),
  metaAppSet: (body: { app_id?: string; app_secret?: string }) => j<MetaApp>(authed('/api/settings/meta-app', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  foryouUpload: (id: string, file: File, onProgress: (p: number) => void, source: 'upload' | 'recording' = 'upload') => new Promise<ForYouMatches>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', `/api/adtier/foryou/${id}/uploads`)
    x.setRequestHeader('Authorization', `Bearer ${getToken() ?? ''}`)
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    x.onload = () => { let d: { detail?: string } = {}; try { d = JSON.parse(x.responseText) } catch { /* not JSON */ } if (x.status < 300) resolve(d as ForYouMatches); else reject(new Error(d.detail ?? `HTTP ${x.status}`)) }
    x.onerror = () => reject(new Error('No se pudo subir el archivo'))
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('source', source)
    x.send(form)
  }),
  foryouUploadDelete: (id: string, rid: string) => j<ForYouMatches>(authed(`/api/adtier/foryou/${id}/uploads/${rid}`, { method: 'DELETE' })),
  foryouUploadUrl: (id: string, rid: string, name: string) => `/api/adtier/foryou/${id}/uploads/${rid}/${name}?token=${encodeURIComponent(getToken() ?? '')}`,
  foryouDelete: (id: string) => j<{ ok: boolean }>(authed(`/api/adtier/foryou/${id}`, { method: 'DELETE' })),
  foryouDoc: (file: File) => { const form = new FormData(); form.append('file', file, file.name); return j<{ name: string; text: string }>(authed('/api/adtier/foryou/doc', { method: 'POST', body: form })) },
  adtierCheckEmbeds: () => j<{ checked: number; unpublished: string[] }>(post('/api/adtier/admin/check-embeds', {})),
  levels: (sessionId: string, id: string) => j<LevelsPayload>(authed(`/api/sessions/${sessionId}/builds/${id}/levels`)),
  marketList: (sessionId: string, id: string, body: { pitch: string; price_usd: number | null; title?: string }) =>
    j<{ ok: boolean; listing: MarketListing }>(authed(`/api/sessions/${sessionId}/builds/${id}/market`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
  marketWithdraw: (sessionId: string, id: string) => j<{ ok: boolean }>(authed(`/api/sessions/${sessionId}/builds/${id}/market`, { method: 'DELETE' })),
  market: () => j<{ listings: MarketListing[]; levels: LevelDef[] }>(authed('/api/market')),
  marketTransfer: (listingId: string, email: string) => j<{ ok: boolean; to: { name: string; email: string } }>(post(`/api/market/${listingId}/transfer`, { email })),
  cloudPublish: (sessionId: string, id: string) => j(post(`/api/sessions/${sessionId}/builds/${id}/cloud/publish`, {})),
  appErrors: (sessionId: string, id: string) => j<AppErrors>(authed(`/api/sessions/${sessionId}/builds/${id}/app-errors`)),
  runReport: (sessionId: string, id: string, body: { page: string; text: string; alerts: string[]; log: unknown[]; screenshot: string; note?: string }) =>
    j<{ ok: boolean; queued: boolean }>(post(`/api/sessions/${sessionId}/builds/${id}/app-run/report`, body)),
  appErrorAction: (sessionId: string, id: string, eid: string, action: 'approve' | 'fix' | 'dismiss') => j<AppErrors>(post(`/api/sessions/${sessionId}/builds/${id}/app-errors/${eid}/${action}`, {})),
  cloudUnpublish: (sessionId: string, id: string) => j<{ ok: boolean; app: CloudApp | null }>(authed(`/api/sessions/${sessionId}/builds/${id}/cloud/publish`, { method: 'DELETE' })),
  cloudDb: (sessionId: string, id: string, provider: 'neon' | 'supabase') => j<{ ok: boolean; provider: string; host: string; vars: string[] }>(post(`/api/sessions/${sessionId}/builds/${id}/cloud/db`, { provider })),
  gitSync: (sessionId: string, id: string) => j<{ ok: boolean; head: string; committed: boolean; git: GitInfo }>(post(`/api/sessions/${sessionId}/builds/${id}/cloud/git/sync`, {})),
  gitGithub: (sessionId: string, id: string, name: string, priv: boolean) => j<{ ok: boolean; url: string }>(post(`/api/sessions/${sessionId}/builds/${id}/cloud/git/github`, { name, private: priv })),
  deploySettings: () => j<{ vercel: { set: boolean; last4: string | null }; railway: { set: boolean; last4: string | null }; status: DeployTarget[] }>(authed('/api/settings/deploy')),
  saveDeployToken: (target: string, token: string | null, clear = false) =>
    j<{ set: boolean; last4: string | null }>(authed(`/api/settings/deploy/${target}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, clear }) })),
  buildReport: async (sessionId: string, id: string) => {
    const r = await authed(`/api/sessions/${sessionId}/builds/${id}/report.md`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
    return r.text()
  },
  buildZip: async (sessionId: string, id: string) => {
    const r = await authed(`/api/sessions/${sessionId}/builds/${id}/zip`)
    if (!r.ok) throw new Error(r.statusText)
    return r.blob()
  },
  settings: () => j<{ providers: ProviderSetting[]; share_server_keys: boolean }>(authed('/api/settings/providers')),
  saveProvider: (id: string, patch: { api_key?: string; clear_key?: boolean; default_model?: string; base_url?: string }) =>
    j<ProviderSetting>(authed(`/api/settings/providers/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })),
  testKey: (id: string, api_key?: string, base_url?: string) =>
    j<{ ok: boolean; models?: string[]; error?: string }>(post(`/api/settings/providers/${id}/test`, { api_key, base_url })),
  targets: () => j<{ id: string; label: string }[]>(fetch('/api/export/targets')),
  transcript: async (id: string) => {
    const r = await authed(`/api/sessions/${id}/transcript.md`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
    return r.text()
  },
  /** Streams the build brief; calls onChunk with the accumulated text. */
  brief: async (id: string, req: BriefRequest, onChunk: (text: string) => void, signal?: AbortSignal) => {
    const r = await post(`/api/sessions/${id}/brief`, req)
    if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let text = ''
    for (;;) {
      if (signal?.aborted) {
        reader.cancel()
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
      onChunk(text)
    }
    return text
  },
}

export interface EngineStatus {
  id: string
  label: string
  logo: string
  color: string
  installed: boolean
  version: string | null
  auth: string | null
  ok: boolean
  hint: string | null
  token_set?: boolean  // Claude Code: the user's own subscription token is stored on this server
}

export interface ServiceVar {
  var: string
  service: string
  purpose: string | null
  url: string | null
  cost: string | null
  example: string
  note: string | null
  public: boolean
  required: boolean
  secret: boolean
  configured: boolean
  tier?: 'needed' | 'auto' | 'optional'  // needed for the app to work · Tably provides it · an improvement
  auto_reason?: string
}

export interface CloudStatus {
  static: 'local' | 'cloudflare'
  server: 'fly' | 'railway' | null
  database: 'neon' | null
  auth: 'supabase' | null
  missing: Record<'cloudflare' | 'fly' | 'neon' | 'supabase', string | null> & { railway?: string | null }
  public_url: string
}
/** Notion tickets resolved by the team. */
export interface Ticket { id: string; title: string; status: string | null; priority: string | null; assignee: string | null; due: string | null; pr: string | null; url: string | null; bucket: 'urgent' | 'high' | 'medium' | 'low' | 'none'; created: string; edited: string; extra: Record<string, string>; fields?: Record<string, string>; project_value?: string | null; project?: TicketProject }
export interface TicketProject { ok: boolean; key: string | null; method?: 'manual' | 'feature' | 'auto' | 'llm' | 'default'; confidence?: number | null; evidence?: string | null; session_id?: string; build_id?: string; repo_url?: string | null; reason?: 'sin_proyecto' | 'ticket_sin_valor' | 'valor_sin_proyecto'; prop?: string }
export interface ClassifyJob { status: 'idle' | 'running' | 'done' | 'error'; quiet?: boolean; total?: number; done?: number; detected?: number; undecided?: number; error?: string | null; finished?: number }
export interface ProjectMapEntry { session_id: string | null; build_id: string | null; repo_url: string | null }
export interface GroupableProp { name: string; type: string; options: { name: string; color: string | null }[] }
export interface TicketRun { user_id: string; page_id: string; title: string | null; session_id: string | null; build_id: string | null; status: 'queued' | 'building' | 'reviewing' | 'built' | 'changes' | 'pr' | 'approved' | string; base_commit: string | null; branch: string | null; pr_url: string | null; council_session: string | null; error: string | null; started: number; updated: number }
export interface TicketsConfig {
  link: { user_id?: string; database_id: string | null; database_title: string | null; props: Record<string, string | null>; status_map: Partial<Record<'todo' | 'in_progress' | 'review' | 'done', string | null>>; session_id: string | null; build_id: string | null; repo_url: string | null; assignee: string | null; projects?: { prop?: string | null; map?: Record<string, ProjectMapEntry> } } | null
  schema: { title: string; props: Record<string, string | null>; status_type: string | null; status_options: string[]; status_map: Record<string, string | null>; url: string | null; project_props?: { name: string; options: string[] }[] } | { error: string } | null
  github: { set: boolean; last4: string | null }
}
/** Growth levels: the strict ladder (1 En línea → 4 Monetizado) and how far the project is from the next step. */
export interface LevelCheck { id: string; who: 'team' | 'user' | 'world'; label: string; label_en: string; ok: boolean; evidence: string | null }
export interface LevelDef { n: number; id: string; label: string; label_en: string; goal: string; goal_en: string; unlocks: string; unlocks_en: string }
export interface LevelRow extends LevelDef { checks: LevelCheck[]; done: number; total: number; pct: number; complete: boolean }
export interface LevelsInfo {
  level: number
  max: number
  label: string | null
  label_en: string | null
  next: number | null
  next_label: string | null
  next_label_en: string | null
  pct: number
  pending: LevelCheck[]
  levels: LevelRow[]
  market_ready: boolean
  visits: number
}
export interface AnalyticsStats { site: string | null; pageviews: number; events: number; errors: number; live: number; live_pages: { path: string; n: number }[]; last_30m: number; days: { day: string; n: number }[]; pages: { path: string; n: number }[]; top_events: { name: string; n: number }[]; last_errors: { name: string; ts: number }[] }
export interface MarketListing {
  id: string
  slug: string | null
  title: string
  pitch: string | null
  price_usd: number | null
  level: number
  status: string
  created: number
  updated: number
  visits?: number
  visits_7d?: number
  owner?: string | null
  owner_email?: string | null
  url?: string | null
  mine?: boolean
  session_id?: string | null
  build_id?: string | null
}
export type GithubRepo = { full_name: string; name: string; url: string; homepage: string | null; private: boolean; pushed_at: string | null }

export interface AnalyticsApp {
  slug: string
  title: string
  url: string | null
  status: string
  provider: string
  build_id: string
  session_id: string | null
  installed: boolean
  needs_republish: boolean  // the project has the snippet but the version online is older
  stats: AnalyticsStats
  visits_7d: number
  // a site outside Tably (its own GitHub + host), connected only to Analytics
  external?: { repo: string | null; pr_url: string | null; pr_error: string | null; snippet: string; package: string; github: boolean }
}
export interface AnalyticsRow { key: string; n: number }
export interface AnalyticsPerson { id: string; email: string | null; name: string | null; first_seen: number; last_seen: number; pageviews: number; actions: number; sessions: number; country: string | null; device: string | null; os: string | null; browser: string | null }
export interface AnalyticsDetail {
  site: string
  days: number
  kpis: { visitors: number; sessions: number; pageviews: number; pages_per_session: number; events: number; clicks: number; errors: number; identified: number; live: number }
  series: { day: string; visitors: number; pageviews: number; sessions: number }[]
  countries: AnalyticsRow[]; devices: AnalyticsRow[]; os: AnalyticsRow[]; browsers: AnalyticsRow[]; referrers: AnalyticsRow[]
  pages: AnalyticsRow[]; clicks: AnalyticsRow[]; events: AnalyticsRow[]; errors: AnalyticsRow[]
  people: AnalyticsPerson[]
  live: { path: string; country: string | null; device: string | null; ts: number }[]
}
/** Video ads made from the app (backend/app/ads.py) and their publication on Meta Ads (backend/app/meta_ads.py). */
export interface AdScript {
  angle: string; name: string; hook: string; emphasis: string; sub: string; points: string[]; captions: string[]; cta: string; cta_sub: string
  font: 'grotesk' | 'serif' | 'rounded'; palette: { bg: string; surface: string; ink: string; muted: string; accent: string; accentInk: string }
  primary_text: string; headline: string; description: string; cta_type: string; link: string
  lines?: string[]; notes_title?: string; notes?: string[]; before?: string[]; after?: string[]; steps?: string[]; marquee?: string[]
  query?: string; pov?: string; problem?: string; question?: string; answer?: string; stat?: { value: string; label: string } | null
  chat?: { me: boolean; text: string }[]; notifs?: { title: string; body: string }[]
}
/** What the team understood of the app (the ads are written from it); the user can correct it. */
export interface AppSummary { name: string; one_liner: string; what: string; for_whom: string; problem: string; features: string[]; proof: string[]; tone: string; category: string; offer: string }
export interface Ad {
  id: string; created: number; updated: number; status: 'capturing' | 'writing' | 'queued' | 'rendering' | 'ready' | 'error'; step: string; progress: number
  instructions: string; template?: string; script: AdScript | null; screens: { kind: 'phone' | 'desktop'; caption: string }[]; formats: Record<string, number>
  error?: string | null; writer?: string | null; source?: string; version?: number
  meta: null | { status: 'publishing' | 'done' | 'error'; step?: string; error?: string; manager_url?: string; campaign_id?: string; daily_budget?: number; currency?: string; countries?: string[] }
}
export interface AdsPayload {
  ads: Ad[]; source: { kind: 'live' | 'design' | 'preview' | 'none'; label?: string; url?: string }; engine: boolean; writer: string | null
  app: { status: 'none' | 'capturing' | 'summarizing' | 'recommending' | 'ready' | 'error'; step: string; error?: string | null; summary: AppSummary | null; summary_by?: string | null
    source?: string | null; edited: boolean; stale: boolean; updated?: number; screens: { kind: 'phone' | 'desktop'; route: string; file: string; ratio: number; bg: string }[]; recommended: { id: string; why: string }[]; palette?: AdScript['palette'] | null }
  meta: { ready: boolean; connected: boolean; account?: string; expired?: boolean }
}
export interface MetaPublish { account_id: string; page_id: string; currency: string; daily_budget: number; countries: string[]; age_min: number; days: number | null; link: string }

/** The Ad Studio: the user's own videos and images, turned into an ad by five agents (backend/app/studio.py). */
export interface StudioMedia { id: string; name: string; kind: 'video' | 'image'; duration?: number; width?: number; height?: number; audio?: boolean; thumb?: string }
export interface StudioEvent { agent: 'listen' | 'plan' | 'edit' | 'improve' | 'review'; text: string; kind: 'note' | 'step' | 'result' | 'verdict' | 'warn' | 'done'; round: number; ts: number
  data: { highlights?: { video: string; start: number; end: number; quote: string; why: string }[]; plan?: { angle?: string; sequence: { type: string; media?: string; from?: number; to?: number; d?: number; title?: string; text?: string }[] }
    notes?: string[]; approved?: boolean; score?: number; strengths?: string[]; fix?: string[]; video?: string; heard_by?: string | null } }
export interface StudioProject {
  id: string; title: string; created: number; updated: number; status: 'draft' | 'running' | 'done' | 'error' | 'stopped'; stage: string; error?: string | null; round: number; version: number
  goal: 'sell' | 'awareness' | 'signup'; link: string; instructions: string; language: string; media: StudioMedia[]; running: boolean
  timeline?: StudioEvent[]; agents?: Record<string, { status: 'waiting' | 'working' | 'done' | 'returned' | 'error'; by?: string }>
  preview?: { file: string; round: number; ts: number } | null; final?: { vertical: string; square: string; approved: boolean; ts: number } | null
  gen?: StudioGen | null
  tour?: { status: 'working' | 'done' | 'error'; step?: string | null; url: string; error?: string | null } | null  // «Grabar mi app»
}
/** An ad made without footage: what the digital twin says and the stock shots (backend/app/twin.py, studio.gen_plan / generate). */
export interface StudioGen { status?: 'draft' | 'working' | 'done' | 'error'; step?: string | null; error?: string | null; voice: string; broll: { query: string; shows: string }[]; seconds: number; credits?: { author: string; page: string; site?: string }[] }
export interface TwinState { twin: { name: string | null; status: 'new' | 'uploading' | 'training' | 'consent' | 'ready' | 'failed'; step: string | null; consent_url: string | null; consent_status: string | null; error: string | null; working: boolean; updated: number } | null
  keys: { heygen: { set: boolean; last4: string | null }; pexels: { set: boolean; last4: string | null }; pixabay: { set: boolean; last4: string | null } }; engine: boolean }
export interface StudioList { projects: StudioProject[]; ready: boolean; transcriber: string | null; model: boolean; agents: { id: string; es: string; en: string; role_es: string; role_en: string }[]
  limits: { files: number; video_mb: number; image_mb: number; minutes: number } }

/** AdTier: video ads ranked S/A/B/C with a reusable template each (backend/app/adtier.py). */
export type AdTierTier = 'S' | 'A' | 'B' | 'C'
export interface AdTierCard { id: string; slug: string; title: string; brand: string; agency: string; year: number | null; country: string; language: string; platform_origin: string | null
  format: string | null; duration_s: number | null; industry: string; embed_provider: 'youtube' | 'vimeo' | 'tiktok'; embed_id: string; thumbnail_url: string | null; status: 'draft' | 'review' | 'published'
  tier: AdTierTier | null; proposed: AdTierTier | null; tags: { hook_type?: string; emotion?: string[]; technique?: string[] } }
export interface AdTierEvidence { type: 'award' | 'performance' | 'editorial'; detail: string; url: string; awarded_at?: string | null; days_active?: number | null; variations_count?: number | null }
export interface AdTierTemplate { hook?: { seconds?: string; type?: string; description?: string; line?: string }; beats?: { from: number; to: number; purpose: string; visual?: string; audio?: string }[]
  cta?: { seconds?: string; type?: string; line?: string }; tone?: string[]; production?: { people_on_camera?: number; locations?: number; captions?: boolean; music?: string; budget_tier?: string }
  reusable_skeleton?: string; adapt_notes?: string }
export interface AdTierDetail extends AdTierCard { source_url: string; embed_url: string; evidence: AdTierEvidence[]
  tier_info: { tier: AdTierTier; basis: string; justification: string; proposed: AdTierTier; evidence_tier: AdTierTier | null; score_tier: AdTierTier; assigned_by: string } | null
  score: { hook: number; structure: number; copy: number; visual: number; platform_fit: number; total: number; model: string; rationale: Record<string, string>; needs_review: number; confidence: number } | null
  template: AdTierTemplate | null; template_version: number | null; similar: AdTierCard[]; unreviewed?: boolean; transcript?: { start: number; end: number; text: string }[]; stage?: string; error?: string | null; embed_ok?: number }
/** AdTier «Para vos»: a profile of the person's business and the ads that fit it (backend/app/adtier_foryou.py). */
export interface ForYouProfileData { name: string; summary: string; sector: string; kind: string; country: string; language: string; audience: string; goal: string
  industries: string[]; keywords: string[]; formats: string[]; queries: string[]; why: string; by: string | null; placement?: 'reels' | 'stories' | 'long'
  accounts?: string[]; refs?: ForYouRef[]; notes?: ForYouNote[]; ideas?: ReelIdea[]; patterns?: string; ideas_by?: string | null; ideas_at?: number; ideas_error?: string | null; uploads?: ForYouUpload[]; ideas_ups?: string[] }
export interface ForYouUpload { id: string; name: string; kind: 'video' | 'image'; status: 'reading' | 'ready' | 'error'; error: string | null; duration: number | null; frames: string[]; transcript: string; heard?: boolean; audio?: boolean; source?: 'upload' | 'recording'; video?: string | null; trimmed?: boolean }
export interface MetaApp { admin: boolean; app_id: string | null; has_secret: boolean; configured: boolean; redirect_uri: string }
export interface ForYouRef { caption: string; url: string; thumb: string | null; views?: number | null; likes?: number | null; comments?: number | null; duration?: number | null; date?: string; platform: string | null; account: string }
export interface ForYouNote { account: string; platform: string; handle: string; via: string | null; count: number; problem: string | null; action: 'connect_meta' | 'enable_meta' | null; name?: string; followers?: number | null }
export interface ReelIdea { title: string; duration_s: number; based_on: number[]; why: string; hook: string; beats: { t: string; shot: string; text: string; voice: string }[]; cta: string; caption: string; audio: string }
export interface ForYouProfile { id: string; name: string; source: 'tably' | 'form'; session_id: string | null; build_id: string | null; answers: Record<string, string>; data: ForYouProfileData
  searched: number | null; created: number; updated: number; searching: boolean; ideating?: boolean; found?: number }
export interface ForYouHome { profiles: ForYouProfile[]; projects: { session_id: string; build_id: string; title: string; updated: number }[]; sectors: { id: string; es: string; en: string }[]
  kinds: string[]; goals: string[]; model: boolean; meta?: { ready: boolean; connected: boolean; instagram: boolean; admin?: boolean } }
export interface ForYouMatches { profile: ForYouProfile; catalog: (AdTierCard & { match: number; why: string[] })[]; found: (AdTierCard & { stage: string | null; error: string | null; reviewed: boolean })[]; other_length?: number; searching: boolean; ideating?: boolean }
export interface AdTierAgreement { reviewed: number; agree: number; pct: number | null }
export interface AdTierHome { tiers: Record<AdTierTier, AdTierCard[]>; facets: { format: string[]; industry: string[]; language: string[]; country: string[]; platform_origin: string[]; brand: string[]; counts: Record<string, number> }
  admin: boolean; formats: string[]; agreement?: AdTierAgreement; takedown_email: string | null; public_url: string; autopublish?: boolean; seed_size?: number; working?: number }
export interface AdTierPage { total: number; page: number; per: number; videos: AdTierCard[] }
export interface AdTierMasters { masters: { format: string; tier: AdTierTier; body: { skeleton?: string; beats?: { from: number; to: number; purpose: string; what: string }[]; top_hooks?: { type: string; share: number; example: string }[]; ctas?: string[]; production?: string; what_wins?: string[]; duration_avg_s?: number }; videos: string[]; model: string; created: number }[]
  status: { format: string; tier: AdTierTier; videos: number; ready: boolean; made: boolean }[]; min: number }

export interface LevelsPayload { levels: LevelsInfo; analytics: AnalyticsStats; app: CloudApp | null; listing: MarketListing | null; snippet: string }
export interface CloudDb { provider: string; ok: boolean; vars: string[]; host: string | null; ts: number }
export interface CloudLeak { service: string; url: string; env: string; files: string[]; live: boolean; own: boolean; preview: string }
export interface CloudApp {
  build_id: string
  slug: string
  provider: 'local' | 'cloudflare' | 'fly' | string
  kind: 'static' | 'server' | 'unknown' | string
  status: 'building' | 'deploying' | 'live' | 'error' | 'down' | string
  url: string | null
  deploy_logs?: string | null  // Railway build logs while it deploys
  version: number | null
  error: string | null
  log: string[]
  db: Partial<Record<'database' | 'auth', CloudDb>>
  leaks?: { ts: number; attempts: number; keys: CloudLeak[] } | null  // keys found in the code before publishing (never the key itself)
  created: number
  updated: number
}
export interface GitInfo {
  exists: boolean
  clone_url: string
  head: string | null
  commits: { hash: string; ts: number; message: string; refs: string[] }[]
  tags: string[]
}
export interface CloudInfo {
  app: CloudApp | null
  git: GitInfo
  migration: { has_database: boolean; database_url_masked: string | null; pg_dump: string | null; pg_restore: string | null; env_vars: string[] }
  status: CloudStatus
  github: { set: boolean; last4: string | null }
  publishing: boolean
  version: number
}
export interface AgentSessionSummary {
  id: string
  engine: 'muse' | 'claude' | 'codex'
  title: string
  first_prompt: string | null
  cwd: string | null
  branch: string | null
  model: string | null
  created: number
  updated: number
  size: number
  live: boolean
}
export interface AgentSessionList {
  engine: 'muse' | 'claude' | 'codex'
  available: boolean
  count: number
  projects: { key: string; name: string; path: string | null; updated: number; sessions: AgentSessionSummary[] }[]
}
export interface AgentPart { type: 'text' | 'thinking' | 'tool'; text?: string; name?: string; summary?: string; input?: string; result?: string | null; is_error?: boolean }
export interface AgentSessionDetail extends AgentSessionSummary {
  items: { role: 'user' | 'assistant'; ts: number | null; parts: AgentPart[] }[]
  meta: { cwd: string | null; branch: string | null; model: string | null; version: string | null }
  usage: { input: number; output: number; cache_read: number; cache_write: number }
  truncated: boolean
  resume: string
  file: string
}
export interface DeployTarget {
  id: string
  label: string
  installed: boolean
  token: boolean
  logged_in: boolean
  ok: boolean
  good_for: string
  token_help: string
  hint: string | null
}

export interface ServiceGuideData {
  intro: string
  cost: string | null
  steps: { title: string; detail: string; url: string | null }[]
  generated: boolean
  model?: string
  curated?: boolean  // hand-written by Tably (not a model)
  time?: string | null
  test?: string | null  // how to try it without risk
  looks?: Record<string, string>  // var → what its value looks like
}

export interface ServicesInfo {
  items: ServiceVar[]
  groups: { service: string; url: string | null; purpose: string | null; vars: ServiceVar[]; tier?: 'needed' | 'auto' | 'optional'; kind?: string; impact?: string }[]
  missing: string[]
  app?: { status: string | null; url: string | null; updated: number | null } | null
  pending_publish?: boolean  // values saved after the last publish: the published app gets them when it is published again
  stack: string[]
  recommended_target: string
  deploy_targets: DeployTarget[]
}

export interface DashboardSession extends SessionSummary {
  builds: BuildSummary[]
  councils?: { id: string; round: number | null; version: number | null; build_id: string | null; status: string; cost_usd: number; created: number; live: boolean }[]
  council_cost_usd?: number
  cost_usd?: number
  turns?: number
  has_brief?: boolean
  title?: string | null
}

export interface DashboardData {
  sessions: DashboardSession[]
  spend: { total_usd: number; month_usd: number; month: string }
  active_jobs: number
  max_jobs: number
  setup: { api_keys: number; engines: { id: string; label: string; auth: string | null }[]; langfuse: boolean; sessions: number }
}

export interface RunService {
  id: string
  dir: string
  label: string
  kind: string
  web: boolean
  device?: 'ios' | 'android'  // Expo: runs on the iOS Simulator / Android emulator (the panel shows the device screen)
  available?: boolean  // that device can run on this machine
  hint?: string | null  // what is missing when it cannot
  install: string
  run: string
  needs_install: boolean
}

export interface AppRunState {
  status: string
  service: string
  label?: string
  url: string | null
  embed_url?: string | null
  port: number
  error: string | null
  logs?: string[]
  fix?: RunFix | null
  started?: number
}

export interface ResearchJob {
  id: string
  refs: string[]
  deep: boolean
  status: 'running' | 'done' | 'error'
  visited: { name?: string; url?: string | null; ok?: boolean; error?: string | null }[]
  activity: { kind: string; label: string; path: string; ts: number }[]
  md: string
  error: string | null
  model?: string
}

export interface StripeStatus { enabled: boolean; mode: 'test' | 'live' | 'off'; webhook: boolean; app_url: string }

export interface Order {
  id: string
  user_id: string
  kind: 'fde' | 'fees'
  ref: string
  build_id: string
  session_id: string
  name: string
  amount_usd: number
  status: 'pending' | 'paid' | 'expired' | 'cancelled'
  stripe_session: string
  created: number
  paid_at: number | null
}

export interface FdePackage {
  id: string
  name: string
  price_usd: number
  eta: string
  badge: string | null
  tagline: string
  includes: string[]
  excludes: string[]
  needs: string[]
  checkout_url?: string | null
  booking_url?: string | null
}

export interface FdeRequest {
  id: string
  session_id: string
  build_id: string
  package: string
  status: string
  notes: string
  contact: string
  created: number
  updated: number
  checkout_url?: string | null
  booking_url?: string | null
  ticket: {
    project: { title: string; session_id: string; build_id: string; files: number; workdir: string | null; version: string | null; commit: string | null; readiness: number | null; status: string }
    brief_summary: string
    stack: { id: string; label: string; run: string }[]
    blockers: { severity: string; text: string; role: string }[]
    services: { service: string; purpose: string; vars: string[]; configured: boolean }[]
    missing_vars: string[]
    deploys: { target: string; ok: boolean | null; url: string | null }[]
    notes: string
    contact: string
  }
}

export interface SkillSummary {
  id: string
  name: string
  description: string
  tags: string
  chars: number
  updated?: number
  name_en?: string
  description_en?: string
}

export interface CatalogSkill {
  id: string
  name: string
  slug: string
  description: string
  category: string
  source: string
  repo: string
  path: string
  url: string
  section: string
  chars: number
  score?: number
  name_es?: string
  description_es?: string
}
export interface CatalogCategory { id: string; label: string; label_en?: string; count: number }
export interface CatalogSync { running: boolean; step: string; done: number; total: number; repos: number; skills: number; errors: string[]; finished: number | null; total_skills?: number }

export interface BuildSummary {
  id: string
  provider: string
  model: string
  status: string
  fees_usd?: number  // per-use charges (deep analysis) on top of tokens
  fees_due_usd?: number  // the part of those not paid yet
  turns: number
  cost_usd: number
  build_seconds?: number  // wall-clock of all its turns
  files: number
  stages?: number
  engine_session?: string | null
  workdir?: string | null
  version?: number
  readiness?: number | null
  pending_council?: string | null
  level?: number | null
  level_pct?: number | null
  level_next?: number | null
}

export interface ProviderSetting {
  id: string
  label: string
  color: string
  kind: string
  key_env: string | null
  source: 'user' | 'server' | 'none'
  user_key_last4: string | null
  server_key: boolean
  default_model: string
  base_url: string | null
  configured: boolean
}

export interface BriefRequest {
  provider: string
  model: string
  target: string
  include_transcript: boolean
  regenerate: boolean
  user_notes?: string
}

export function connect(id: string, onEvent: (e: ArenaEvent) => void, onClose: () => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/sessions/${id}?token=${encodeURIComponent(token ?? '')}`)
  ws.onmessage = (m) => onEvent(JSON.parse(m.data))
  ws.onclose = onClose
  return () => ws.close()
}

export interface IntakeAttachment { id: string; name: string; size: number; kind: 'text' | 'binary' | 'skipped'; chars: number; origin: string }
export interface IntakeQuestion { id: string; question: string; why: string; options: string[]; answer: string | null }
export interface IntakeState {
  id: string
  status: 'idle' | 'running' | 'waiting' | 'done' | 'error'
  step: string
  text: string
  provider: string
  model: string
  attachments: IntakeAttachment[]
  questions: IntakeQuestion[]
  understanding: string
  prompt: string
  error: string | null
  cost_usd: number
  rounds: number
  events: Record<string, any>[]
  context_chars: number
  context?: string | null
}

/** Intake: idea + attachments → prompt-engineered brief (see backend/app/intake.py). */
export const intake = {
  create: () => j<IntakeState>(authed('/api/intake', { method: 'POST' })),
  get: (id: string) => j<IntakeState>(authed(`/api/intake/${id}`)),
  upload: (id: string, files: File[], paths: string[]) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f, f.name))
    form.append('paths', JSON.stringify(paths))
    return j<IntakeState & { added: number }>(authed(`/api/intake/${id}/files`, { method: 'POST', body: form }))
  },
  pick: (id: string, kind: 'folder' | 'files') => j<IntakeState & { added: number; cancelled: boolean; errors?: string[] }>(post(`/api/intake/${id}/pick`, { kind })),
  addPath: (id: string, path: string) => j<IntakeState & { added: number }>(post(`/api/intake/${id}/path`, { path })),
  remove: (id: string, attId: string) => j<IntakeState>(authed(`/api/intake/${id}/files/${attId}`, { method: 'DELETE' })),
  run: (id: string, text: string, provider: string, model: string, extra = '') => j<IntakeState>(post(`/api/intake/${id}/run`, { text, provider, model, extra, language: getLang() })),
  rolePrompts: (id: string, agents: { id: string; name: string; role?: string | null; label?: string; mandate?: string; persona?: string }[], provider: string, model: string) => j<{ prompts: Record<string, string>; cost_usd: number }>(post(`/api/intake/${id}/role-prompts`, { agents, provider, model, language: getLang() })),
  answer: (id: string, answers: Record<string, string>) => j<IntakeState>(post(`/api/intake/${id}/answer`, { answers })),
  cancel: (id: string) => j<IntakeState>(authed(`/api/intake/${id}/cancel`, { method: 'POST' })),
  connect: (id: string, onEvent: (e: Record<string, any>) => void, onClose: () => void): (() => void) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/intake/${id}?token=${encodeURIComponent(token ?? '')}`)
    ws.onmessage = (m) => onEvent(JSON.parse(m.data))
    ws.onclose = onClose
    return () => ws.close()
  },
}

export function connectBuild(id: string, onEvent: (e: Record<string, any>) => void, onClose: () => void, sessionId?: string | null): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/builds/${id}?token=${encodeURIComponent(token ?? '')}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`)
  ws.onmessage = (m) => onEvent(JSON.parse(m.data))
  ws.onclose = onClose
  return () => ws.close()
}

/** Re-emits a saved event log with its original timing, scaled by `speed`. */
export function replay(events: ArenaEvent[], speed: () => number, onEvent: (e: ArenaEvent) => void, onDone: () => void): () => void {
  let i = 0
  let cancelled = false
  let timer: number | undefined
  const step = () => {
    if (cancelled) return
    if (i >= events.length) return onDone()
    const ev = events[i++]
    onEvent(ev)
    const next = events[i]
    if (!next) return onDone()
    const gap = Math.min(4000, (next.ts - ev.ts) * 1000) / speed()
    timer = window.setTimeout(step, Math.max(0, gap))
  }
  step()
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}

export type DeployFailureGroup = { signature: string; label: string; rule: string | null; prevented: boolean; count: number; fixed: number; unfixed: number; open: number; apps: number; last_ts: number; excerpt: string; fix_summary: string | null }
export type AppError = {
  id: string; source: 'server' | 'browser'; title: string; detail: string | null; count: number; first_ts: number; last_ts: number
  status: 'open' | 'fixing' | 'deploying' | 'fixed' | 'needs_approval' | 'stuck' | 'ignored'; attempts: number; size: string | null; applied: number
  what: string | null; fix: string | null; impact: string | null; fixed_ts: number | null
}
export type AppErrors = { errors: AppError[]; summary: { fixed: number; open: number; needs_approval: number; stuck: number }; limit_reached: boolean }
export type DeployFailures = { groups: DeployFailureGroup[]; total: number; fixed: number; days: number }

export interface ErrorIssue {
  id: string; source: 'server' | 'browser' | 'run' | string; title: string; detail: string | null; sample: string | null; count: number
  first_ts: number; last_ts: number; status: string; attempts: number; what: string | null; fix: string | null; impact: string | null
  series: number[]; in_period: number
}
export interface AiRow { key: string; calls: number; cost: number; tokens: number; latency: number; errors: number }
export interface AiSummary {
  kpis: { calls: number; input_tokens: number; output_tokens: number; cost: number; latency: number; errors: number; cost_per_call: number }
  series: { day: string; calls: number; cost: number }[]
  models: AiRow[]; features: AiRow[]
  recent: { ts: number; provider: string | null; model: string | null; name: string | null; input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number | null; status: string; error: string | null; user: string | null; input: string | null; output: string | null }[]
}
export interface Experiments {
  experiments: { name: string; goal: string | null; visitors: number; winner: string | null; variants: { variant: string; visitors: number; conversions: number; rate: number; lift?: number | null; p?: number | null }[] }[]
  goals: string[]
}

export interface Connection { id: string; label: string; what: string; what_en: string; connected: boolean; account: string | null; since: number | null; ready: boolean }

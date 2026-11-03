import type { AgentConfig } from '../types'

/**
 * Which Muse model does each job best in Muse Team. Muse Wonder for the roles that decide and plan over long horizons
 * (direction, architecture), Muse Spark for the fast, high-volume roles (product, design, quality) and for prompt engineering.
 * The extras (Muse Image, SAM 3.1, Muse Code) are the tools those roles pick up during the build.
 */
export const MUSE_WONDER = 'muse-wonder-1.0'
export const MUSE_SPARK = 'muse-spark-1.3'

export type MuseReco = { model: string; why: string; why_en: string; tool?: string }

const WONDER_ROLES = new Set(['ceo', 'cto', 'coo', 'cfo', 'cpo', 'founder', 'head-engineering', 'tech-lead', 'ai-engineer', 'investor', 'scientist'])

const WHY: Record<string, [string, string]> = {
  ceo: ['decisiones de alcance y prioridad en contexto largo', 'scope and priority decisions over a long context'],
  cto: ['arquitectura y riesgos técnicos con razonamiento profundo', 'architecture and technical risk with deep reasoning'],
  'head-engineering': ['plan de construcción por etapas y revisión de muchos archivos', 'staged build plan and multi-file review'],
  'tech-lead': ['diseño técnico y revisión de código', 'technical design and code review'],
  'product-manager': ['historias y criterios de aceptación, rápido y preciso', 'stories and acceptance criteria, fast and precise'],
  'product-designer': ['pantallas y sistema de diseño; el mockup lo genera Muse Image', 'screens and design system; the mockup comes from Muse Image'],
  brand: ['textos y marca; las imágenes con Muse Image', 'copy and brand; images with Muse Image'],
  qa: ['casos borde y revisión de cada versión, a bajo costo', 'edge cases and per-version review, at low cost'],
  security: ['revisión de seguridad rápida sobre el código', 'fast security review over the code'],
  'ux-researcher': ['lectura de referencias segmentadas con SAM 3.1', 'reading references segmented with SAM 3.1'],
}

const TOOL: Record<string, string> = { 'product-designer': 'Muse Image', brand: 'Muse Image', 'ux-researcher': 'SAM 3.1', 'head-engineering': 'Muse Code', 'tech-lead': 'Muse Code' }

export function museReco(agent: Pick<AgentConfig, 'role' | 'id'>): MuseReco {
  const role = (agent.role || agent.id || '').toLowerCase()
  const model = WONDER_ROLES.has(role) ? MUSE_WONDER : MUSE_SPARK
  const [why, why_en] = WHY[role] ?? (model === MUSE_WONDER ? ['razonamiento largo y decisiones', 'long reasoning and decisions'] : ['rápido, barato y agéntico', 'fast, cheap and agentic'])
  return { model, why, why_en, tool: TOOL[role] }
}

/** «muse-wonder-1.0» → «Muse Wonder», «muse-spark-1.3» → «Muse Spark 1.3». Other models come back as they are. */
export function museLabel(model: string | undefined | null): string {
  if (!model) return ''
  const m = model.match(/^muse-(wonder|spark|image|code|glimmer)-?([\d.]+)?(-contributor)?$/)
  if (!m) return model
  const name = m[1][0].toUpperCase() + m[1].slice(1)
  const ver = m[2] && m[2] !== '1.0' ? ` ${m[2]}` : ''
  return `Muse ${name}${ver}${m[3] ? ' (contributor)' : ''}`
}

/** The same team on Muse, but through the simulated provider when the Meta key is not loaded yet (the card still shows Muse and its model). */
export function museTeamFor(agents: AgentConfig[], metaConfigured: boolean, trialModel?: string): AgentConfig[] {
  // without the Meta key a seat runs on the free Baseten trial (an open model) when there is one, else simulated
  const standIn = trialModel ? { provider: 'baseten', model: trialModel } : { provider: 'mock', model: 'mock-1' }
  return agents.map((a) => (metaConfigured ? { ...a, provider: 'meta', wanted_provider: undefined, model: museReco(a).model, color: null } : { ...a, ...standIn, wanted_provider: 'meta' }))
}

/** The same team, every seat on Muse with the recommended model for its role. */
export function museTeam(agents: AgentConfig[]): AgentConfig[] {
  return agents.map((a) => ({ ...a, provider: 'meta', model: museReco(a).model, wanted_provider: undefined, color: null }))
}

export const isMuseReco = (a: Pick<AgentConfig, 'provider' | 'model' | 'role' | 'id'>) => a.provider === 'meta' && a.model === museReco(a).model

/** Prompt engineering: Spark reads the request and the attachments fast and returns the structured brief. */
export const MUSE_PROMPT_RECO = { model: MUSE_SPARK, why: 'lee el pedido y los adjuntos rápido y devuelve el brief estructurado', why_en: 'reads the request and attachments fast and returns the structured brief' }

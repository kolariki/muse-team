export const GLYPH: Record<string, string> = {
  anthropic: '✳',
  openai: '◎',
  deepseek: '🐋',
  gemini: '✦',
  xai: '𝕏',
  groq: '⚡',
  kimi: '☾',
  meta: '∞',
  mistral: '▲',
  openrouter: '⇄',
  ollama: '🦙',
  baseten: '◆',
  mock: '◌',
}

/** Sober categorical palette (validated: light surface, CVD-safe with name labels) for agents that share a provider (e.g. all on "mock"). */
export const PALETTE = ['#C0603F', '#17896A', '#3D5CC4', '#AD7D1A', '#9A57B8', '#6E8226', '#1689A8', '#C24B6E']

export const BRAND_COLOR: Record<string, string> = {
  anthropic: '#C0603F',
  openai: '#17896A',
  deepseek: '#3D5CC4',
  gemini: '#9A57B8',
  xai: '#4B5157',
  groq: '#C24B6E',
  kimi: '#1F3A68',
  meta: '#0082FB',
  mistral: '#AD7D1A',
  openrouter: '#1689A8',
  ollama: '#6E8226',
  baseten: '#111111',
  mock: '#8A9299',
  'claude-code': '#C0603F',
  'muse-code': '#0082FB',
  codex: '#17896A',
}

/** `label`/`desc` are Spanish; `label_en`/`desc_en` the English. Resolve with `pick(MODE_INFO[m], 'label')` from lib/i18n. */
export const MODE_INFO = {
  handoff: {
    label: 'Handoff libre',
    label_en: 'Free handoff',
    desc: 'Cada agente decide a quién pasarle la palabra (o terminar). Se ve quién llama a quién y por qué.',
    desc_en: 'Each agent decides who speaks next (or ends). You see who calls whom and why.',
  },
  debate: {
    label: 'Debate',
    label_en: 'Debate',
    desc: 'Turnos fijos en ronda. Los agentes igual eligen a quién querrían llamar: se muestra como “deseo” vs. realidad.',
    desc_en: 'Fixed turns in rounds. Agents still pick whom they would call: shown as “wish” vs. reality.',
  },
  roundtable: {
    label: 'Mesa redonda',
    label_en: 'Round table',
    desc: 'Ronda ordenada para construir una solución en conjunto.',
    desc_en: 'An ordered round to build a solution together.',
  },
  audit: {
    label: 'Auditoría',
    label_en: 'Audit',
    desc: 'El equipo evalúa un proyecto existente.',
    desc_en: 'The team evaluates an existing project.',
  },
  review: {
    label: 'Consejo de revisión',
    label_en: 'Review council',
    desc: 'El equipo revisa el producto construido antes de salir a producción.',
    desc_en: 'The team reviews the built product before it ships to production.',
  },
} as const


/** Per-company card look: a soft brand-tinted surface + border, so a role card reads as "the Anthropic one" at a glance. */
export const BRAND_THEME: Record<string, { tint: string; bg: string; border: string; accent: string; ink: string }> = {
  anthropic: { tint: '#F2E4D6', bg: 'linear-gradient(135deg, #F8F2EA 0%, #F1E4D6 100%)', border: '#E6CDB8', accent: '#C0603F', ink: '#3B2A22' },
  openai: { tint: '#E7ECEA', bg: 'linear-gradient(135deg, #F6F7F7 0%, #E9ECEB 100%)', border: '#D3D9D6', accent: '#0F0F0F', ink: '#1B1F1E' },
  deepseek: { tint: '#DFE8FF', bg: 'linear-gradient(135deg, #EEF3FF 0%, #E1E9FF 100%)', border: '#C9D6FA', accent: '#4D6BFE', ink: '#1E2A5A' },
  gemini: { tint: '#E9E6FB', bg: 'linear-gradient(135deg, #EDF2FF 0%, #F4EDFF 60%, #FDEFF4 100%)', border: '#D6D4F5', accent: '#5B7BFF', ink: '#2A2E5A' },
  xai: { tint: '#E3E3E3', bg: 'linear-gradient(135deg, #F3F3F3 0%, #E6E6E6 100%)', border: '#CFCFCF', accent: '#111111', ink: '#161616' },
  groq: { tint: '#FFE1D6', bg: 'linear-gradient(135deg, #FFF2EC 0%, #FFE4DA 100%)', border: '#F6C9B8', accent: '#F55036', ink: '#4A221A' },
  meta: { tint: '#D9E9FF', bg: 'linear-gradient(135deg, #EEF5FF 0%, #DCEBFF 100%)', border: '#BBD5FA', accent: '#0064E0', ink: '#0B2E66' },
  kimi: { tint: '#DEE4F2', bg: 'linear-gradient(135deg, #EEF1F8 0%, #E2E7F3 100%)', border: '#C8D1E6', accent: '#1D2B53', ink: '#1D2B53' },
  mistral: { tint: '#FFE6C2', bg: 'linear-gradient(135deg, #FFF5E6 0%, #FFE8C7 100%)', border: '#F3D59F', accent: '#FF7000', ink: '#4A2E0A' },
  openrouter: { tint: '#E5E0FA', bg: 'linear-gradient(135deg, #F1EEFF 0%, #E7E3FB 100%)', border: '#D2CBF3', accent: '#6467F2', ink: '#2B2A5A' },
  ollama: { tint: '#EAEAEA', bg: 'linear-gradient(135deg, #FAFAFA 0%, #ECECEC 100%)', border: '#D6D6D6', accent: '#222222', ink: '#1A1A1A' },
  baseten: { tint: '#E8E8E8', bg: 'linear-gradient(135deg, #FAFAFA 0%, #EAEAEA 100%)', border: '#D4D4D4', accent: '#111111', ink: '#111111' },
  mock: { tint: '#E9EDEB', bg: 'linear-gradient(135deg, #F6F7F6 0%, #ECEFED 100%)', border: '#DCE2DE', accent: '#8A9299', ink: '#3A4440' },
  'muse-code': { tint: '#D9E9FF', bg: 'linear-gradient(135deg, #EEF5FF 0%, #DCEBFF 100%)', border: '#BBD5FA', accent: '#0064E0', ink: '#0B2E66' },
  'claude-code': { tint: '#F2E4D6', bg: 'linear-gradient(135deg, #F8F2EA 0%, #F1E4D6 100%)', border: '#E6CDB8', accent: '#C0603F', ink: '#3B2A22' },
  codex: { tint: '#E7ECEA', bg: 'linear-gradient(135deg, #F6F7F7 0%, #E9ECEB 100%)', border: '#D3D9D6', accent: '#0F0F0F', ink: '#1B1F1E' },
  // deploy targets (same card language as the model companies)
  vercel: { tint: '#E8E8E8', bg: 'linear-gradient(135deg, #FAFAFA 0%, #EAEAEA 100%)', border: '#D4D4D4', accent: '#000000', ink: '#111111' },
  railway: { tint: '#E6E3F3', bg: 'linear-gradient(135deg, #F4F2FB 0%, #E8E4F6 100%)', border: '#D3CCEC', accent: '#7B3FE4', ink: '#2A1F4E' },
  langfuse: { tint: '#E3EAF6', bg: 'linear-gradient(135deg, #F3F6FC 0%, #E6ECF8 100%)', border: '#CFDAF0', accent: '#0A60B5', ink: '#1C2E4A' },
}
// ---- dark theme: every brand colour also has a dark version, picked by the browser with CSS light-dark() (the «Taller»
// theme sets color-scheme: dark), so the cards follow a theme change without re-rendering
const hex = (h: string) => { const v = h.replace('#', ''); const f = v.length === 3 ? v.split('').map((c) => c + c).join('') : v; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) }
const toHex = (rgb: number[]) => '#' + rgb.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')
const mix = (a: string, w: number, b: string) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v * w + y[i] * (1 - w))) }
const lum = (h: string) => { const [r, g, b] = hex(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255 }
const DARK_SURFACE = '#1E2938', DARK_LINE = '#2E3A4C', DARK_INK = '#E9EDF2'

function withDark(t: { tint: string; bg: string; border: string; accent: string; ink: string }) {
  const accent = lum(t.accent) < 0.22 ? '#C9D2DC' : t.accent  // near-black brands would vanish on the dark ground
  const ld = (light: string, dark: string) => `light-dark(${light}, ${dark})`
  return {
    tint: ld(t.tint, mix(accent, 0.2, DARK_SURFACE)),
    bg: t.bg.replace(/#[0-9A-Fa-f]{6}\b/g, (c) => ld(c, mix(accent, 0.1 + (1 - lum(c)) * 0.5, DARK_SURFACE))),
    border: ld(t.border, mix(accent, 0.35, DARK_LINE)),
    accent: ld(t.accent, accent),
    ink: ld(t.ink, mix(accent, 0.18, DARK_INK)),
  }
}
const THEMED: Record<string, ReturnType<typeof withDark>> = Object.fromEntries(Object.entries(BRAND_THEME).map(([k, v]) => [k, withDark(v)]))
export const brandTheme = (provider?: string | null) => THEMED[provider ?? ''] ?? THEMED.mock

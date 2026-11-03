import { brandTheme } from '../lib/brand'
import { GLYPH } from '../lib/brand'
import { museLabel } from '../lib/muse'

/** Company logos live in /public/logos/<provider>.png (transparent, 256px). */
const HAS_LOGO = new Set(['meta', 'anthropic', 'openai', 'deepseek', 'gemini', 'xai', 'groq', 'mistral', 'openrouter', 'ollama', 'kimi', 'mock', 'vercel', 'railway', 'langfuse'])

const ALIAS: Record<string, string> = { 'claude-code': 'anthropic', codex: 'openai', 'muse-code': 'meta' }

const HAS_SVG = new Set(['github', 'cloudflare', 'notion', 'baseten', 'meta-ads'])

/** A single black symbol: on the dark theme it goes white (see .logo-mono). */
const MONO = new Set(['baseten', 'github', 'openai', 'xai', 'openrouter', 'ollama', 'vercel', 'railway'])

export const isMonoLogo = (provider?: string | null) => !!provider && MONO.has(ALIAS[provider] ?? provider)

export const logoUrl = (provider?: string | null) => {
  const p = provider ? ALIAS[provider] ?? provider : null
  return p && HAS_LOGO.has(p) ? `/logos/${p}.png` : p && HAS_SVG.has(p) ? `/logos/${p}.svg` : null
}

export default function ProviderLogo({ provider, size = 20, className = '' }: { provider?: string | null; size?: number; className?: string }) {
  const url = logoUrl(provider)
  if (!url) {
    return (
      <span className={`inline-flex items-center justify-center text-ink-3 ${className}`} style={{ width: size, height: size, fontSize: size * 0.8 }}>
        {GLYPH[provider ?? ''] ?? '●'}
      </span>
    )
  }
  return <img src={url} alt={provider ?? ''} width={size} height={size} draggable={false} className={`inline-block object-contain select-none ${isMonoLogo(provider) ? 'logo-mono' : ''} ${className}`} style={{ width: size, height: size }} />
}

/** Big, very light company logo used as a card background. */
export function LogoWatermark({ provider, opacity = 0.07 }: { provider?: string | null; opacity?: number }) {
  const url = logoUrl(provider)
  if (!url) return null
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      draggable={false}
      className={`pointer-events-none select-none absolute -right-[12%] -bottom-[22%] w-[68%] max-w-[260px] rotate-[-8deg] ${isMonoLogo(provider) ? 'logo-mono' : ''}`}
      style={{ opacity, filter: isMonoLogo(provider) ? undefined : 'saturate(0.85)' }}
    />
  )
}


/** Decorative background: one equal-width band per company in the team, colours melting softly into each other,
 *  logo at the same size in every band; only the share (% and roles) under the logo changes. */
export function BrandStripes({ providers, opacity = 1, logos = true, compact = false }: { providers: string[]; opacity?: number; logos?: boolean; compact?: boolean }) {
  const order = [...new Set(providers.length ? providers : ['anthropic', 'openai', 'gemini', 'deepseek'])]
  const n = order.length
  const stops = order.map((p, i) => `${brandTheme(p).tint} ${(((i + 0.5) / n) * 100).toFixed(2)}%`).join(', ')
  const background = n === 1 ? brandTheme(order[0]).tint : `linear-gradient(90deg, ${stops})`
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" style={{ opacity, background }}>
      {logos && <div className="absolute inset-0"><BrandLogoRow providers={providers} compact={compact} /></div>}
    </div>
  )
}

/** One column per company (equal widths): logo, share of the team and "N de T". Fills its container; place it where the logos must live. */
export function BrandLogoRow({ providers, align = 'center', compact = false }: { providers: (string | { provider: string; model?: string })[]; align?: 'center' | 'start'; compact?: boolean }) {
  // a band per company, or per model when the item names one (Muse Wonder vs Muse Spark are different seats at the table)
  const items = (providers.length ? providers : ['anthropic', 'openai', 'gemini', 'deepseek']).map((x) => (typeof x === 'string' ? { provider: x, model: undefined as string | undefined } : x))
  const keyOf = (x: { provider: string; model?: string }) => (x.model ? `${x.provider}|${x.model}` : x.provider)
  const all = items.map(keyOf)
  const order = [...new Set(all)]
  const n = order.length
  const total = all.length
  const logo = n <= 4 ? 88 : n <= 6 ? 64 : 48  // same for every band; shrinks only when there are many companies
  return (
    <div aria-hidden className="pointer-events-none flex h-full w-full">
      {order.map((k, i) => {
        const p = k.split('|')[0]
        const model = items.find((x) => keyOf(x) === k)?.model
        const url = logoUrl(p)
        const count = all.filter((x) => x === k).length
        const pct = Math.round((count / total) * 100)
        const t = brandTheme(p)
        if (compact) {
          // one line per band (logo + share), for short rows such as the project list
          return (
            <div key={`${p}-${i}`} className="flex-1 min-w-0 flex items-center justify-center gap-2 select-none">
              {url && <img src={url} alt="" draggable={false} className={isMonoLogo(p) ? 'logo-mono' : ''} style={{ width: 30, height: 30, objectFit: 'contain', opacity: 0.3 }} />}
              <div className="font-mono leading-none font-semibold" style={{ fontSize: 15, color: t.ink, opacity: 0.28 }}>{pct}%</div>
            </div>
          )
        }
        return (
          <div key={`${p}-${i}`} className={`flex-1 min-w-0 flex flex-col items-center gap-1 select-none ${align === 'start' ? 'justify-start pt-1' : 'justify-center'}`}>
            {url && <img src={url} alt="" draggable={false} className={isMonoLogo(p) ? 'logo-mono' : ''} style={{ width: logo, height: logo, objectFit: 'contain', opacity: 0.26 }} />}
            <div className="font-mono leading-none font-semibold" style={{ fontSize: n > 6 ? 14 : 20, color: t.ink, opacity: 0.22 }}>{pct}%</div>
            {model && model.startsWith('muse-') && <div className="whitespace-nowrap font-semibold" style={{ fontSize: n > 6 ? 9 : 11, color: t.ink, opacity: 0.45 }}>{museLabel(model)}</div>}
            <div className="uppercase tracking-[0.2em] whitespace-nowrap" style={{ fontSize: n > 6 ? 7 : 9, color: t.ink, opacity: 0.35 }}>{count} de {total}</div>
          </div>
        )
      })}
    </div>
  )
}

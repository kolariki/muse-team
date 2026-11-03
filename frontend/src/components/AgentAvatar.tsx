import { avatarSrc, roleKey, useAvatars } from '../lib/avatar'
import ProviderLogo from './ProviderLogo'

/**
 * Each role is a person: an editorial portrait per role (public/avatars/<role>.webp, generated once for Muse Team), with the
 * provider's mark as a small badge on the corner. Custom roles are matched by name; anything else gets the neutral one.
 */
const ROLES = new Set([
  'ceo', 'cto', 'coo', 'cfo', 'cpo', 'founder', 'product-manager', 'product-owner', 'ux-researcher', 'growth', 'head-engineering', 'tech-lead',
  'backend', 'frontend', 'mobile', 'devops', 'ai-engineer', 'data-engineer', 'data-scientist', 'product-designer', 'brand', 'qa', 'security',
  'legal', 'sales', 'customer-support', 'investor', 'devils-advocate', 'end-user', 'philosopher', 'scientist', 'custom',
])
const BY_NAME: [RegExp, string][] = [
  [/\bceo\b/, 'ceo'], [/\bcto\b/, 'cto'], [/\bcoo\b/, 'coo'], [/\bcfo\b/, 'cfo'], [/\bcpo\b/, 'cpo'], [/founder|fundador/, 'founder'],
  [/head of eng|head eng|ingenier[ií]a/, 'head-engineering'], [/tech lead|l[ií]der t[eé]cnico/, 'tech-lead'], [/product owner/, 'product-owner'],
  [/product|producto|\bpm\b/, 'product-manager'], [/dise[nñ]|design|ux|ui\b/, 'product-designer'], [/research/, 'ux-researcher'],
  [/growth|marketing/, 'growth'], [/brand|marca|content|contenido/, 'brand'], [/back/, 'backend'], [/front/, 'frontend'], [/mobile|m[oó]vil/, 'mobile'],
  [/devops|platform|infra/, 'devops'], [/\bai\b|\bia\b|ml\b/, 'ai-engineer'], [/data sci|cient[ií]fic. de datos/, 'data-scientist'], [/data|datos/, 'data-engineer'],
  [/\bqa\b|test|calidad/, 'qa'], [/secur|seguridad/, 'security'], [/legal|compliance/, 'legal'], [/sales|ventas/, 'sales'], [/support|soporte/, 'customer-support'],
  [/invest|inversor/, 'investor'], [/devil|diablo/, 'devils-advocate'], [/user|usuario/, 'end-user'], [/fil[oó]sof|ethic|[eé]tic/, 'philosopher'], [/scien|cient/, 'scientist'],
]

export function avatarRole(agent?: { name?: string; role?: string | null } | null): string {
  if (agent?.role && ROLES.has(agent.role)) return agent.role
  const n = (agent?.name ?? '').toLowerCase()
  return BY_NAME.find(([rx]) => rx.test(n))?.[1] ?? 'custom'
}

export function avatarUri(agent?: { name?: string; role?: string | null } | null): string {
  return `${import.meta.env.BASE_URL}avatars/${avatarRole(agent)}.webp`
}

export default function AgentAvatar({ agent, size = 40, className = '', ring = true, logo: logoRatio = 0.24, chip = false }: { agent?: { name?: string; role?: string | null; provider?: string | null; wanted_provider?: string | null; color?: string | null } | null; size?: number; className?: string; ring?: boolean; logo?: number; chip?: boolean }) {
  const provider = agent?.wanted_provider ?? agent?.provider ?? undefined
  // the face the user designed for this employee (Mi equipo), else the role's portrait
  const designed = useAvatars((st) => (agent ? st.byKey[roleKey(agent.role, agent.name)] : undefined))
  const badge = Math.max(14, Math.round(size * Math.min(0.3, logoRatio + 0.04)))
  return (
    <span className={`relative inline-block shrink-0 ${className}`} style={{ width: size, height: size }} aria-hidden>
      <span className={`block h-full w-full overflow-hidden rounded-full bg-[#EEF1EC] ${ring ? 'ring-1 ring-black/10' : ''}`}>
        <img src={designed ? avatarSrc(designed) : avatarUri(agent)} alt="" width={size} height={size} loading="lazy" draggable={false} className="block h-full w-full select-none object-cover" />
      </span>
      {provider && (
        <span
          className={`absolute flex items-center justify-center rounded-full bg-white ring-1 ring-black/10 ${chip ? 'shadow-[0_1px_3px_rgba(0,0,0,.25)]' : 'shadow-sm'}`}
          style={{ right: Math.round(size * 0.02), bottom: Math.round(size * 0.02), width: badge, height: badge }}
        >
          <ProviderLogo provider={provider} size={Math.round(badge * 0.62)} />
        </span>
      )}
    </span>
  )
}

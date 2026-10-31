import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { brandTheme } from '../lib/brand'
import { museLabel } from '../lib/muse'
import ProviderLogo from './ProviderLogo'
import { useT } from '../lib/i18n'

export interface IntroCompany {
  provider: string
  label: string
  roles: string[]
  key?: string
  count: number
  total: number
}

/** The companies in a team, grouped by provider, with their share and the roles each one plays. */
export function introTeam(agents: { provider: string; wanted_provider?: string; model?: string; name: string; roleLabel?: string }[], labelOf: (p: string) => string): IntroCompany[] {
  const total = agents.length
  // one card per company, or per model when the company is Meta (Muse Wonder and Muse Spark are different seats)
  const keyOf = (a: { provider: string; wanted_provider?: string; model?: string }) => { const p = a.wanted_provider ?? a.provider; return p === 'meta' && a.model ? `${p}|${a.model}` : p }
  const order = [...new Set(agents.map(keyOf))]
  return order.map((k) => {
    const p = k.split('|')[0]
    const mine = agents.filter((a) => keyOf(a) === k)
    const model = mine[0]?.model
    return { key: k, provider: p, label: p === 'meta' && model ? museLabel(model) : labelOf(p), roles: mine.map((a) => a.roleLabel || a.name), count: mine.length, total }
  })
}

/* Choreography (seconds). The button uses the same clock so each logo leaving the button is the one appearing on stage. */
export const PLAY_OUT = 0.3 // the play icon slides out to the right
export const ICON_STEP = 0.22 // one logo leaves the button every ICON_STEP
export const iconExitAt = (i: number) => PLAY_OUT + i * ICON_STEP
const STAGE_HOLD = 5.0 // "Tu equipo" + "Entrando a la arena" + loading bar (a few seconds, so the team can be read)
const FADE = 0.7 // blur-out into the arena

/**
 * Transition between "Iniciar experimento" and the arena: the logos that leave the button appear big on screen one by one;
 * once they are all out the background dims, "Tu equipo" shows up, then "Entrando a la arena" with a loading bar in the
 * team's colours; finally everything blurs away and `onDone` fires.
 */
export default function ArenaIntro({ team, onDone }: { team: IntroCompany[]; onDone: () => void }) {
  const T = useT()
  const n = team.length
  const allOut = iconExitAt(n - 1) + 0.55 // the last logo has landed on stage
  const [dim, setDim] = useState(false)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const t1 = setTimeout(() => setDim(true), allOut * 1000)
    const t2 = setTimeout(() => setLeaving(true), (allOut + STAGE_HOLD) * 1000)
    const t3 = setTimeout(onDone, (allOut + STAGE_HOLD + FADE) * 1000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onDone, allOut])
  const accents = team.map((c) => brandTheme(c.provider).accent)
  const barGradient = n === 1 ? accents[0] : `linear-gradient(90deg, ${accents.join(', ')})`
  const bandStops = team.map((c, i) => `${brandTheme(c.provider).tint} ${(((i + 0.5) / n) * 100).toFixed(2)}%`).join(', ')
  const logo = n <= 4 ? 96 : n <= 6 ? 72 : 56
  return (
    <motion.div
      className="fixed inset-0 z-[120] flex flex-col items-center justify-center overflow-hidden"
      initial={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
      animate={leaving ? { opacity: 0, filter: 'blur(18px)', scale: 1.06 } : { opacity: 1, filter: 'blur(0px)', scale: 1 }}
      transition={{ duration: FADE, ease: 'easeInOut' }}
    >
      {/* backdrop: the team's bands, dimmed in only once every logo is on stage */}
      <motion.div
        aria-hidden
        className="absolute inset-0"
        style={{ background: n === 1 ? brandTheme(team[0].provider).tint : `linear-gradient(90deg, ${bandStops})` }}
        initial={{ opacity: 0 }}
        animate={{ opacity: dim ? 1 : 0 }}
        transition={{ duration: 0.6 }}
      />
      <motion.div aria-hidden className="absolute inset-0 bg-paper/40 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: dim ? 1 : 0 }} transition={{ duration: 0.6 }} />

      <motion.div
        className="relative font-serif text-4xl text-ink"
        initial={{ opacity: 0, y: 10 }}
        animate={dim ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
        transition={{ duration: 0.5, delay: dim ? 0.2 : 0 }}
      >
        {T('Tu equipo', 'Your team')}
      </motion.div>

      {/* each company arrives from the right, in the same order and at the same moment its logo leaves the button */}
      <div className="relative mt-8 flex items-stretch justify-center gap-4 px-6">
        {team.map((c, i) => {
          const t = brandTheme(c.provider)
          return (
            <motion.div
              key={c.key ?? c.provider}
              className="flex w-[180px] min-h-[270px] flex-col items-center rounded-2xl border px-3 py-4 text-center shadow-md"
              style={{ background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)', borderColor: t.border }}
              initial={{ opacity: 0, x: 140, scale: 0.6, filter: 'blur(6px)' }}
              animate={{ opacity: 1, x: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ type: 'spring', stiffness: 160, damping: 18, delay: iconExitAt(i) + 0.12 }}
            >
              <ProviderLogo provider={c.provider} size={logo} />
              <div className="mt-2 text-sm font-semibold" style={{ color: t.ink }}>{c.label}</div>
              <div className="mt-1 font-mono text-2xl font-bold leading-none" style={{ color: t.accent }}>{Math.round((c.count / c.total) * 100)}%</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3">{c.count} {T('de', 'of')} {c.total}</div>
              <ul className="mt-2 space-y-0.5 text-[12px] text-ink-2">
                {c.roles.map((r, j) => (
                  <motion.li key={j} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: iconExitAt(i) + 0.4 + j * 0.08 }}>{r}</motion.li>
                ))}
              </ul>
            </motion.div>
          )
        })}
      </div>

      {/* legend + loading bar in the team's colours, after the background dims */}
      <motion.div
        className="relative mt-10 flex flex-col items-center"
        initial={{ opacity: 0, y: 10 }}
        animate={dim ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
        transition={{ duration: 0.5, delay: dim ? 0.45 : 0 }}
      >
        <div className="text-lg text-ink-2">
          {T('Reuniendo el equipo', 'Gathering the team')}<motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1.1 }}>…</motion.span>
        </div>
        <div className="mt-3 h-[5px] w-72 overflow-hidden rounded-full bg-black/10">
          <motion.div
            className="h-full rounded-full"
            style={{ background: barGradient }}
            initial={{ width: '0%' }}
            animate={dim ? { width: '100%' } : { width: '0%' }}
            transition={{ duration: Math.max(0.8, STAGE_HOLD - 0.7), delay: dim ? 0.5 : 0, ease: 'easeInOut' }}
          />
        </div>
      </motion.div>
    </motion.div>
  )
}

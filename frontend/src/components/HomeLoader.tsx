import { motion } from 'framer-motion'
import { useT } from '../lib/i18n'

/** The Muse Team loader: the mark breathing inside a ring that sweeps around it. Only Muse Team, no other logos. */
export function Orbit({ size = 92, logo = 80 }: { size?: number; logo?: number }) {
  const box = size * 2 + 24
  return (
    <div className="relative" style={{ width: box, height: box }}>
      <span className="absolute inset-0 rounded-full bg-accent/10 blur-2xl" aria-hidden />
      <span className="absolute inset-[18%] rounded-full border border-line" aria-hidden />
      <motion.span className="absolute inset-[18%] rounded-full" aria-hidden animate={{ rotate: 360 }} transition={{ duration: 1.4, ease: 'linear', repeat: Infinity }}
        style={{ background: 'conic-gradient(from 0deg, transparent 0deg, var(--color-accent) 300deg, transparent 360deg)', WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))', mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))' }} />
      <motion.div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 1.6, ease: 'easeInOut', repeat: Infinity }}>
        <img src="/icon.svg?v=3" alt="" aria-hidden style={{ width: logo, height: logo }} className="rounded-[24%] shadow-[0_18px_40px_-14px_rgba(0,100,224,.45)]" draggable={false} />
      </motion.div>
    </div>
  )
}

/** A panel is working (analysing a project, starting a server…): the orbit, smaller, with a caption, inline. */
export function PanelLoader({ caption, sub }: { caption: string; sub?: string }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center text-center">
      <Orbit size={64} logo={56} />
      <div className="mt-5 text-[14px] font-semibold text-ink">{caption}</div>
      {sub && <div className="mt-1 max-w-sm text-[12.5px] leading-snug text-ink-3">{sub}</div>}
    </div>
  )
}

/** The home is loading (providers, experiments, projects): the Muse Team loader over the whole screen. */
export default function HomeLoader({ caption }: { caption?: string } = {}) {
  const T = useT()
  return (
    <motion.div data-loader initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.25 } }} className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-paper arena-bg">
      <Orbit size={78} logo={84} />
      <div className="serif mt-8 text-2xl">Muse <em className="text-accent">Team</em></div>
      <div className="mt-1.5 text-[13px] text-ink-3">{caption ?? T('Reuniendo a tu equipo…', 'Gathering your team…')}</div>
    </motion.div>
  )
}

/** A section is loading: the Muse Team loader in the content area, under the sidebar. */
export function PageLoader({ caption }: { caption?: string }) {
  return (
    <div data-loader className="flex min-h-[70vh] w-full flex-col items-center justify-center text-center">
      <Orbit size={64} logo={64} />
      <div className="serif mt-6 text-[22px]">Muse <em className="text-accent">Team</em></div>
      {caption && <div className="mt-1 text-[13px] text-ink-3">{caption}</div>}
    </div>
  )
}

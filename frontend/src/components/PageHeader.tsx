import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../lib/i18n'

/** Top of the secondary pages (settings, audit): the brand mark that goes back (on a phone; from a tablet up it is in the side bar), a kicker, the title, and a right slot. */
export default function PageHeader({ onBack, kicker, title, subtitle, right }: { onBack: () => void; kicker: string; title: string; subtitle?: string; right?: ReactNode }) {
  const T = useT()
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-3 rounded-lg transition hover:opacity-80 md:hidden" title={T('Volver al inicio', 'Back to the home')}>
          <img src="/icon.svg?v=3" alt="" aria-hidden className="h-9 w-9 rounded-xl shadow-sm" draggable={false} />
          <span className="serif hidden whitespace-nowrap text-xl sm:inline">Muse <em className="text-accent">Team</em></span>
        </button>
        <button type="button" onClick={onBack} className="ml-2 flex h-9 items-center gap-1.5 md:ml-0 rounded-full border border-line bg-surface px-3 text-sm text-ink-2 shadow-sm transition hover:bg-accent-soft hover:border-accent hover:text-accent"><ArrowLeft size={15} /> {T('Volver', 'Back')}</button>
        {right && <div className="ml-auto whitespace-nowrap">{right}</div>}
      </div>
      <div className="mt-5 sm:mt-8">
        <div className="text-xs uppercase tracking-[0.4em] text-accent">{kicker}</div>
        <h1 className="mt-1 text-[34px] leading-tight sm:text-5xl">{title}</h1>
        {subtitle && <p className="mt-3 w-full text-[15px] leading-relaxed text-ink-2">{subtitle}</p>}
      </div>
    </div>
  )
}

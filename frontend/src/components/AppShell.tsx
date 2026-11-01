import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Clapperboard, FolderOpen, Gavel, Home, LayoutGrid, LogOut, Medal, MessagesSquare, Settings2, Store, Ticket, Users, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { User } from '../lib/api'
import { TICKETS_ENABLED } from '../lib/flags'
import { setLang, useLang, useT } from '../lib/i18n'
import { loadMyPhoto, useMyPhoto } from '../lib/myPhoto'
import { useArena } from '../store'
import { openTeam } from './TeamMemory'
import ThemeSwitch from './ThemeSwitch'

type View = ReturnType<typeof useArena.getState>['view']
type Item = { id: string; icon: ReactNode; es: string; en: string; view?: View; go: () => void; hint_es: string; hint_en: string }

const go = (view: View) => () => useArena.getState().set({ view })
/** «Mis proyectos» is the list on the home: open the home and scroll to it. */
const toProjects = () => {
  useArena.getState().set({ view: 'setup' })
  let tries = 0
  const scroll = () => {
    const el = document.getElementById('projects')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    else if (tries++ < 20) window.setTimeout(scroll, 150)
  }
  window.setTimeout(scroll, 60)
}

function groups(): { es: string; en: string; items: Item[] }[] {
  return [
    { es: 'Construir', en: 'Build', items: [
      { id: 'home', icon: <Home size={18} />, es: 'Inicio', en: 'Home', view: 'setup', go: go('setup'), hint_es: 'Tu tablero: la idea nueva, tus proyectos y cómo vienen', hint_en: 'Your dashboard: a new idea, your projects and how they are doing' },
      { id: 'projects', icon: <FolderOpen size={18} />, es: 'Mis proyectos', en: 'My projects', go: toProjects, hint_es: 'Cada proyecto con su nivel y el próximo paso', hint_en: 'Every project with its level and the next step' },
      { id: 'audit', icon: <Gavel size={18} />, es: 'Auditar', en: 'Audit', view: 'audit', go: go('audit'), hint_es: 'Subí un proyecto existente y el equipo lo revisa desde cada rol', hint_en: 'Upload an existing project and the team reviews it from every role' },
      { id: 'agents', icon: <MessagesSquare size={18} />, es: 'Mis sesiones', en: 'My sessions', view: 'agents', go: go('agents'), hint_es: 'Tus conversaciones de Muse Code', hint_en: 'Your Muse Code conversations' },
      ...(TICKETS_ENABLED ? [{ id: 'tickets', icon: <Ticket size={18} />, es: 'Tickets', en: 'Tickets', view: 'tickets' as View, go: go('tickets'), hint_es: 'Tus tickets de Notion: el equipo los resuelve', hint_en: 'Your Notion tickets: the team resolves them' }] : []),
    ] },
    { es: 'Crecer', en: 'Grow', items: [
      { id: 'analytics', icon: <BarChart3 size={18} />, es: 'Analíticas', en: 'Analytics', view: 'analytics', go: go('analytics'), hint_es: 'Visitas, eventos y errores reales de tus apps publicadas', hint_en: 'Real visits, events and errors of your published apps' },
      { id: 'studio', icon: <Clapperboard size={18} />, es: 'Crear anuncio', en: 'Create ad', view: 'studio', go: go('studio'), hint_es: 'Subí videos e imágenes y el equipo arma un anuncio listo para Meta', hint_en: 'Upload videos and images and the team makes an ad ready for Meta' },
      { id: 'adtier', icon: <Medal size={18} />, es: 'AdTier', en: 'AdTier', view: 'adtier', go: go('adtier'), hint_es: 'Reels y anuncios que te sirven, rankeados, con su plantilla', hint_en: 'Reels and ads that fit you, ranked, with their template' },
      { id: 'market', icon: <Store size={18} />, es: 'Marketplace', en: 'Marketplace', view: 'market', go: go('market'), hint_es: 'Apps hechas con Tably en venta', hint_en: 'Apps built with Tably for sale' },
    ] },
    { es: 'Equipo', en: 'Team', items: [
      { id: 'team', icon: <Users size={18} />, es: 'Mi equipo', en: 'My team', view: 'team', go: () => openTeam(), hint_es: 'Tus roles: su conocimiento, lo que aprendieron y su puntaje', hint_en: 'Your roles: their knowledge, what they learned and their score' },
      { id: 'settings', icon: <Settings2 size={18} />, es: 'Modelos y claves', en: 'Models and keys', view: 'settings', go: go('settings'), hint_es: 'Conectá tus IAs, modelos por defecto, deploy y trazas', hint_en: 'Connect your AIs, default models, deploy and tracing' },
    ] },
  ]
}

/** The app around every page of the home: the sections on the left (icons only on a tablet), a tab bar at the bottom on a phone. */
export default function AppShell({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
  const T = useT()
  const view = useArena((s) => s.view)
  const [more, setMore] = useState(false)
  const photo = useMyPhoto((s) => s.url)
  useEffect(() => { loadMyPhoto() }, [])
  useEffect(() => { setMore(false) }, [view])
  const gs = groups()
  const all = gs.flatMap((g) => g.items)
  const active = (it: Item) => !!it.view && it.view === view
  const avatar = photo ? <img src={photo} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" /> : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold uppercase text-white">{user.name.slice(0, 1)}</span>
  const tabs = ['home', 'projects', 'studio', 'adtier'].map((id) => all.find((x) => x.id === id)!)

  return (
    <div className="flex h-full w-full">
      <aside className="hidden h-full shrink-0 flex-col border-r border-line bg-surface/80 backdrop-blur md:flex md:w-[68px] lg:w-[232px]">
        <button onClick={go('setup')} className="flex h-16 shrink-0 items-center gap-2.5 px-4 lg:px-5" aria-label={T('Inicio', 'Home')}>
          <img src="/icon.svg" alt="" aria-hidden className="h-9 w-9 shrink-0 rounded-xl shadow-sm" draggable={false} />
          <span className="serif hidden text-xl lg:inline">Tably <em className="text-accent">Team</em></span>
        </button>
        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5 pb-3 scroll-thin lg:px-3">
          {gs.map((g) => (
            <div key={g.es}>
              <div className="mb-1 hidden px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-ink-4 lg:block">{T(g.es, g.en)}</div>
              <div className="flex flex-col gap-0.5">
                {g.items.map((it) => (
                  <button key={it.id} onClick={it.go} title={T(it.hint_es, it.hint_en)} aria-label={T(it.es, it.en)} aria-current={active(it) ? 'page' : undefined}
                    className={`flex h-10 items-center gap-3 rounded-xl px-3 text-[13.5px] transition md:justify-center lg:justify-start ${active(it) ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
                    <span className="shrink-0">{it.icon}</span><span className="hidden truncate lg:inline">{T(it.es, it.en)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2.5 lg:p-3">
          <div className="hidden items-center gap-2 lg:flex"><ThemeSwitch /><Lang /></div>
          <div className="flex items-center gap-2 rounded-xl px-1 py-1 md:justify-center lg:justify-start">
            {avatar}
            <span className="hidden min-w-0 flex-1 truncate text-[13px] font-medium text-ink lg:block">{user.name}</span>
            <button onClick={onLogout} className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition hover:bg-danger/10 hover:text-danger lg:flex" title={T('Cerrar sesión', 'Log out')} aria-label={T('Cerrar sesión', 'Log out')}><LogOut size={15} /></button>
          </div>
        </div>
      </aside>

      <main className="relative h-full min-w-0 flex-1 pb-[64px] md:pb-0">{children}</main>

      {/* phone: the four places people go most, and «Más» for the rest */}
      <nav className="fixed inset-x-0 bottom-0 z-[70] flex h-[64px] items-stretch border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {tabs.map((it) => (
          <button key={it.id} onClick={it.go} aria-current={active(it) ? 'page' : undefined} className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] ${active(it) ? 'font-semibold text-accent' : 'text-ink-3'}`}>
            {it.icon}<span className="max-w-full truncate px-1">{T(it.es, it.en)}</span>
          </button>
        ))}
        <button onClick={() => setMore(true)} className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] ${!tabs.some(active) && view !== 'setup' ? 'font-semibold text-accent' : 'text-ink-3'}`}>
          <LayoutGrid size={18} /><span>{T('Más', 'More')}</span>
        </button>
      </nav>
      <AnimatePresence>
        {more && (
          <motion.div className="fixed inset-0 z-[80] flex items-end bg-black/50 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMore(false)}>
            <motion.div initial={{ y: 40 }} animate={{ y: 0 }} exit={{ y: 40 }} onClick={(e) => e.stopPropagation()} className="max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl border-t border-line bg-paper p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <div className="flex items-center gap-2.5">
                {avatar}<span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{user.name}</span>
                <button onClick={() => setMore(false)} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink-2" aria-label={T('Cerrar', 'Close')}><X size={16} /></button>
              </div>
              {gs.map((g) => (
                <div key={g.es} className="mt-4">
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-ink-4">{T(g.es, g.en)}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {g.items.map((it) => (
                      <button key={it.id} onClick={() => { setMore(false); it.go() }} className={`flex items-center gap-2.5 rounded-xl border px-3 py-3 text-left text-[13.5px] ${active(it) ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface text-ink-2'}`}>
                        {it.icon}<span className="truncate">{T(it.es, it.en)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <ThemeSwitch /><Lang />
                <button onClick={onLogout} className="ml-auto flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-danger"><LogOut size={15} /> {T('Cerrar sesión', 'Log out')}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Lang() {
  const lang = useLang()
  return (
    <div className="flex h-10 items-center rounded-full border border-line bg-surface p-1 text-[12px] font-semibold shadow-sm" title="Idioma / Language">
      {(['es', 'en'] as const).map((l) => (
        <button key={l} onClick={() => setLang(l)} className={`h-8 rounded-full px-3 uppercase transition ${lang === l ? 'bg-accent text-white shadow-sm' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}>{l}</button>
      ))}
    </div>
  )
}

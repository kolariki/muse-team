import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, Eye, Mail, Store, Trophy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type MarketListing } from '../lib/api'
import { useT } from '../lib/i18n'
import { useArena } from '../store'
import { LEVEL_COLORS } from './LevelsPanel'
import HomeLoader from './HomeLoader'
import PageHeader from './PageHeader'

/** Every app for sale on Muse Team: level, public URL, real visits, pitch and price. Buyers write to the owner; the owner transfers from the builder. */
export default function Marketplace({ onBack }: { onBack: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [data, setData] = useState<{ listings: MarketListing[]; levels: { n: number; label: string; label_en: string; goal: string; goal_en: string }[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api.market().then(setData).catch((e) => setErr((e as Error).message)) }, [])

  return (
    <div className="min-h-full bg-paper">
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader
          onBack={onBack}
          kicker={T('Apps en venta', 'Apps for sale')}
          title="Marketplace"
          subtitle={T('Apps construidas con Muse Team, en línea y con visitas reales. Cada una muestra el nivel que alcanzó.', 'Apps built with Muse Team, live and with real visits. Each one shows the level it reached.')}
          right={<span className="flex items-center gap-1.5 text-[12px] text-ink-3"><Store size={14} className="text-accent" /> {T('nivel 1 o más', 'level 1 or more')}</span>}
        />
        {data && (
          <div data-tour="market" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {data.levels.map((l) => (
              <div key={l.n} className="rounded-xl border px-3 py-2" style={{ borderColor: `${LEVEL_COLORS[l.n]}55`, background: `${LEVEL_COLORS[l.n]}10` }}>
                <div className="flex items-center gap-1 text-[11px] font-bold" style={{ color: LEVEL_COLORS[l.n] }}><Trophy size={11} /> {T('Nivel', 'Level')} {l.n} · {en ? l.label_en : l.label}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-2">{en ? l.goal_en : l.goal}</div>
              </div>
            ))}
          </div>
        )}
        {err && <div className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{err}</div>}
        <AnimatePresence>{!data && !err && <HomeLoader key="loader" caption={T('Abriendo el marketplace…', 'Opening the marketplace…')} />}</AnimatePresence>
        {data && data.listings.length === 0 && (
          <div data-tour="market-list" className="mt-10 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-sm text-ink-2">
            {T('Todavía no hay apps en venta. La primera que llegue al nivel 1 aparece acá.', 'No apps for sale yet. The first one to reach level 1 shows up here.')}
          </div>
        )}
        {data && data.listings.length > 0 && (
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {data.listings.map((l, i) => {
              const color = LEVEL_COLORS[Math.min(l.level, LEVEL_COLORS.length - 1)]
              return (
                <motion.div key={l.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04 }} className="panel relative overflow-hidden rounded-2xl p-4">
                  <div className="absolute inset-x-0 top-0 h-1" style={{ background: color }} />
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-semibold text-ink">{l.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold" style={{ background: `${color}18`, color }}><Trophy size={10} /> {T('Nivel', 'Level')} {l.level}</span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-ink-2"><Eye size={10} /> {l.visits ?? 0} {T('visitas', 'visits')} · {l.visits_7d ?? 0} / 7d</span>
                        {l.mine && <span className="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent">{T('tuya', 'yours')}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-lg font-semibold text-ink">{l.price_usd != null ? `USD ${l.price_usd}` : T('a convenir', 'negotiable')}</div>
                      {l.owner && <div className="text-[11px] text-ink-3">{T('de', 'by')} {l.owner}</div>}
                    </div>
                  </div>
                  {l.pitch && <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{l.pitch}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {l.url && <a href={l.url} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2 transition hover:border-accent hover:text-accent"><ExternalLink size={12} /> {T('Abrir la app', 'Open the app')}</a>}
                    {l.mine && l.session_id && l.build_id ? (
                      <button onClick={() => useArena.getState().set({ pendingBuild: { buildId: l.build_id!, sessionId: l.session_id! } })} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-white transition hover:brightness-110">{T('Gestionar', 'Manage')}</button>
                    ) : l.owner_email ? (
                      <a href={`mailto:${l.owner_email}?subject=${encodeURIComponent(`Muse Team Marketplace · ${l.title}`)}`} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-white transition hover:brightness-110"><Mail size={12} /> {T('Hacer una oferta', 'Make an offer')}</a>
                    ) : null}
                  </div>
                </motion.div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

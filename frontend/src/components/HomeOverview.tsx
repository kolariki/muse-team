import { ArrowRight, BarChart3, Clapperboard, Loader2, Medal, Play } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api, type AnalyticsApp, type AdTierCard, type FdePackage, type FdeRequest, type StripeStatus, type StudioProject } from '../lib/api'
import { downloadFdeTicket, fdeAwaitsPayment, fdeLink, fdeStatus, fdeStatusTone, fdeUnit, payFde } from '../lib/fde'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { toast } from './Toast'

/** The home's dashboard cards: this week's visits, the latest ads, reels picked for the person's business and what they asked our developers. */
export default function HomeOverview({ onOpenProject }: { onOpenProject: (sessionId: string) => void }) {
  const T = useT()
  const [apps, setApps] = useState<AnalyticsApp[] | null>(null)
  const [ads, setAds] = useState<StudioProject[] | null>(null)
  const [reels, setReels] = useState<{ name: string; items: AdTierCard[] } | null | undefined>(undefined)
  useEffect(() => {
    api.analytics().then((d) => setApps(d.apps)).catch(() => setApps([]))
    api.studioList().then((d) => setAds(d.projects)).catch(() => setAds([]))
    api.foryou().then(async (h) => {
      const p = h.profiles[0]
      if (!p) return setReels(null)
      const m = await api.foryouGet(p.id)
      const found = m.found.filter((v) => v.thumbnail_url && v.stage !== 'error')
      setReels({ name: p.name, items: [...found, ...m.catalog].slice(0, 4) })
    }).catch(() => setReels(null))
  }, [])
  const go = (view: 'analytics' | 'studio' | 'adtier') => () => useArena.getState().set({ view })

  // the last 7 days of every published app, added up
  const days = new Map<string, number>()
  for (const a of apps ?? []) for (const d of a.stats.days) days.set(d.day, (days.get(d.day) ?? 0) + d.n)
  const week = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-7)
  const total = week.reduce((n, [, v]) => n + v, 0)
  const live = (apps ?? []).reduce((n, a) => n + a.stats.live, 0)
  const max = Math.max(1, ...week.map(([, v]) => v))
  const STATUS: Record<string, [string, string]> = { draft: ['borrador', 'draft'], running: ['armándose', 'in progress'], done: ['listo', 'ready'], error: ['falló', 'failed'], stopped: ['frenado', 'stopped'] }

  return (
    <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <Card icon={<BarChart3 size={15} />} title={T('Visitas de la semana', 'Visits this week')} action={T('Ver analíticas', 'See analytics')} onAction={go('analytics')}>
        {!apps ? <Wait /> : apps.length === 0 ? (
          <Empty text={T('Cuando publiques una app, acá ves cuánta gente entra.', 'Once you publish an app, you see here how many people come in.')} />
        ) : (
          <>
            <div className="flex items-end gap-3">
              <span className="font-mono text-[32px] font-bold leading-none text-ink">{total.toLocaleString()}</span>
              <span className="mb-1 text-[12px] text-ink-3">{apps.length} {apps.length === 1 ? T('app publicada', 'published app') : T('apps publicadas', 'published apps')}{live ? ` · ${live} ${T('ahora', 'now')}` : ''}</span>
            </div>
            <div className="mt-3 flex h-14 items-end gap-1">
              {week.map(([d, v]) => <div key={d} title={`${d}: ${v}`} className="flex-1 rounded-t-[3px] bg-[#0082FB]" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />)}
            </div>
          </>
        )}
      </Card>

      <Card icon={<Clapperboard size={15} />} title={T('Tus anuncios', 'Your ads')} action={T('Crear anuncio', 'Create ad')} onAction={go('studio')}>
        {!ads ? <Wait /> : ads.length === 0 ? (
          <Empty text={T('Subí un video o fotos y el equipo arma un reel listo para Meta.', 'Upload a video or photos and the team makes a reel ready for Meta.')} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {ads.slice(0, 3).map((p) => (
              <button key={p.id} onClick={go('studio')} className="flex items-center gap-2.5 rounded-lg border border-line bg-paper px-2.5 py-2 text-left transition hover:border-accent">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink text-paper"><Play size={13} /></span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{p.title || T('Anuncio sin título', 'Untitled ad')}</span>
                <span className={`shrink-0 text-[11px] ${p.status === 'error' ? 'text-danger' : p.status === 'done' ? 'text-accent' : 'text-ink-3'}`}>{T(...(STATUS[p.status] ?? [p.status, p.status]))}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card icon={<Medal size={15} />} title={reels ? T(`Reels para ${reels.name}`, `Reels for ${reels.name}`) : T('Reels para tu negocio', 'Reels for your business')} action={reels ? T('Ver en AdTier', 'See in AdTier') : T('Armar mi perfil', 'Build my profile')} onAction={go('adtier')} className="md:col-span-2 xl:col-span-1">
        {reels === undefined ? <Wait /> : !reels || !reels.items.length ? (
          <Empty text={reels ? T('Estamos buscando reels de tu rubro: aparecen acá cuando estén analizados.', 'We are finding reels from your sector: they show up here once analysed.') : T('Contanos a qué se dedica tu negocio y te mostramos reels y anuncios que te sirven de ejemplo.', 'Tell us what your business does and we show you reels and ads to use as examples.')} />
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {reels.items.map((v) => (
              <button key={v.id} onClick={go('adtier')} title={v.title} className="relative aspect-[9/14] overflow-hidden rounded-lg bg-black">
                {v.thumbnail_url && <img src={v.thumbnail_url} alt="" loading="lazy" className="h-full w-full object-cover opacity-90 transition hover:scale-105" />}
                {v.duration_s ? <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[9.5px] font-semibold text-white">{Math.round(v.duration_s)} s</span> : null}
              </button>
            ))}
          </div>
        )}
      </Card>

      <MyRequests onOpenProject={onOpenProject} />
    </div>
  )
}

const REQUESTS_SHOWN = 5
/** The Payment Links send people back to ?pedido=pagado; read once, at load, so it survives whatever cleans the address after that. */
let backFromPayment = new URLSearchParams(location.search).get('pedido') === 'pagado'

/** Everything asked of our developers, on any project, with the step each one is waiting for one click away. */
function MyRequests({ onOpenProject }: { onOpenProject: (sessionId: string) => void }) {
  const T = useT()
  const [items, setItems] = useState<FdeRequest[] | null>(null)
  const [packages, setPackages] = useState<FdePackage[]>([])
  const [stripe, setStripe] = useState<StripeStatus | null>(null)
  const [all, setAll] = useState(false)
  const [paying, setPaying] = useState<string | null>(null)
  useEffect(() => {
    api.fdeRequests().then(setItems).catch(() => setItems([]))
    api.fdePackages().then((d) => { setPackages(d.packages); setStripe(d.stripe) }).catch(() => {})
  }, [])
  // back from Stripe: its notice confirms the payment, usually within seconds, and the request turns paid here
  useEffect(() => {
    if (!backFromPayment) return
    backFromPayment = false
    history.replaceState(null, '', location.pathname + location.hash)
    let tries = 0
    const t = setInterval(async () => {
      const list = await api.fdeRequests().catch(() => null)
      if (list) setItems(list)
      const paid = !!list?.some((r) => r.status === 'paid' && Date.now() / 1000 - r.updated < 600)
      if (!paid && ++tries < 12) return
      clearInterval(t)
      if (paid) toast.ok(tr('Pago confirmado', 'Payment confirmed'), tr('Tu pedido ya le llegó al developer.', 'Your request has reached the developer.'))
      else toast.info(tr('Estamos confirmando tu pago', 'We are confirming your payment'), tr('Apenas entre, el pedido pasa a «Pagado» y le llega al developer.', 'As soon as it comes in, the request turns «Paid» and reaches the developer.'))
    }, 2500)
  }, [])
  const status = fdeStatus()
  const more = (items?.length ?? 0) - REQUESTS_SHOWN
  const pay = async (r: FdeRequest, link: string | null) => {
    setPaying(r.id)
    try {
      await payFde(r, link)
    } catch (e) {
      toast.error(tr('No se pudo iniciar el pago', 'Could not start the payment'), (e as Error).message)
      setPaying(null)
    }
  }
  const small = 'flex h-7 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[11.5px] font-medium text-ink-2 transition hover:border-accent hover:text-accent'

  return (
    <Card className="md:col-span-2 xl:col-span-3" title={T('Mis pedidos', 'My requests')} action={more > 0 ? (all ? T('Ver menos', 'See less') : `${T('Ver todos', 'See all')} (${items!.length})`) : undefined} onAction={() => setAll((v) => !v)}>
      {!items ? <Wait /> : items.length === 0 ? (
        <Empty text={T('Cuando le pidas algo a un developer desde un proyecto, acá ves en qué estado está.', 'When you ask a developer for something from a project, you see its status here.')} />
      ) : (
        <div className="flex flex-col gap-1.5">
          {(all ? items : items.slice(0, REQUESTS_SHOWN)).map((r) => {
            const pkg = packages.find((p) => p.id === r.package)
            const link = fdeLink(stripe, r, pkg?.checkout_url)
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-paper px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-[240px]">
                  <div className="truncate text-[13px] font-semibold text-ink">{pkg?.name ?? r.package}</div>
                  <div className="truncate text-[11.5px] text-ink-3">{r.ticket.project.title} · {new Date(r.created * 1000).toLocaleDateString()}</div>
                </div>
                {pkg && <span className="shrink-0 text-[12.5px] tabular-nums text-ink-2">USD {pkg.price_usd} {fdeUnit(r.package)}</span>}
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium first-letter:uppercase ${fdeStatusTone(r.status)}`}>{status[r.status] ?? r.status}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {fdeAwaitsPayment(r.status) && (stripe?.enabled || link) && (
                    <button disabled={!!paying} onClick={() => pay(r, link)} className="flex h-7 items-center gap-1 rounded-full bg-accent px-2.5 text-[11.5px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40">
                      {paying === r.id ? '…' : T('Pagar', 'Pay')}
                    </button>
                  )}
                  <button onClick={() => downloadFdeTicket(r.id).catch((e) => toast.error(tr('No se pudo bajar el ticket', 'Could not download the ticket'), (e as Error).message))} className={small}>{T('Bajar ticket', 'Download ticket')}</button>
                  <button onClick={() => onOpenProject(r.session_id)} className={small}>{T('Abrir proyecto', 'Open project')}</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function Card({ icon, title, action, onAction, children, className = '' }: { icon?: ReactNode; title: string; action?: string; onAction: () => void; children: ReactNode; className?: string }) {
  return (
    <div className={`panel flex flex-col rounded-2xl p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        {icon && <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{title}</span>
        {action && <button onClick={onAction} className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-accent hover:underline">{action} {icon && <ArrowRight size={12} />}</button>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function Wait() {
  return <div className="flex h-16 items-center text-ink-3"><Loader2 size={15} className="animate-spin" /></div>
}

function Empty({ text }: { text: string }) {
  return <p className="text-[12.5px] leading-relaxed text-ink-3">{text}</p>
}

import { Warning as AlertTriangle, Brain, CheckCircle as CheckCircle2, FilmSlate as Clapperboard, ArrowSquareOut as ExternalLink, IconContext, Key as KeyRound, SquaresFour as LayoutGrid, LinkSimple as Link2, CircleNotch as Loader2, MegaphoneSimple as Megaphone, Pause, PencilSimple as Pencil, Play, ArrowsClockwise as RefreshCw, Sliders as SlidersHorizontal, ChartLineUp as Sparkles, Target, ThumbsUp, Trash as Trash2, TrendDown as TrendingDown, UsersThree as Users, Wallet } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api, type MetaAction, type MetaBrain, type MetaBrainAd } from '../lib/api'
import { getLang, tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { PageLoader } from './HomeLoader'
import MetaSetup from './MetaSetup'
import PageHeader from './PageHeader'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'

const CARD = 'rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'
const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-5 text-[14px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent'
const LABEL = 'block text-[11.5px] font-semibold uppercase tracking-wide text-ink-3'
type Assets = Awaited<ReturnType<typeof api.metaAdsAssets>>

const money = (n: number | null | undefined, cur = 'USD') => (n == null ? '—' : new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'es-AR', { style: 'currency', currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n))

/** Meta Ads: the user connects their ad account, Tably's model reads its numbers (what sells, to whom, where) and turns every
 *  finished «Crear anuncio» video into a ready ad, published paused with one tap. */
export default function MetaAdsPage({ onBack }: { onBack: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [b, setB] = useState<MetaBrain | null>(null)
  const [assets, setAssets] = useState<Assets | null>(null)
  const [assetsErr, setAssetsErr] = useState<string | null>(null)
  const [account, setAccount] = useState('')
  const [page, setPage] = useState('')
  const [setup, setSetup] = useState(false)

  const [failed, setFailed] = useState<string | null>(null)
  const load = () => api.metaBrain().then((x) => { setB(x); setFailed(null) }).catch((e) => setFailed((e as Error).message))
  useEffect(() => { load() }, [])
  // the window Meta opens tells us when the connection is done
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!e.data?.tablyMetaAds) return
      if (e.data.tablyMetaAds === 'ok') { toast.ok(tr('Meta Ads conectado', 'Meta Ads connected')); load() } else toast.error(tr('No se conectó Meta Ads', 'Meta Ads did not connect'), e.data.message)
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  const connected = !!b?.meta.connected && !b.meta.expired
  useEffect(() => {
    if (!connected) return
    api.metaAdsAssets().then((a) => {
      setAssets(a)
      setAccount((cur) => cur || b?.account_id || (a.accounts.find((x) => x.active) ?? a.accounts[0])?.id || '')
      setPage((cur) => cur || a.pages[0]?.id || '')
    }).catch((e) => setAssetsErr((e as Error).message))
  }, [connected]) // eslint-disable-line react-hooks/exhaustive-deps
  // while it reads or publishes, follow it
  const busy = b?.status === 'working' || !!b?.analysis?.ads.some((a) => a.meta?.status === 'publishing')
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') api.metaBrain().then(setB).catch(() => {}) }, 2500)
    return () => window.clearInterval(t)
  }, [busy])

  const connect = async () => {
    try {
      const { url } = await api.metaAdsStart()
      const w = window.open(url, 'tably-meta-ads', 'width=620,height=760')
      if (!w) location.href = url
    } catch (e) { toast.error(T('No se pudo conectar Meta Ads', 'Could not connect Meta Ads'), (e as Error).message) }
  }
  const analyze = async () => {
    try { setB(await api.metaBrainRun(account, en ? 'en' : 'es')) } catch (e) { toast.error(T('No se pudo analizar', 'Could not analyse'), (e as Error).message) }
  }
  const an = b?.analysis
  const cur = b?.account?.currency ?? 'USD'

  return (
    <IconContext.Provider value={{ weight: 'duotone' }}>
    <div className="min-h-full bg-paper">
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader onBack={onBack} kicker="Meta Ads" title={b && b.meta.open === false ? T('Próximamente: todos tus anuncios, en Tably', 'Coming soon: all your ads, in Tably') : T('Tu cuenta de Meta Ads, leída por la IA', 'Your Meta Ads account, read by the AI')}
          subtitle={b && b.meta.open === false ? T('Vas a poder manejar todos tus anuncios desde nuestra plataforma, con nuestra IA guiándote paso a paso.', 'You will be able to manage all your ads from our platform, with our AI guiding you step by step.') : T('Conectá tu cuenta publicitaria. Tably lee tus campañas, ve qué anuncios, públicos y ubicaciones te traen resultados al menor costo, y arma los anuncios nuevos con los videos que hiciste en «Crear anuncio», listos para publicar en pausa.', 'Connect your ad account. Tably reads your campaigns, sees which ads, audiences and placements bring results at the lowest cost, and builds new ads with the videos you made in «Create ad», ready to publish paused.')} />

        {!b ? (failed ? (
          <div className={`${CARD} mt-5 flex flex-wrap items-center gap-3 text-[13.5px] text-ink-2`}><AlertTriangle size={18} className="text-danger" /><span className="min-w-[min(100%,260px)] flex-1">{T('No pude leer Meta Ads', 'Could not read Meta Ads')}: {failed}</span><button onClick={load} className={PILL}><RefreshCw size={14} /> {T('Reintentar', 'Retry')}</button></div>
        ) : <PageLoader caption={T('Leyendo tu cuenta de Meta Ads…', 'Reading your Meta Ads account…')} />) : b.meta.open === false ? (
          <section className={`${CARD} relative mt-5 overflow-hidden !p-6 sm:!p-10`}>
            <img src="/logos/meta-ads.svg" alt="" aria-hidden draggable={false} className="pointer-events-none absolute right-[5%] top-3 hidden w-[300px] select-none opacity-[0.16] blur-[1px] lg:block" />
            <div className="relative">
              <span className="inline-flex rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-[12px] font-semibold text-accent">{T('Próximamente', 'Coming soon')}</span>
              <h2 className="mt-4 max-w-[760px] font-sans text-[26px] font-semibold leading-tight tracking-tight text-ink sm:text-[32px]">{T('Tu IA para vender más con tus anuncios', 'Your AI to sell more with your ads')}</h2>
              <p className="mt-3 max-w-[720px] text-[15px] leading-relaxed text-ink-2">{T('Conectá tu cuenta y manejá todo desde Tably. La IA lee tus resultados y te guía en cada decisión, sin que tengas que ser experto en publicidad.', 'Connect your account and manage everything from Tably. The AI reads your results and guides every decision, with no need to be an advertising expert.')}</p>
              <div className="mt-8 grid gap-x-8 gap-y-6 border-t border-line pt-6 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  [T('Todo en un solo lugar', 'Everything in one place'), T('Tus campañas, anuncios y resultados, sin saltar entre pantallas.', 'Your campaigns, ads and results, without jumping between screens.')],
                  [T('Qué mejorar', 'What to improve'), T('Recomendaciones claras para cada campaña, explicadas simple.', 'Clear recommendations for each campaign, explained simply.')],
                  [T('Cómo convertir', 'How to convert'), T('Dónde conviene poner tu presupuesto para conseguir más ventas.', 'Where to put your budget to get more sales.')],
                  [T('Embudos de venta', 'Sales funnels'), T('Armados con tu IA, desde el primer anuncio hasta la venta.', 'Built with your AI, from the first ad to the sale.')],
                ].map(([title, text]) => (
                  <div key={title}>
                    <h3 className="font-sans text-[15px] font-semibold text-ink">{title}</h3>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{text}</p>
                  </div>
                ))}
              </div>
              <button type="button" disabled className="mt-8 h-11 cursor-not-allowed rounded-full border border-line bg-surface-2 px-6 text-[14px] font-semibold text-ink-3">{T('Disponible próximamente', 'Available soon')}</button>
            </div>
          </section>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            {/* 1. the connection */}
            <section data-tour="metaads" className={CARD}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface shadow-sm"><ProviderLogo provider="meta-ads" size={22} /></span>
                <span className="min-w-[min(100%,220px)] flex-1">
                  <span className="block text-[15px] font-bold text-ink">{connected ? T('Meta Ads conectado', 'Meta Ads connected') : T('Conectá tu cuenta de Meta Ads', 'Connect your Meta Ads account')}{connected && b.meta.account ? <span className="font-normal text-ink-3"> · {b.meta.account}</span> : null}</span>
                  <span className="block text-[12.5px] text-ink-3">{!b.meta.ready ? T('La conexión con Meta todavía no está habilitada en esta instalación.', 'The Meta connection is not enabled on this install yet.') : connected ? T('Tably solo lee tus números y crea anuncios en pausa: nada se gasta hasta que vos los actives.', 'Tably only reads your numbers and creates paused ads: nothing is spent until you turn them on.') : b.meta.expired ? T('La conexión venció (dura unos 60 días).', 'The connection expired (it lasts about 60 days).') : T('Una sola vez. Se abre Meta para que elijas la cuenta y das permiso.', 'Just once. Meta opens so you pick the account and allow it.')}</span>
                </span>
                {!b.meta.ready ? (b.meta.admin ? <button onClick={() => setSetup(true)} className={PILL}><KeyRound size={14} /> {T('Cargar la app de Meta', 'Add the Meta app')}</button> : null)
                  : !connected ? <button onClick={connect} className={PRIMARY}><Link2 size={14} /> {b.meta.expired ? T('Volver a conectar', 'Reconnect') : T('Conectar Meta Ads', 'Connect Meta Ads')}</button>
                  : <button onClick={() => api.metaAdsDisconnect().then(() => { setAssets(null); load() })} className={PILL}>{T('Desconectar', 'Disconnect')}</button>}
              </div>

              {!b.meta.ready && setup && <div className="mt-4"><MetaSetup onDone={() => { setSetup(false); load() }} onCancel={() => setSetup(false)} /></div>}
              {connected && (assetsErr ? <p className="mt-3 text-[13px] text-danger">{assetsErr} <button onClick={connect} className="font-semibold underline">{T('Volver a conectar', 'Reconnect')}</button></p>
                : !assets ? <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin" /> {T('Leyendo tus cuentas publicitarias…', 'Reading your ad accounts…')}</p>
                : !assets.accounts.length ? <p className="mt-3 text-[13px] text-ink-2">{T('Tu cuenta de Meta no tiene cuentas publicitarias. Creá una en el Administrador de anuncios y volvé.', 'Your Meta account has no ad accounts. Create one in Ads Manager and come back.')} <a href="https://adsmanager.facebook.com/" target="_blank" rel="noreferrer" className="font-semibold text-accent">{T('Abrir', 'Open')}</a></p>
                : (
                  <div className="mt-4 flex flex-wrap items-end gap-3">
                    <label className="min-w-[min(100%,260px)] flex-1"><span className={LABEL}>{T('Cuenta publicitaria', 'Ad account')}</span>
                      <select value={account} onChange={(e) => setAccount(e.target.value)} className={`${INPUT} mt-1`}>
                        {assets.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}{a.active ? '' : T(' (inactiva)', ' (inactive)')}</option>)}
                      </select></label>
                    <button onClick={analyze} disabled={!account || b.status === 'working'} className={PRIMARY}>
                      {b.status === 'working' ? <Loader2 size={15} className="animate-spin" /> : an ? <RefreshCw size={15} /> : <Brain size={15} />}
                      {an ? T('Volver a analizar', 'Analyse again') : T('Analizar mi cuenta y armar los anuncios', 'Analyse my account and build the ads')}</button>
                  </div>
                ))}
              {b.status === 'working' && <p className="mt-3 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2.5 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {b.step || T('Trabajando…', 'Working…')}</p>}
              {b.status === 'error' && <p className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">{b.error} {/clave|key|modelo/i.test(b.error ?? '') && <button onClick={() => useArena.getState().set({ view: 'settings' })} className="font-semibold underline">{T('Agregar clave', 'Add key')}</button>}</p>}
            </section>

            {/* 2. what the account says */}
            {b.totals && an && (
              <section data-tour="diagnosis" className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(30,38,34,.04),0_12px_32px_-18px_rgba(30,38,34,.25)]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-gradient-to-r from-accent-soft/70 via-surface to-surface px-5 py-4">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white shadow-sm"><Sparkles size={17} /></span>
                  <div className="min-w-[min(100%,220px)] flex-1">
                    <h3 className="text-[16px] font-bold tracking-tight text-ink">{T('Diagnóstico de tu cuenta', 'Your account diagnosis')}</h3>
                    <p className="text-[12px] text-ink-3">{b.account?.name} · {b.period}</p>
                  </div>
                  {b.by && <span className="rounded-full border border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-ink-3">{b.by}</span>}
                </div>
                <div className="p-5">
                  <div className="grid grid-cols-2 gap-2.5 min-[760px]:grid-cols-4">
                    {([[Wallet, T('Invertido', 'Spent'), money(b.totals.spend, cur), ''], [Target, T('Resultados', 'Results'), String(b.totals.results), b.result ?? ''], [TrendingDown, T('Costo por resultado', 'Cost per result'), money(b.totals.cost_per_result, cur), ''], [Megaphone, T('Anuncios analizados', 'Ads analysed'), String(b.totals.ads), '']] as const).map(([Icon, k, v, sub], i) => (
                      <div key={k} className={`rounded-xl border px-3.5 py-3 ${i === 2 ? 'border-accent/40 bg-accent-soft/50' : 'border-line bg-paper'}`}>
                        <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-3"><Icon size={13} className={i === 2 ? 'text-accent' : ''} /> {k}</div>
                        <div className="mt-1 font-mono text-[21px] font-semibold tracking-tight text-ink">{v}</div>
                        {sub && <div className="text-[11px] text-ink-4">{sub}</div>}
                      </div>
                    ))}
                  </div>
                  {an.summary && (
                    <div className="mt-4 flex gap-3 rounded-xl border-l-4 border-accent bg-accent-soft/40 px-4 py-3">
                      <Brain size={18} className="mt-0.5 shrink-0 text-accent" />
                      <p className="text-[14.5px] leading-relaxed text-ink">{an.summary}</p>
                    </div>
                  )}
                  {![...an.works, ...an.fix].some((x) => x.actions?.length) && <p className="mt-2 text-[12.5px] text-ink-3">{T('Tocá «Volver a analizar» para que cada punto traiga sus botones (pausar, eliminar, cambiar presupuesto o público).', 'Tap «Analyse again» so each point comes with its buttons (pause, delete, change budget or audience).')}</p>}
                  {!!b.top?.length && (
                    <div className="mt-5">
                      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">{T('Tus anuncios, por inversión', 'Your ads, by spend')}</div>
                      <div className="flex gap-2.5 overflow-x-auto pb-1">
                        {b.top.map((t, i) => (
                          <div key={i} className="flex w-[220px] shrink-0 gap-2.5 rounded-xl border border-line bg-paper p-2">
                            <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-2">{t.thumb ? <img src={t.thumb} alt="" className="h-full w-full object-cover" /> : <Megaphone size={16} className="m-auto mt-5 text-ink-4" />}</span>
                            <span className="min-w-0 text-[11.5px] leading-tight">
                              <span className="block truncate text-[12.5px] font-semibold text-ink" title={t.ad}>{t.ad}</span>
                              <span className="block text-ink-3">{money(t.spend, cur)} · {t.results} {T('res.', 'res.')}</span>
                              <span className={`mt-1 inline-block rounded-full px-1.5 py-px text-[10.5px] font-semibold ${t.results ? 'bg-[#2E9E6A]/12 text-[#2E9E6A]' : 'bg-danger/10 text-danger'}`}>{t.cost_per_result != null ? `${money(t.cost_per_result, cur)} c/u` : T('sin resultados', 'no results')}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-5 grid grid-cols-1 gap-5 min-[860px]:grid-cols-2">
                    <Findings icon={<ThumbsUp size={14} />} tone="good" kind="works" title={T('Lo que funciona', 'What works')} items={an.works} cur={cur} onB={setB} />
                    <Findings icon={<AlertTriangle size={14} />} tone="bad" kind="fix" title={T('Lo que hay que cambiar', 'What to change')} items={an.fix} cur={cur} onB={setB} />
                  </div>
                  <div className="mt-5 grid grid-cols-1 gap-2.5 min-[860px]:grid-cols-3">
                    {([[Users, T('Público recomendado', 'Recommended audience'), `${an.audience.countries.join(', ')} · ${an.audience.age_min}–${an.audience.age_max}${an.audience.age_max >= 65 ? '+' : ''} · ${an.audience.genders === 'women' ? T('mujeres', 'women') : an.audience.genders === 'men' ? T('hombres', 'men') : T('todos', 'everyone')}`, an.audience.why],
                       [LayoutGrid, T('Ubicaciones', 'Placements'), '', an.placements],
                       [Wallet, T('Presupuesto sugerido', 'Suggested budget'), `${money(an.budget.daily, cur)} ${T('por día', 'a day')}`, an.budget.why]] as const).map(([Icon, k, head, why]) => (
                      <div key={k} className="rounded-xl border border-line bg-paper px-3.5 py-3">
                        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent"><Icon size={13} /></span> {k}</div>
                        {head && <div className="mt-1.5 text-[14px] font-semibold text-ink">{head}</div>}
                        {why && <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{why}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* 3. the ads, made from the studio videos */}
            {an && (
              <section data-tour="newads" className="flex flex-col gap-3">
                <h3 className="text-[15px] font-bold text-ink">{T('Tus anuncios nuevos', 'Your new ads')}<span className="ml-2 text-[12px] font-normal text-ink-3">{T('con los videos de «Crear anuncio»', 'with your «Create ad» videos')}</span></h3>
                {!an.ads.length && (
                  <div className={`${CARD} flex flex-wrap items-center gap-3 text-[13.5px] text-ink-2`}>
                    <Clapperboard size={18} className="text-accent" />
                    <span className="min-w-[min(100%,260px)] flex-1">{b.videos ? T('Tenés videos nuevos que todavía no están en la propuesta: volvé a analizar.', 'You have new videos that are not in the proposal yet: analyse again.') : T('Todavía no tenés videos terminados. Hacé uno en «Crear anuncio» y volvé: la IA arma el anuncio con lo que aprendió de tu cuenta.', 'You have no finished videos yet. Make one in «Create ad» and come back: the AI builds the ad with what it learned from your account.')}</span>
                    <button onClick={() => useArena.getState().set({ view: 'studio' })} className={PILL}><Clapperboard size={14} /> {T('Crear anuncio', 'Create ad')}</button>
                  </div>
                )}
                {an.ads.map((a) => <AdCard key={a.video} a={a} cur={cur} connected={connected && !!assets} pages={assets?.pages ?? []} page={page} setPage={setPage} onB={setB} />)}
                {!!an.missing?.length && <p className="text-[12.5px] text-ink-3">{T(`Sin anuncio todavía: ${an.missing.map((m) => m.title).join(', ')}. Tocá «Volver a analizar».`, `No ad yet: ${an.missing.map((m) => m.title).join(', ')}. Tap «Analyse again».`)}</p>}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
    </IconContext.Provider>
  )
}

function Findings({ icon, tone, kind, title, items, cur, onB }: { icon: React.ReactNode; tone: 'good' | 'bad'; kind: 'works' | 'fix'; title: string; items: { title: string; detail: string; impact?: string; actions?: MetaAction[] }[]; cur: string; onB: (b: MetaBrain) => void }) {
  const good = tone === 'good'
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${good ? 'bg-[#2E9E6A]/12 text-[#2E9E6A]' : 'bg-[#C28A12]/12 text-[#C28A12]'}`}>{icon}</span>
        <span className="text-[14px] font-bold text-ink">{title}</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-3">{items.length}</span>
      </div>
      {!items.length ? <p className="text-[13px] text-ink-3">—</p> : (
        <ul className="flex flex-col gap-2.5">
          {items.map((it, i) => (
            <li key={i} className={`relative overflow-hidden rounded-xl border border-line bg-paper py-3 pl-4 pr-3.5 shadow-[0_1px_2px_rgba(30,38,34,.04)]`}>
              <span className={`absolute inset-y-0 left-0 w-1 ${good ? 'bg-[#2E9E6A]' : 'bg-[#C28A12]'}`} />
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-ink">{it.title}</span>
                {it.impact && <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ${good ? 'bg-[#2E9E6A]/12 text-[#2E9E6A]' : 'bg-[#C28A12]/12 text-[#9A6B0A]'}`}>{it.impact}</span>}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{it.detail}</p>
              {!!it.actions?.length && <div className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5">{it.actions.map((a, j) => <Action key={j} a={a} kind={kind} i={i} j={j} cur={cur} onB={onB} />)}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One thing Tably can do in the ad account for a finding: pause, turn on, delete, change the budget or the audience. Budget and
 *  audience open their values first so they can be changed before applying; deleting asks once more. */
function Action({ a, kind, i, j, cur, onB }: { a: MetaAction; kind: 'works' | 'fix'; i: number; j: number; cur: string; onB: (b: MetaBrain) => void }) {
  const T = useT()
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState({ daily_budget: a.daily_budget ?? 0, age_min: a.age_min ?? 18, age_max: a.age_max ?? 65, genders: a.genders ?? 'all' })
  const lvl = a.level === 'ad' ? T('anuncio', 'ad') : a.level === 'adset' ? T('conjunto', 'ad set') : T('campaña', 'campaign')
  const go = async (type?: 'pause' | 'activate' | 'delete') => {
    if ((type ?? a.type) === 'delete' && !window.confirm(T(`¿Eliminar ${lvl} «${a.name}» en Meta? No se puede deshacer.`, `Delete ${lvl} «${a.name}» in Meta? It cannot be undone.`))) return
    setBusy(true)
    try {
      const r = await api.metaBrainAction({ kind, i, j, type, ...(a.type === 'budget' ? { daily_budget: v.daily_budget } : a.type === 'targeting' ? { age_min: v.age_min, age_max: v.age_max, genders: v.genders } : {}) })
      onB(r); setEdit(false)
      toast.ok(r.msg, a.name)
    } catch (e) { toast.error(T('No se pudo hacer', 'Could not do it'), (e as Error).message) } finally { setBusy(false) }
  }
  if (a.done?.ok) return <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#2E9E6A]"><CheckCircle2 size={13} /> {a.done.msg} · {a.name}</span>
  const btn = 'flex h-7 items-center gap-1 rounded-full px-3 text-[12px] font-semibold transition disabled:opacity-40'
  const main = a.type === 'delete' ? `${btn} bg-danger text-white hover:brightness-110` : `${btn} bg-accent text-white hover:brightness-110`
  const Icon = a.type === 'pause' ? Pause : a.type === 'activate' ? Play : a.type === 'delete' ? Trash2 : a.type === 'budget' ? Wallet : SlidersHorizontal
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(a.type === 'budget' || a.type === 'targeting') && !edit ? (
        <>
          <button onClick={() => go()} disabled={busy} className={main}>{busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />} {a.label}</button>
          <button onClick={() => setEdit(true)} disabled={busy} className={`${btn} border border-line text-ink-2 hover:border-accent hover:text-accent`}><Pencil size={12} /> {T('Modificar', 'Edit')}</button>
        </>
      ) : edit ? (
        <span className="flex w-full flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink-2">
          {a.type === 'budget' ? (
            <label className="flex items-center gap-1">{T('Por día', 'Per day')} <input type="number" min={1} step="any" value={v.daily_budget} onChange={(e) => setV({ ...v, daily_budget: Number(e.target.value) })} className="h-7 w-24 rounded-md border border-line bg-paper px-2 outline-none focus:border-accent" /> {cur}</label>
          ) : (
            <>
              <label className="flex items-center gap-1">{T('Edad', 'Age')} <input type="number" min={13} max={65} value={v.age_min} onChange={(e) => setV({ ...v, age_min: Number(e.target.value) })} className="h-7 w-14 rounded-md border border-line bg-paper px-1.5 outline-none focus:border-accent" /> – <input type="number" min={13} max={65} value={v.age_max} onChange={(e) => setV({ ...v, age_max: Number(e.target.value) })} className="h-7 w-14 rounded-md border border-line bg-paper px-1.5 outline-none focus:border-accent" /></label>
              <select value={v.genders} onChange={(e) => setV({ ...v, genders: e.target.value as 'all' | 'women' | 'men' })} className="h-7 rounded-md border border-line bg-paper px-1.5 outline-none focus:border-accent"><option value="all">{T('todos', 'everyone')}</option><option value="women">{T('mujeres', 'women')}</option><option value="men">{T('hombres', 'men')}</option></select>
              {!!a.publisher_platforms?.length && <span className="text-ink-3">{T('Ubicaciones', 'Placements')}: {[...(a.facebook_positions ?? []).map((x) => `fb ${x}`), ...(a.instagram_positions ?? []).map((x) => `ig ${x}`)].join(', ') || a.publisher_platforms.join(', ')}</span>}
            </>
          )}
          <button onClick={() => go()} disabled={busy} className={main}>{busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} {T('Aplicar', 'Apply')}</button>
          <button onClick={() => setEdit(false)} className={`${btn} text-ink-3 hover:text-ink`}>{T('Cancelar', 'Cancel')}</button>
        </span>
      ) : (
        <>
          <button onClick={() => go()} disabled={busy} className={main}>{busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />} {a.label}</button>
          {a.type !== 'delete' && <button onClick={() => go('delete')} disabled={busy} className={`${btn} border border-line text-ink-3 hover:border-danger hover:text-danger`}><Trash2 size={12} /> {T('Eliminar', 'Delete')}</button>}
          {a.type === 'delete' && <button onClick={() => go('pause')} disabled={busy} className={`${btn} border border-line text-ink-2 hover:border-accent hover:text-accent`}><Pause size={12} /> {T('Solo pausar', 'Just pause')}</button>}
        </>
      )}
      <span className="text-[11px] text-ink-4">{lvl}</span>
    </div>
  )
}

function AdCard({ a, cur, connected, pages, page, setPage, onB }: { a: MetaBrainAd; cur: string; connected: boolean; pages: { id: string; name: string }[]; page: string; setPage: (v: string) => void; onB: (b: MetaBrain) => void }) {
  const T = useT()
  const [f, setF] = useState({ headline: a.headline, primary_text: a.primary_text, description: a.description, link: a.link, daily_budget: a.daily_budget, countries: a.countries.join(', ') })
  const [sending, setSending] = useState(false)
  useEffect(() => { setF({ headline: a.headline, primary_text: a.primary_text, description: a.description, link: a.link, daily_budget: a.daily_budget, countries: a.countries.join(', ') }) }, [a.headline, a.primary_text, a.description, a.link, a.daily_budget, a.countries.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const m = a.meta
  const publish = async () => {
    setSending(true)
    try { onB(await api.metaBrainPublish(a.video, { ...f, countries: f.countries.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()), page_id: page })) } catch (e) { toast.error(T('No se pudo publicar', 'Could not publish'), (e as Error).message) } finally { setSending(false) }
  }
  return (
    <div className={`${CARD} grid grid-cols-1 gap-4 min-[720px]:grid-cols-[170px_minmax(0,1fr)]`}>
      <video src={api.studioFileUrl(a.video, 'final/vertical.mp4', a.ts ?? '')} poster={api.studioFileUrl(a.video, 'final/vertical.jpg', a.ts ?? '')} controls playsInline preload="none" className="mx-auto aspect-[9/16] w-full max-w-[200px] rounded-xl border border-line bg-black" />
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <div className="text-[15px] font-bold text-ink">{a.name}<span className="ml-2 text-[12px] font-normal text-ink-3">{a.title}</span></div>
          {a.why && <p className="mt-1 flex gap-1.5 text-[12.5px] leading-snug text-ink-3"><Brain size={13} className="mt-0.5 shrink-0 text-accent" /> {a.why}</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
          <label><span className={LABEL}>{T('Título', 'Headline')}</span><input value={f.headline} maxLength={40} onChange={(e) => setF({ ...f, headline: e.target.value })} className={`${INPUT} mt-1`} /></label>
          <label><span className={LABEL}>{T('Descripción', 'Description')}</span><input value={f.description} maxLength={60} onChange={(e) => setF({ ...f, description: e.target.value })} className={`${INPUT} mt-1`} /></label>
          <label className="min-[560px]:col-span-2"><span className={LABEL}>{T('Texto principal', 'Primary text')}</span><textarea value={f.primary_text} maxLength={300} rows={3} onChange={(e) => setF({ ...f, primary_text: e.target.value })} className={`${INPUT} mt-1 resize-y`} /></label>
          <label className="min-[560px]:col-span-2"><span className={LABEL}>{T('Link de destino', 'Destination link')}</span><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://" type="url" autoComplete="off" className={`${INPUT} mt-1`} /></label>
          <label><span className={LABEL}>{T('Presupuesto diario', 'Daily budget')} ({cur})</span><input type="number" min={1} step="any" value={f.daily_budget} onChange={(e) => setF({ ...f, daily_budget: Number(e.target.value) })} className={`${INPUT} mt-1`} /></label>
          <label><span className={LABEL}>{T('Países', 'Countries')}</span><input value={f.countries} onChange={(e) => setF({ ...f, countries: e.target.value })} className={`${INPUT} mt-1`} /></label>
        </div>
        <p className="text-[12px] text-ink-3">{T('Público', 'Audience')}: {a.age_min}–{a.age_max}{a.age_max >= 65 ? '+' : ''} · {a.genders === 'women' ? T('mujeres', 'women') : a.genders === 'men' ? T('hombres', 'men') : T('todos', 'everyone')} · {T('botón', 'button')} {a.cta_type.replace(/_/g, ' ').toLowerCase()} · {T('vertical para Reels y Stories, cuadrado para el feed', 'vertical for Reels and Stories, square for feed')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {m?.status === 'done' && m.manager_url ? (
            <>
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2E9E6A]"><CheckCircle2 size={15} /> {T('Creado en pausa', 'Created paused')}</span>
              <a href={m.manager_url} target="_blank" rel="noreferrer" className={PRIMARY}><ExternalLink size={14} /> {T('Revisarlo y activarlo en Meta', 'Review and turn it on in Meta')}</a>
            </>
          ) : m?.status === 'publishing' ? (
            <span className="flex items-center gap-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {m.step}</span>
          ) : !connected ? (
            <span className="text-[13px] text-ink-2">{T('Conectá Meta Ads arriba para publicarlo.', 'Connect Meta Ads above to publish it.')}</span>
          ) : !pages.length ? (
            <span className="text-[13px] text-ink-2">{T('Hace falta una página de Facebook para publicar anuncios. Creá una y volvé.', 'A Facebook Page is needed to run ads. Create one and come back.')}</span>
          ) : (
            <>
              <select value={page} onChange={(e) => setPage(e.target.value)} aria-label={T('Página de Facebook', 'Facebook Page')} className="h-10 rounded-full border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent">{pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <button onClick={publish} disabled={sending || !f.link || !f.daily_budget || !page} className={PRIMARY}>{sending ? <Loader2 size={14} className="animate-spin" /> : <Megaphone size={14} />} {m?.status === 'error' ? T('Reintentar', 'Retry') : T('Publicar en pausa', 'Publish paused')}</button>
              <span className="text-[12px] text-ink-3">{T('No se gasta nada hasta que lo actives.', 'Nothing is spent until you turn it on.')}</span>
            </>
          )}
          {m?.status === 'error' && <span className="flex w-full items-start gap-1.5 text-[13px] text-danger"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {m.error}</span>}
        </div>
      </div>
    </div>
  )
}

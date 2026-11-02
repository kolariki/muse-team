import { AlertTriangle, Brain, CheckCircle2, Clapperboard, ExternalLink, KeyRound, Link2, Loader2, Megaphone, RefreshCw, ThumbsDown, ThumbsUp, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type MetaBrain, type MetaBrainAd } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import MetaSetup from './MetaSetup'
import PageHeader from './PageHeader'
import { toast } from './Toast'

const CARD = 'rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'
const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-5 text-[14px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent'
const LABEL = 'block text-[11.5px] font-semibold uppercase tracking-wide text-ink-3'
type Assets = Awaited<ReturnType<typeof api.metaAdsAssets>>

const money = (n: number | null | undefined, cur = 'USD') => (n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n))

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

  const load = () => api.metaBrain().then(setB).catch((e) => toast.error(tr('No pude leer Meta Ads', 'Could not read Meta Ads'), (e as Error).message))
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
    <div className="min-h-full bg-paper">
      <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">
        <PageHeader onBack={onBack} kicker="Meta Ads" title={T('Tu cuenta de Meta Ads, leída por la IA', 'Your Meta Ads account, read by the AI')}
          subtitle={T('Conectá tu cuenta publicitaria. Tably lee tus campañas, ve qué anuncios, públicos y ubicaciones te traen resultados al menor costo, y arma los anuncios nuevos con los videos que hiciste en «Crear anuncio», listos para publicar en pausa.', 'Connect your ad account. Tably reads your campaigns, sees which ads, audiences and placements bring results at the lowest cost, and builds new ads with the videos you made in «Create ad», ready to publish paused.')} />

        {!b ? <p className="mt-6 flex items-center gap-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin" /> {T('Cargando…', 'Loading…')}</p> : (
          <div className="mt-5 flex flex-col gap-4">
            {/* 1. the connection */}
            <section className={CARD}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#0082FB]/12 text-[#0082FB]"><Megaphone size={17} /></span>
                <span className="min-w-0 flex-1">
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
              <section className={CARD}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h3 className="text-[15px] font-bold text-ink">{T('Lo que dice tu cuenta', 'What your account says')}</h3>
                  <span className="text-[12px] text-ink-3">{b.account?.name} · {b.period}{b.by ? ` · ${b.by}` : ''}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 min-[640px]:grid-cols-4">
                  {[[T('Gastado', 'Spent'), money(b.totals.spend, cur)], [T(`Resultados (${b.result})`, `Results (${b.result})`), String(b.totals.results)], [T('Costo por resultado', 'Cost per result'), money(b.totals.cost_per_result, cur)], [T('Anuncios', 'Ads'), String(b.totals.ads)]].map(([k, v]) => (
                    <div key={k} className="rounded-xl border border-line bg-paper px-3 py-2.5"><div className="text-[11.5px] text-ink-3">{k}</div><div className="mt-0.5 font-mono text-[18px] font-semibold text-ink">{v}</div></div>
                  ))}
                </div>
                {an.summary && <p className="mt-3 text-[14px] leading-relaxed text-ink">{an.summary}</p>}
                <div className="mt-4 grid grid-cols-1 gap-4 min-[760px]:grid-cols-2">
                  <Findings icon={<ThumbsUp size={14} />} tone="good" title={T('Lo que funciona', 'What works')} items={an.works} />
                  <Findings icon={<ThumbsDown size={14} />} tone="bad" title={T('Lo que hay que cambiar', 'What to change')} items={an.fix} />
                </div>
                <div className="mt-4 grid grid-cols-1 gap-2 text-[13px] text-ink-2 min-[760px]:grid-cols-3">
                  <p className="rounded-xl bg-surface-2 px-3 py-2.5"><span className="mb-0.5 flex items-center gap-1 font-semibold text-ink"><Users size={13} /> {T('Público', 'Audience')}</span>{an.audience.countries.join(', ')} · {an.audience.age_min}–{an.audience.age_max}{an.audience.age_max >= 65 ? '+' : ''} · {an.audience.genders === 'women' ? T('mujeres', 'women') : an.audience.genders === 'men' ? T('hombres', 'men') : T('todos', 'everyone')}{an.audience.why ? <span className="mt-1 block text-ink-3">{an.audience.why}</span> : null}</p>
                  <p className="rounded-xl bg-surface-2 px-3 py-2.5"><span className="mb-0.5 block font-semibold text-ink">{T('Ubicaciones', 'Placements')}</span>{an.placements || '—'}</p>
                  <p className="rounded-xl bg-surface-2 px-3 py-2.5"><span className="mb-0.5 block font-semibold text-ink">{T('Presupuesto', 'Budget')}</span>{money(an.budget.daily, cur)} {T('por día', 'a day')}{an.budget.why ? <span className="mt-1 block text-ink-3">{an.budget.why}</span> : null}</p>
                </div>
              </section>
            )}

            {/* 3. the ads, made from the studio videos */}
            {an && (
              <section className="flex flex-col gap-3">
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
  )
}

function Findings({ icon, tone, title, items }: { icon: React.ReactNode; tone: 'good' | 'bad'; title: string; items: { title: string; detail: string }[] }) {
  const color = tone === 'good' ? 'text-[#2E9E6A]' : 'text-[#C28A12]'
  return (
    <div>
      <div className={`mb-2 flex items-center gap-1.5 text-[13px] font-bold ${color}`}>{icon} {title}</div>
      {!items.length ? <p className="text-[13px] text-ink-3">—</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((it, i) => <li key={i} className="rounded-xl border border-line bg-paper px-3 py-2"><span className="block text-[13.5px] font-semibold text-ink">{it.title}</span><span className="block text-[12.5px] leading-snug text-ink-2">{it.detail}</span></li>)}
        </ul>
      )}
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

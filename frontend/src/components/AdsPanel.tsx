import { AlertTriangle, CheckCircle2, Clapperboard, CloudUpload, Download, ExternalLink, KeyRound, Link2, Loader2, Megaphone, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBuild } from '../buildStore'
import { api, type Ad, type AdScript, type AdsPayload, type MetaPublish } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { PanelLoader } from './HomeLoader'
import { toast } from './Toast'

const CARD = 'rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'
const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent'
const LABEL = 'block text-[11.5px] font-semibold uppercase tracking-wide text-ink-3'
const WORKING: Ad['status'][] = ['capturing', 'writing', 'queued', 'rendering']
const CTAS: [string, string, string][] = [['LEARN_MORE', 'Más información', 'Learn more'], ['SIGN_UP', 'Registrarte', 'Sign up'], ['SHOP_NOW', 'Comprar', 'Shop now'], ['BOOK_NOW', 'Reservar', 'Book now'],
  ['GET_OFFER', 'Obtener oferta', 'Get offer'], ['SUBSCRIBE', 'Suscribirte', 'Subscribe'], ['DOWNLOAD', 'Descargar', 'Download'], ['CONTACT_US', 'Contactarnos', 'Contact us'], ['ORDER_NOW', 'Pedir ahora', 'Order now'], ['APPLY_NOW', 'Postularte', 'Apply now']]

/** «Anuncios»: the team turns the app into 15-second video ads (vertical for Reels/Stories, square for feed) with its real
 *  screens, and publishes them to Meta Ads paused, so nothing is spent until the user turns them on. */
export default function AdsPanel() {
  const T = useT()
  const b = useBuild()
  const [data, setData] = useState<AdsPayload | null>(null)
  const [ask, setAsk] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const load = async () => {
    if (!b.sessionId || !b.id) return
    try { setData(await api.ads(b.sessionId, b.id)) } catch (e) { toast.error(tr('No pude leer los anuncios', 'Could not read the ads'), (e as Error).message) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [b.sessionId, b.id, b.cloudApp?.status])
  // while something is being made or published, follow it
  const live = !!data?.ads.some((a) => WORKING.includes(a.status) || a.meta?.status === 'publishing')
  useEffect(() => {
    window.clearInterval(timer.current)
    if (live) timer.current = window.setInterval(load, 2500)
    return () => window.clearInterval(timer.current)
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps
  // the Meta login window reports back here
  useEffect(() => {
    const on = (ev: MessageEvent) => {
      const m = ev.data as { tablyMetaAds?: string; message?: string }
      if (!m?.tablyMetaAds) return
      if (m.tablyMetaAds === 'ok') toast.ok(tr('Meta Ads conectado', 'Meta Ads connected'), m.message)
      else toast.error(tr('No se conectó Meta Ads', 'Meta Ads did not connect'), m.message)
      load()
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <PanelLoader caption={T('Buscando tus anuncios…', 'Looking for your ads…')} />
  const create = async () => {
    if (!b.sessionId || !b.id) return
    setBusy(true)
    try { setData(await api.adsNew(b.sessionId, b.id, ask.trim())); setAsk('') } catch (e) { toast.error(T('No se pudo empezar el anuncio', 'Could not start the ad'), (e as Error).message) } finally { setBusy(false) }
  }
  const making = data.ads.some((a) => WORKING.includes(a.status))
  const src = data.source

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-paper px-3 py-4 sm:px-6 sm:py-5">
      <div className="mx-auto flex max-w-[860px] flex-col gap-4">
        <section className={CARD}>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Clapperboard size={19} /></span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-bold text-ink">{T('Anuncios en video para Meta', 'Video ads for Meta')}</h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-2">{T('El equipo escribe el anuncio y arma un video de 15 segundos con las pantallas reales de tu app, en vertical (Reels y Stories) y cuadrado (feed de Instagram y Facebook).', 'The team writes the ad and makes a 15-second video with the real screens of your app, vertical (Reels and Stories) and square (Instagram and Facebook feed).')}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2">
              {src.kind === 'live' ? <CheckCircle2 size={15} className="shrink-0 text-[#2E9E6A]" /> : <AlertTriangle size={15} className="shrink-0 text-[#C28A12]" />}
              <span className="min-w-[min(100%,230px)] flex-1 text-ink-2">
                {src.kind === 'live' ? <>{T('Pantallas de tu app publicada', 'Screens from your published app')} · <span className="break-all font-mono text-[12px]">{src.url}</span></>
                  : src.kind === 'none' ? T('Todavía no hay pantallas para mostrar: el video va solo con texto.', 'No screens to show yet: the video is text only.')
                  : T('Pantallas del diseño aprobado. Publicá la app para que el anuncio muestre la app real y lleve a su link.', 'Screens from the approved design. Publish the app so the ad shows the real app and links to it.')}
              </span>
              {src.kind !== 'live' && <button onClick={() => useBuild.getState().set({ pane: 'cloud', paneOpen: true })} className={PILL}><CloudUpload size={14} /> {T('Publicar la app', 'Publish the app')}</button>}
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2">
              {data.writer ? <CheckCircle2 size={15} className="shrink-0 text-[#2E9E6A]" /> : <AlertTriangle size={15} className="shrink-0 text-[#C28A12]" />}
              <span className="min-w-[min(100%,230px)] flex-1 text-ink-2">{data.writer ? <>{T('Guion escrito por', 'Script written by')} <b className="text-ink">{data.writer}</b></> : T('Sin un modelo con clave el guion sale del brief, más simple. Agregá tu clave de Meta Muse para que lo escriba un creativo.', 'Without a model key the script comes from the brief, plainer. Add your Meta Muse key so a creative writes it.')}</span>
              {!data.writer && <button onClick={() => useArena.getState().set({ view: 'settings' })} className={PILL}><KeyRound size={14} /> {T('Agregar clave', 'Add key')}</button>}
            </div>
          </div>
          {!data.engine ? (
            <p className="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">{T('Este servidor no tiene el motor de video instalado.', 'This server does not have the video engine installed.')}</p>
          ) : (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1">
                <span className={LABEL}>{T('¿Algo en especial? (opcional)', 'Anything in particular? (optional)')}</span>
                <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) create() }} maxLength={600} className={`${INPUT} mt-1`}
                  placeholder={T('Ej.: apuntá a dueñas de estudios, mencioná la seña con Mercado Pago', 'E.g.: aim at studio owners, mention the deposit')} />
              </label>
              <button onClick={create} disabled={busy} className={`${PRIMARY} h-10 justify-center`}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Clapperboard size={15} />} {data.ads.length ? T('Hacer otro anuncio', 'Make another ad') : T('Crear anuncio', 'Create ad')}
              </button>
            </div>
          )}
          {making && <p className="mt-2 text-[12px] text-ink-3">{T('Tarda unos 2 minutos. Podés seguir trabajando: el video aparece acá cuando está listo.', 'It takes about 2 minutes. Keep working: the video shows up here when ready.')}</p>}
        </section>

        {data.ads.map((ad) => <AdCard key={ad.id} ad={ad} data={data} onData={setData} reload={load} />)}
      </div>
    </div>
  )
}

function Progress({ ad }: { ad: Ad }) {
  const T = useT()
  const pct = ad.status === 'rendering' ? Math.round(ad.progress * 100) : null
  const steps: Ad['status'][] = ['capturing', 'writing', 'rendering']
  const at = Math.max(0, steps.indexOf(ad.status === 'queued' ? 'rendering' : ad.status))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Loader2 size={15} className="animate-spin text-accent" /> {ad.step || T('Preparando', 'Getting ready')}{pct !== null && <span className="font-mono text-ink-3">{pct}%</span>}</div>
      <div className="grid grid-cols-3 gap-1.5">
        {steps.map((s, i) => (
          <div key={s}>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-all" style={{ width: i < at ? '100%' : i === at ? (pct !== null ? `${Math.max(4, pct)}%` : '45%') : '0%' }} /></div>
            <div className="mt-1 text-[11px] text-ink-3">{[T('Capturas', 'Screens'), T('Guion', 'Script'), T('Video', 'Video')][i]}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AdCard({ ad, data, onData, reload }: { ad: Ad; data: AdsPayload; onData: (d: AdsPayload) => void; reload: () => void }) {
  const T = useT()
  const b = useBuild()
  const [editing, setEditing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [sure, setSure] = useState(false)
  const s = ad.script
  const sid = b.sessionId ?? '', bid = b.id ?? ''
  const file = (name: string, download = false) => api.adFileUrl(sid, bid, ad.id, name, ad.version ?? '', download)
  const act = async (fn: () => Promise<AdsPayload>, fail: string) => { try { onData(await fn()) } catch (e) { toast.error(fail, (e as Error).message) } }

  return (
    <section className={CARD}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Megaphone size={15} className="text-accent" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-ink">{s?.angle || s?.hook || T('Anuncio nuevo', 'New ad')}</span>
        <span className="text-[11.5px] text-ink-3">{new Date(ad.created * 1000).toLocaleString(T('es-AR', 'en-US'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        {sure ? (
          <span className="flex items-center gap-1 text-[12px]">
            {T('¿Borrar este anuncio?', 'Delete this ad?')}
            <button onClick={() => act(() => api.adsDelete(sid, bid, ad.id), T('No se pudo borrar', 'Could not delete'))} className="rounded-full bg-danger px-2.5 py-1 font-semibold text-white">{T('Sí, borrar', 'Yes, delete')}</button>
            <button onClick={() => setSure(false)} className="rounded-full border border-line px-2.5 py-1 text-ink-2">{T('No', 'No')}</button>
          </span>
        ) : (
          <button onClick={() => setSure(true)} className="flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition hover:bg-danger/10 hover:text-danger" aria-label={T('Borrar el anuncio', 'Delete the ad')} title={T('Borrar el anuncio', 'Delete the ad')}><Trash2 size={14} /></button>
        )}
      </div>

      {WORKING.includes(ad.status) ? <Progress ad={ad} /> : ad.status === 'error' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5">
          <AlertTriangle size={15} className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 text-[13px] text-ink-2">{ad.error || T('No se pudo hacer el anuncio.', 'The ad could not be made.')}</span>
          <button onClick={() => act(() => api.adsRetry(sid, bid, ad.id), T('No se pudo reintentar', 'Could not retry'))} className={PILL}><RefreshCw size={14} /> {T('Reintentar', 'Retry')}</button>
        </div>
      ) : s && (
        <>
          <div className="flex flex-wrap items-start justify-center gap-4 sm:justify-start">
            {(['vertical', 'square'] as const).map((f) => (
              <figure key={f} className="flex flex-col gap-2">
                <video src={file(`${f}.mp4`)} poster={file(`${f}.jpg`)} controls playsInline preload="none" className={`rounded-xl border border-line bg-black ${f === 'vertical' ? 'h-[340px] w-[191px]' : 'h-[240px] w-[240px]'}`} />
                <figcaption className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
                  <span>{f === 'vertical' ? T('Vertical 9:16 · Reels y Stories', 'Vertical 9:16 · Reels and Stories') : T('Cuadrado 1:1 · feed', 'Square 1:1 · feed')}</span>
                  <a href={file(`${f}.mp4`, true)} download className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-accent hover:bg-accent-soft"><Download size={12} /> MP4</a>
                </figcaption>
              </figure>
            ))}
            <div className="min-w-[220px] flex-1 rounded-xl border border-line bg-surface-2/50 p-3 text-[13px]">
              <div className={LABEL}>{T('Texto del anuncio en Meta', 'Ad copy on Meta')}</div>
              <p className="mt-1.5 whitespace-pre-wrap text-ink">{s.primary_text}</p>
              <p className="mt-2 font-bold text-ink">{s.headline}</p>
              {s.description && <p className="text-ink-3">{s.description}</p>}
              <p className="mt-2 inline-flex rounded-md bg-surface px-2 py-1 text-[12px] font-semibold text-ink-2">{(([, es, en]) => T(es, en))(CTAS.find((c) => c[0] === s.cta_type) ?? CTAS[0])}</p>
              {ad.writer && <p className="mt-3 text-[11.5px] text-ink-4">{T('Guion:', 'Script:')} {ad.writer}</p>}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => setEditing((v) => !v)} className={PILL}>{editing ? <X size={14} /> : <Pencil size={14} />} {editing ? T('Cerrar edición', 'Close editing') : T('Cambiar textos y colores', 'Change texts and colors')}</button>
          </div>
          {editing && <EditForm ad={ad} s={s} onSaved={(d) => { onData(d); setEditing(false) }} />}
          <MetaBlock ad={ad} data={data} publishing={publishing} setPublishing={setPublishing} onData={onData} reload={reload} />
        </>
      )}
    </section>
  )
}

function EditForm({ ad, s, onSaved }: { ad: Ad; s: AdScript; onSaved: (d: AdsPayload) => void }) {
  const T = useT()
  const b = useBuild()
  const [v, setV] = useState<AdScript>(s)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof AdScript>(k: K, val: AdScript[K]) => setV((x) => ({ ...x, [k]: val }))
  const save = async () => {
    setSaving(true)
    try { onSaved(await api.adsEdit(b.sessionId ?? '', b.id ?? '', ad.id, v)) } catch (e) { toast.error(T('No se pudo guardar', 'Could not save'), (e as Error).message) } finally { setSaving(false) }
  }
  const field = (k: 'hook' | 'emphasis' | 'sub' | 'cta' | 'cta_sub' | 'headline' | 'description' | 'link', label: string, max: number) => (
    <label key={k}><span className={LABEL}>{label}</span><input value={v[k]} maxLength={max} onChange={(e) => set(k, e.target.value)} className={`${INPUT} mt-1`} /></label>
  )
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface-2/40 p-3 min-[560px]:grid-cols-2">
      {field('hook', T('Gancho (lo primero que se lee)', 'Hook (read first)'), 70)}
      {field('emphasis', T('Palabras resaltadas del gancho', 'Highlighted words of the hook'), 40)}
      <div className="min-[560px]:col-span-2">{field('sub', T('Bajada', 'Subline'), 90)}</div>
      {v.points.map((p, i) => (
        <label key={`p${i}`}><span className={LABEL}>{T('Beneficio', 'Benefit')} {i + 1}</span><input value={p} maxLength={40} onChange={(e) => set('points', v.points.map((x, j) => (j === i ? e.target.value : x)))} className={`${INPUT} mt-1`} /></label>
      ))}
      {v.captions.map((c, i) => (
        <label key={`c${i}`}><span className={LABEL}>{ad.screens[i]?.kind === 'desktop' ? T('Frase de la pantalla de computadora', 'Desktop screen line') : T('Frase de la pantalla del celular', 'Phone screen line')}</span><input value={c} maxLength={50} onChange={(e) => set('captions', v.captions.map((x, j) => (j === i ? e.target.value : x)))} className={`${INPUT} mt-1`} /></label>
      ))}
      {field('cta', T('Botón del final', 'Closing button'), 24)}
      {field('cta_sub', T('Debajo del botón', 'Under the button'), 50)}
      <label><span className={LABEL}>{T('Tipografía', 'Typeface')}</span>
        <select value={v.font} onChange={(e) => set('font', e.target.value as AdScript['font'])} className={`${INPUT} mt-1`}>
          <option value="grotesk">{T('Moderna', 'Modern')}</option><option value="serif">{T('Editorial', 'Editorial')}</option><option value="rounded">{T('Amigable', 'Friendly')}</option>
        </select>
      </label>
      <div className="flex items-end gap-3">
        {(['bg', 'accent'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <input type="color" value={v.palette[k]} onChange={(e) => set('palette', { ...v.palette, [k]: e.target.value.toUpperCase() })} className="h-9 w-11 cursor-pointer rounded-md border border-line bg-surface p-0.5" />
            {k === 'bg' ? T('Fondo', 'Background') : T('Acento', 'Accent')}
          </label>
        ))}
      </div>
      <div className="min-[560px]:col-span-2 border-t border-line pt-3"><span className={LABEL}>{T('Texto en Meta', 'Copy on Meta')}</span></div>
      <label className="min-[560px]:col-span-2"><span className={LABEL}>{T('Texto principal (arriba del video)', 'Primary text (above the video)')}</span>
        <textarea value={v.primary_text} maxLength={300} rows={3} onChange={(e) => set('primary_text', e.target.value)} className={`${INPUT} mt-1 resize-y`} /></label>
      {field('headline', T('Título', 'Headline'), 40)}
      {field('description', T('Descripción', 'Description'), 30)}
      <label><span className={LABEL}>{T('Botón en Meta', 'Button on Meta')}</span>
        <select value={v.cta_type} onChange={(e) => set('cta_type', e.target.value)} className={`${INPUT} mt-1`}>{CTAS.map(([id, es, en]) => <option key={id} value={id}>{T(es, en)}</option>)}</select>
      </label>
      {field('link', T('Link de destino', 'Destination link'), 300)}
      <div className="min-[560px]:col-span-2 flex justify-end">
        <button onClick={save} disabled={saving} className={PRIMARY}>{saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {T('Guardar y volver a hacer el video', 'Save and remake the video')}</button>
      </div>
    </div>
  )
}

function MetaBlock({ ad, data, publishing, setPublishing, onData, reload }: { ad: Ad; data: AdsPayload; publishing: boolean; setPublishing: (v: boolean) => void; onData: (d: AdsPayload) => void; reload: () => void }) {
  const T = useT()
  const meta = data.meta
  const m = ad.meta
  const connect = async () => {
    try {
      const { url } = await api.metaAdsStart()
      const w = window.open(url, 'tably-meta-ads', 'width=620,height=760')
      if (!w) location.href = url
    } catch (e) { toast.error(T('No se pudo conectar Meta Ads', 'Could not connect Meta Ads'), (e as Error).message) }
  }
  return (
    <div className="mt-4 rounded-xl border border-line px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0082FB]/12 text-[#0082FB]"><Megaphone size={14} /></span>
        <span className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink">Meta Ads{meta.connected && meta.account ? <span className="font-normal text-ink-3"> · {meta.account}</span> : null}</span>
        {m?.status === 'done' && m.manager_url ? (
          <a href={m.manager_url} target="_blank" rel="noreferrer" className={PILL}><ExternalLink size={14} /> {T('Abrir en el Administrador de anuncios', 'Open in Ads Manager')}</a>
        ) : !meta.ready ? (
          <a href="https://adsmanager.facebook.com/" target="_blank" rel="noreferrer" className={PILL}><ExternalLink size={14} /> {T('Abrir el Administrador de anuncios', 'Open Ads Manager')}</a>
        ) : !meta.connected || meta.expired ? (
          <button onClick={connect} className={PRIMARY}><Link2 size={14} /> {meta.expired ? T('Volver a conectar Meta Ads', 'Reconnect Meta Ads') : T('Conectar Meta Ads', 'Connect Meta Ads')}</button>
        ) : m?.status !== 'publishing' && !publishing ? (
          <button onClick={() => setPublishing(true)} className={PRIMARY}><Megaphone size={14} /> {m?.status === 'error' ? T('Reintentar la publicación', 'Retry publishing') : T('Publicar en Meta Ads', 'Publish to Meta Ads')}</button>
        ) : null}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
        {m?.status === 'done' ? T('La campaña quedó creada en pausa con los dos videos. Revisala y activala en el Administrador de anuncios: hasta que la actives no se gasta nada.', 'The campaign was created paused with both videos. Review it and turn it on in Ads Manager: nothing is spent until you do.')
          : m?.status === 'publishing' ? <span className="flex items-center gap-1.5 text-ink-2"><Loader2 size={13} className="animate-spin text-accent" /> {m.step}</span>
          : m?.status === 'error' ? <span className="text-danger">{m.error}</span>
          : !meta.ready ? T('Publicar directo desde Tably se habilita cuando Meta apruebe la app de Tably. Mientras, descargá los videos y subilos en el Administrador de anuncios: el texto de arriba ya está listo para copiar.', 'Publishing straight from Tably turns on once Meta approves the Tably app. Meanwhile, download the videos and upload them in Ads Manager: the copy above is ready to paste.')
          : !meta.connected ? T('Conectá tu cuenta publicitaria una sola vez. Tably crea la campaña en pausa: no se gasta nada hasta que la actives.', 'Connect your ad account once. Tably creates the campaign paused: nothing is spent until you turn it on.')
          : T('Se crea una campaña de tráfico en pausa con un anuncio vertical (Reels y Stories) y uno cuadrado (feed).', 'A paused traffic campaign is created with a vertical ad (Reels and Stories) and a square one (feed).')}
      </p>
      {publishing && meta.connected && <PublishForm ad={ad} onDone={(d) => { onData(d); setPublishing(false); reload() }} onCancel={() => setPublishing(false)} />}
    </div>
  )
}

function PublishForm({ ad, onDone, onCancel }: { ad: Ad; onDone: (d: AdsPayload) => void; onCancel: () => void }) {
  const T = useT()
  const b = useBuild()
  const [assets, setAssets] = useState<Awaited<ReturnType<typeof api.metaAdsAssets>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [f, setF] = useState<MetaPublish>({ account_id: '', page_id: '', currency: 'USD', daily_budget: 5, countries: [T('AR', 'US')], age_min: 18, days: 7, link: ad.script?.link ?? '' })
  const [countries, setCountries] = useState(T('AR', 'US'))
  const [sending, setSending] = useState(false)
  useEffect(() => {
    api.metaAdsAssets().then((a) => {
      setAssets(a)
      const acc = a.accounts.find((x) => x.active) ?? a.accounts[0]
      setF((x) => ({ ...x, account_id: acc?.id ?? '', currency: acc?.currency ?? 'USD', page_id: a.pages[0]?.id ?? '' }))
    }).catch((e) => setErr((e as Error).message))
  }, [])
  const send = async () => {
    setSending(true)
    try { onDone(await api.adsToMeta(b.sessionId ?? '', b.id ?? '', ad.id, { ...f, countries: countries.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()) })) } catch (e) { toast.error(T('No se pudo publicar', 'Could not publish'), (e as Error).message) } finally { setSending(false) }
  }
  if (err) return <p className="mt-3 text-[13px] text-danger">{err}</p>
  if (!assets) return <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin" /> {T('Leyendo tus cuentas de Meta…', 'Reading your Meta accounts…')}</p>
  if (!assets.accounts.length || !assets.pages.length) return <p className="mt-3 text-[13px] text-ink-2">{!assets.accounts.length ? T('Tu cuenta de Meta no tiene cuentas publicitarias. Creá una en el Administrador de anuncios y volvé.', 'Your Meta account has no ad accounts. Create one in Ads Manager and come back.') : T('Hace falta una página de Facebook para publicar anuncios. Creá una y volvé.', 'A Facebook Page is needed to run ads. Create one and come back.')}</p>
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
      <label><span className={LABEL}>{T('Cuenta publicitaria', 'Ad account')}</span>
        <select value={f.account_id} onChange={(e) => { const a = assets.accounts.find((x) => x.id === e.target.value); setF({ ...f, account_id: e.target.value, currency: a?.currency ?? 'USD' }) }} className={`${INPUT} mt-1`}>
          {assets.accounts.map((a) => <option key={a.id} value={a.id} disabled={!a.active}>{a.name} · {a.currency}{a.active ? '' : T(' (inactiva)', ' (inactive)')}</option>)}
        </select>
      </label>
      <label><span className={LABEL}>{T('Página de Facebook', 'Facebook Page')}</span>
        <select value={f.page_id} onChange={(e) => setF({ ...f, page_id: e.target.value })} className={`${INPUT} mt-1`}>{assets.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      <label><span className={LABEL}>{T('Presupuesto diario', 'Daily budget')} ({f.currency})</span>
        <input type="number" min={1} step="any" value={f.daily_budget} onChange={(e) => setF({ ...f, daily_budget: Number(e.target.value) })} className={`${INPUT} mt-1`} /></label>
      <label><span className={LABEL}>{T('Días (vacío: sin fecha de fin)', 'Days (empty: no end date)')}</span>
        <input type="number" min={1} value={f.days ?? ''} onChange={(e) => setF({ ...f, days: e.target.value ? Number(e.target.value) : null })} className={`${INPUT} mt-1`} /></label>
      <label><span className={LABEL}>{T('Países (códigos, ej. AR, UY)', 'Countries (codes, e.g. US, CA)')}</span>
        <input value={countries} onChange={(e) => setCountries(e.target.value)} className={`${INPUT} mt-1`} /></label>
      <label><span className={LABEL}>{T('Edad mínima', 'Minimum age')}</span>
        <input type="number" min={13} max={65} value={f.age_min} onChange={(e) => setF({ ...f, age_min: Number(e.target.value) })} className={`${INPUT} mt-1`} /></label>
      <label className="min-[560px]:col-span-2"><span className={LABEL}>{T('Link de destino', 'Destination link')}</span>
        <input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://" className={`${INPUT} mt-1`} /></label>
      <div className="min-[560px]:col-span-2 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[12px] text-ink-3">{T('Se crea en pausa: no se gasta nada hasta que la actives.', 'It is created paused: nothing is spent until you turn it on.')}</span>
        <button onClick={onCancel} className={PILL}>{T('Cancelar', 'Cancel')}</button>
        <button onClick={send} disabled={sending || !f.link || !f.daily_budget} className={PRIMARY}>{sending ? <Loader2 size={14} className="animate-spin" /> : <Megaphone size={14} />} {T('Crear la campaña en pausa', 'Create the paused campaign')}</button>
      </div>
    </div>
  )
}

import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, MonitorSmartphone, RefreshCw, Sparkles, Trash2, Upload, UserRound, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type StudioGen, type StudioProject, type TwinState } from '../lib/api'
import { useT } from '../lib/i18n'
import { toast } from './Toast'

const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-5 text-[14px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent'
const LABEL = 'block text-[11.5px] font-semibold uppercase tracking-wide text-ink-3'

/** «Sin material»: the person's digital twin (HeyGen) says the script and stock shots (Pexels) go in between; then the Ad Studio's
 *  team edits it like any upload. Set up once: the two keys, one video of the person talking and HeyGen's consent. */
export default function TwinPanel({ cur, ensure, onCur }: { cur: StudioProject | null; ensure: () => Promise<StudioProject | null>; onCur: (p: StudioProject) => void }) {
  const T = useT()
  const [st, setSt] = useState<TwinState | null>(null)
  const [keys, setKeys] = useState({ heygen: '', pexels: '', pixabay: '' })
  const [showPexels, setShowPexels] = useState(false)
  const [busy, setBusy] = useState(false)
  const [up, setUp] = useState<number | null>(null)
  const [showApp, setShowApp] = useState(false)
  const [appUrl, setAppUrl] = useState(cur?.link || '')
  const [plan, setPlan] = useState<StudioGen | null>(cur?.gen?.status === 'draft' ? cur.gen : null)
  const fileRef = useRef<HTMLInputElement>(null)
  const load = () => api.twin().then(setSt).catch(() => {})
  useEffect(() => { load() }, [])
  // while HeyGen uploads, trains or waits for the consent, look again every few seconds
  const waiting = !!st?.twin && ['uploading', 'training', 'consent'].includes(st.twin.status)
  useEffect(() => {
    if (!waiting) return
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load() }, 8000)
    return () => window.clearInterval(t)
  }, [waiting])
  useEffect(() => { setPlan(cur?.gen?.status === 'draft' ? cur.gen : null) }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveKeys = async () => {
    setBusy(true)
    try { setSt(await api.twinKeys({ heygen: keys.heygen.trim() || undefined, pexels: keys.pexels.trim() || undefined, pixabay: keys.pixabay.trim() || undefined })); setKeys({ heygen: '', pexels: '', pixabay: '' }); toast.ok(T('Claves guardadas', 'Keys saved')) }
    catch (e) { toast.error(T('No se guardó la clave', 'The key was not saved'), (e as Error).message) } finally { setBusy(false) }
  }
  const footage = async (f: File) => {
    setUp(0)
    try { setSt(await api.twinFootage(f, setUp)) } catch (e) { toast.error(T('No se pudo subir el video', 'Could not upload the video'), (e as Error).message) } finally { setUp(null) }
  }
  const write = async () => {
    setBusy(true)
    try {
      const p = await ensure()
      if (p) setPlan(await api.studioGenPlan(p.id))
    } catch (e) { toast.error(T('No se pudo escribir el guion', 'Could not write the script'), (e as Error).message) } finally { setBusy(false) }
  }
  const go = async () => {
    if (!cur || !plan) return
    setBusy(true)
    try { onCur(await api.studioGenerate(cur.id, { voice: plan.voice, broll: plan.broll, app_url: showApp ? (appUrl || cur.link) : '' })); setPlan(null) }
    catch (e) { toast.error(T('No se pudo generar', 'Could not generate'), (e as Error).message) } finally { setBusy(false) }
  }

  if (!st) return null
  const tw = st.twin
  const stockOk = st.keys.pixabay.set || st.keys.pexels.set
  const keysOk = st.keys.heygen.set
  const words = (plan?.voice.match(/\S+/g) ?? []).length
  const step = 'flex gap-2.5 text-[12.5px] leading-snug text-ink-2'
  const num = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent'
  return (
    <div className="mt-4 rounded-2xl border border-accent/30 bg-accent-soft/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white"><Wand2 size={15} /></span>
        <div className="min-w-[min(100%,220px)] flex-1">
          <div className="text-[14.5px] font-bold text-ink">{T('¿No tenés material? Lo hace tu gemelo digital', 'No footage? Your digital twin makes it')}</div>
          <div className="text-[12px] text-ink-3">{T('Vos hablando a cámara con tu cara y tu voz (HeyGen) y tomas de apoyo gratis (Pixabay). El guion lo escribe Muse y el equipo lo edita como siempre.', 'You talking to camera with your face and voice (HeyGen) and free stock shots (Pixabay). Muse writes the script and the team edits it as usual.')}</div>
        </div>
        {tw?.status === 'ready' && <span className="flex items-center gap-1 rounded-full bg-[#2E9E6A]/15 px-2.5 py-1 text-[12px] font-semibold text-[#2E9E6A]"><CheckCircle2 size={13} /> {T('Tu gemelo está listo', 'Your twin is ready')}</span>}
      </div>

      {/* 1 · the keys */}
      {(!keysOk || !stockOk) && (
        <div className="mt-3 grid gap-3 min-[640px]:grid-cols-2">
          <label><span className={LABEL}>{T('Clave de API de HeyGen', 'HeyGen API key')} {st.keys.heygen.set && <span className="normal-case text-[#2E9E6A]">· {T('cargada', 'set')} ····{st.keys.heygen.last4}</span>}</span>
            <input type="password" autoComplete="off" value={keys.heygen} onChange={(e) => setKeys({ ...keys, heygen: e.target.value })} placeholder={st.keys.heygen.set ? T('(ya cargada)', '(already set)') : T('Pegala acá', 'Paste it here')} className={`${INPUT} mt-1`} />
            <a href="https://app.heygen.com/settings?nav=API" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline">{T('Sacala en HeyGen → Settings → API', 'Get it in HeyGen → Settings → API')} <ExternalLink size={11} /></a></label>
          <label><span className={LABEL}>{T('Clave de Pixabay (gratis, opcional)', 'Pixabay key (free, optional)')} {st.keys.pixabay.set && <span className="normal-case text-[#2E9E6A]">· {T('cargada', 'set')} ····{st.keys.pixabay.last4}</span>}</span>
            <input type="password" autoComplete="off" value={keys.pixabay} onChange={(e) => setKeys({ ...keys, pixabay: e.target.value })} placeholder={st.keys.pixabay.set ? T('(ya cargada)', '(already set)') : T('Pegala acá', 'Paste it here')} className={`${INPUT} mt-1`} />
            <a href="https://pixabay.com/api/docs/#api_search_videos" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline">{T('Creá una cuenta gratis en Pixabay y copiá tu clave de su página de API', 'Make a free Pixabay account and copy your key from its API page')} <ExternalLink size={11} /></a>
            {!showPexels && !st.keys.pexels.set && <button type="button" onClick={() => setShowPexels(true)} className="mt-0.5 block text-[11.5px] text-ink-3 underline">{T('¿Ya tenés clave de Pexels?', 'Already have a Pexels key?')}</button>}</label>
          {(showPexels || st.keys.pexels.set) && (
            <label><span className={LABEL}>{T('Clave de Pexels (si ya tenés una)', 'Pexels key (if you have one)')} {st.keys.pexels.set && <span className="normal-case text-[#2E9E6A]">· {T('cargada', 'set')} ····{st.keys.pexels.last4}</span>}</span>
              <input type="password" autoComplete="off" value={keys.pexels} onChange={(e) => setKeys({ ...keys, pexels: e.target.value })} placeholder={st.keys.pexels.set ? T('(ya cargada)', '(already set)') : T('Pegala acá', 'Paste it here')} className={`${INPUT} mt-1`} /></label>
          )}
          <p className="text-[11.5px] text-ink-3 min-[640px]:col-span-2">{T('HeyGen cobra los videos de tu saldo de API (no de los planes web). Sin clave de Pixabay el anuncio se arma solo con tu gemelo. Las claves se guardan cifradas.', 'HeyGen charges the videos to your API balance (not the web plans). Without a Pixabay key the ad is made with your twin alone. The keys are stored encrypted.')}</p>
          <button disabled={busy || (!keys.heygen.trim() && !keys.pexels.trim() && !keys.pixabay.trim())} onClick={saveKeys} className={`${PRIMARY} self-start`}>{busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} {T('Guardar las claves', 'Save the keys')}</button>
        </div>
      )}

      {/* 2 · the twin */}
      {st.keys.heygen.set && (!tw || tw.status === 'new' || tw.status === 'failed') && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="text-[13px] font-semibold text-ink">{T('Creá tu gemelo con un video tuyo hablando', 'Make your twin from a video of you talking')}</div>
          <ol className="flex flex-col gap-1.5">
            <li className={step}><span className={num}>1</span><span>{T('Con UN video alcanza: de 15 s a 10 min (lo ideal, unos 2 minutos), en 1080p, vos solo, mirando a cámara todo el tiempo, hablando claro y con la cara siempre en cuadro.', 'ONE video is enough: 15 s to 10 min (about 2 minutes is ideal), 1080p, just you, facing the camera the whole time, speaking clearly with your face always in frame.')}</span></li>
            <li className={step}><span className={num}>2</span><span>{T('De ese mismo video HeyGen clona tu voz. Después grabás un consentimiento corto en su página (lo pide para todo gemelo).', 'HeyGen clones your voice from that same video. Then you record a short consent on its page (it asks for it on every twin).')}</span></li>
            <li className={step}><span className={num}>3</span><span>{T('Listo: hacés todos los anuncios que quieras sin grabar más. Podés sumar otro video para otra «pinta» (otra ropa o fondo).', 'Done: make as many ads as you want without filming again. You can add another video for another «look» (other clothes or background).')}</span></li>
          </ol>
          {tw?.status === 'failed' && tw.error && <p className="flex gap-1.5 text-[12.5px] text-danger"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {tw.error}</p>}
          <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) footage(f); e.target.value = '' }} />
          <button disabled={up !== null} onClick={() => fileRef.current?.click()} className={`${PRIMARY} self-start`}>
            {up !== null ? <><Loader2 size={14} className="animate-spin" /> {T(`Subiendo… ${Math.round(up * 100)}%`, `Uploading… ${Math.round(up * 100)}%`)}</> : <><Upload size={14} /> {tw?.status === 'failed' ? T('Probar con otro video', 'Try another video') : T('Subir mi video', 'Upload my video')}</>}
          </button>
        </div>
      )}
      {tw && ['uploading', 'training', 'consent'].includes(tw.status) && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="flex items-center gap-2 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {tw.step || T('Trabajando…', 'Working…')}</p>
          {tw.consent_url && tw.consent_status !== 'accepted' && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-surface px-3 py-2.5">
              <UserRound size={16} className="text-accent" />
              <span className="min-w-[min(100%,220px)] flex-1 text-[12.5px] text-ink-2">{T('Grabá tu consentimiento: HeyGen te pide decir una frase corta a cámara para confirmar que sos vos. El link dura 24 horas.', 'Record your consent: HeyGen asks you to say a short sentence on camera to confirm it is you. The link lasts 24 hours.')}</span>
              <a href={tw.consent_url} target="_blank" rel="noreferrer" className={PRIMARY}><ExternalLink size={14} /> {T('Grabar mi consentimiento', 'Record my consent')}</a>
              <button onClick={() => api.twinConsent().then(setSt).catch((e) => toast.error(T('No se pudo', 'Could not'), (e as Error).message))} className={PILL}><RefreshCw size={13} /> {T('Pedir otro link', 'Get a new link')}</button>
            </div>
          )}
        </div>
      )}

      {/* 3 · the script, then the ad */}
      {tw?.status === 'ready' && keysOk && cur?.gen?.status !== 'working' && (
        <div className="mt-3 flex flex-col gap-2.5">
          {!plan ? (
            <button disabled={busy} onClick={write} className={`${PRIMARY} self-start`}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {T('Escribir el guion y las tomas', 'Write the script and the shots')}</button>
          ) : (
            <>
              <label><span className={LABEL}>{T('Lo que decís a cámara', 'What you say to camera')} <span className="normal-case font-normal">· {words} {T('palabras', 'words')} ≈ {Math.round(words / 2.6)} s</span></span>
                <textarea value={plan.voice} onChange={(e) => setPlan({ ...plan, voice: e.target.value })} rows={4} maxLength={1200} className={`${INPUT} mt-1 resize-y`} /></label>
              {stockOk && <div><span className={LABEL}>{T('Tomas de apoyo (búsqueda en el banco de videos)', 'Stock shots (stock video search)')}</span>
                <div className="mt-1 flex flex-col gap-1.5">
                  {plan.broll.map((b, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 text-center text-[12px] font-semibold text-ink-3">{i + 1}</span>
                      <input value={b.query} onChange={(e) => setPlan({ ...plan, broll: plan.broll.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)) })} className={`${INPUT} font-mono text-[12.5px]`} />
                      <span className="hidden min-w-0 flex-1 truncate text-[12px] text-ink-3 min-[640px]:block">{b.shows}</span>
                      <button onClick={() => setPlan({ ...plan, broll: plan.broll.filter((_, j) => j !== i) })} aria-label={T('Quitar', 'Remove')} className="rounded-full p-1.5 text-ink-3 hover:text-danger"><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              </div>}
              <div className="rounded-xl border border-line bg-surface p-3">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink"><input type="checkbox" checked={showApp} onChange={(e) => { setShowApp(e.target.checked); if (!appUrl) setAppUrl(cur?.link || '') }} className="accent-[var(--color-accent)]" /> <MonitorSmartphone size={14} className="text-accent" /> {T('Mostrar mi app mientras hablo', 'Show my app while I talk')}</label>
                <p className="mt-1 text-[11.5px] text-ink-3">{T('Tably abre tu app como un celular, la recorre y la graba; el equipo la muestra cuando hablás de lo que hace.', 'Tably opens your app like a phone, walks through it and records it; the team shows it when you talk about what it does.')}</p>
                {showApp && <input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://elevum.com" type="url" autoComplete="off" className={`${INPUT} mt-2`} />}
              </div>
              <p className="text-[11.5px] text-ink-3">{T(`HeyGen va a hacer ~${Math.round(words / 2.6)} s de video de tu gemelo con tu saldo de API.`, `HeyGen will make ~${Math.round(words / 2.6)} s of your twin's video from your API balance.`)} {stockOk ? T('Las tomas de apoyo son gratis.', 'The stock shots are free.') : T('Sin tomas de apoyo: cargá una clave de Pixabay arriba si las querés.', 'No stock shots: add a Pixabay key above if you want them.')}</p>
              <div className="flex flex-wrap gap-2">
                <button disabled={busy || words < 8 || (showApp && !appUrl.trim())} onClick={go} className={PRIMARY}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} {T('Generar el anuncio', 'Generate the ad')}</button>
                <button disabled={busy} onClick={write} className={PILL}><RefreshCw size={13} /> {T('Escribir otro', 'Write another')}</button>
              </div>
            </>
          )}
        </div>
      )}
      {tw && tw.status !== 'new' && !waiting && up === null && (
        <button onClick={() => { if (window.confirm(T('¿Dejar de usar este gemelo en Tably? Sigue en tu cuenta de HeyGen.', 'Stop using this twin in Tably? It stays in your HeyGen account.'))) api.twinForget().then(setSt) }} className="mt-3 text-[11.5px] text-ink-4 underline hover:text-danger">{T('Dejar de usar este gemelo', 'Stop using this twin')}</button>
      )}
    </div>
  )
}

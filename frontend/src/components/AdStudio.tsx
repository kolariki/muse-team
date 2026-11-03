import { AlertTriangle, BadgeCheck, CheckCircle2, Clapperboard, Download, Ear, Film, ImageIcon, KeyRound, Loader2, MonitorSmartphone, Plus, RotateCcw, Scissors, Square, Trash2, Upload, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PageLoader } from './HomeLoader'
import { api, type StudioEvent, type StudioList, type StudioProject } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import PageHeader from './PageHeader'
import TwinPanel from './TwinPanel'
import { toast } from './Toast'

const CARD = 'rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'
const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-5 text-[14px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent'
const LABEL = 'block text-[11.5px] font-semibold uppercase tracking-wide text-ink-3'
const ICONS = { listen: Ear, plan: Clapperboard, edit: Scissors, improve: Wand2, review: BadgeCheck } as const
const GOALS: [StudioProject['goal'], string, string][] = [['sell', 'Vender', 'Sell'], ['signup', 'Que se registren', 'Get sign-ups'], ['awareness', 'Darse a conocer', 'Get known']]
type Up = { name: string; p: number; err?: string }

/** The Ad Studio: the user's own videos and images become a finished ad, made by five agents that listen, plan, cut,
 *  improve and approve (sending it back until it is right). */
export default function AdStudio({ onBack }: { onBack: () => void }) {
  const T = useT()
  const en = T('es', 'en') === 'en'
  const [list, setList] = useState<StudioList | null>(null)
  const [cur, setCur] = useState<StudioProject | null>(null)
  const [draft, setDraft] = useState({ title: '', instructions: '', link: '', goal: 'sell' as StudioProject['goal'] })
  const [ups, setUps] = useState<Up[]>([])
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const whatRef = useRef<HTMLTextAreaElement>(null)
  const [needWhat, setNeedWhat] = useState(false)

  const [failed, setFailed] = useState(false)
  const loadList = () => api.studioList().then(setList).catch((e) => { setFailed(true); toast.error(tr('No pude leer tus anuncios', 'Could not read your ads'), (e as Error).message) })
  useEffect(() => { loadList() }, [])
  useEffect(() => { const sid = useArena.getState().studioOpen; if (sid) { useArena.getState().set({ studioOpen: null }); open(sid) } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // while the team works, follow it
  useEffect(() => {
    if (!cur?.running && cur?.status !== 'running' && cur?.tour?.status !== 'working') return
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') api.studio(cur.id).then((p) => { setCur(p); if (!p.running) loadList() }).catch(() => {}) }, 2500)
    return () => window.clearInterval(t)
  }, [cur?.id, cur?.running, cur?.status, cur?.tour?.status])

  const open = (id: string) => api.studio(id).then((p) => { setCur(p); setDraft({ title: p.title, instructions: p.instructions, link: p.link, goal: p.goal }) })
  const fresh = () => { setCur(null); setDraft({ title: '', instructions: '', link: '', goal: 'sell' }); setUps([]) }

  const upload = async (files: File[]) => {
    if (!files.length) return
    let p = cur
    try {
      if (!p) {
        p = await api.studioCreate({ ...draft, title: draft.title || files[0].name.replace(/\.[^.]+$/, '').slice(0, 60), lang: en ? 'en' : 'es' })
        setCur(p)
        setDraft((d) => ({ ...d, title: p!.title }))
      }
    } catch (e) { return toast.error(T('No se pudo crear el anuncio', 'Could not create the ad'), (e as Error).message) }
    for (const f of files) {
      setUps((u) => [...u, { name: f.name, p: 0 }])
      try {
        const next = await api.studioUpload(p.id, f, (x) => setUps((u) => u.map((it) => (it.name === f.name ? { ...it, p: x } : it))))
        setCur(next)
        setUps((u) => u.filter((it) => it.name !== f.name))
      } catch (e) {
        setUps((u) => u.map((it) => (it.name === f.name ? { ...it, err: (e as Error).message } : it)))
      }
    }
    loadList()
  }
  const save = async (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    if (cur) api.studioPatch(cur.id, patch).then(setCur).catch(() => {})
  }
  const run = async () => {
    if (!cur) return
    try { setCur(await api.studioRun(cur.id)) } catch (e) { toast.error(T('No se pudo arrancar', 'Could not start'), (e as Error).message) }
  }

  const busy = !!cur && (cur.running || cur.status === 'running')
  // the ad the twin panel works on: the open one (with what is typed now), or a new one made from the form
  const ensure = async (fallbackTitle = '') => {
    try {
      if (cur) { const p = await api.studioPatch(cur.id, { title: draft.title, instructions: draft.instructions, link: draft.link }); setCur(p); return p }
      if (!draft.instructions.trim() && !fallbackTitle) {
        // take them to the field instead of only saying it
        setNeedWhat(true)
        whatRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        whatRef.current?.focus({ preventScroll: true })
        return null
      }
      const p = await api.studioCreate({ ...draft, title: draft.title || draft.instructions.slice(0, 60) || fallbackTitle, lang: en ? 'en' : 'es' })
      setCur(p); setDraft((d) => ({ ...d, title: p.title })); loadList()
      return p
    } catch (e) { toast.error(T('No se pudo guardar el anuncio', 'Could not save the ad'), (e as Error).message); return null }
  }
  // «Grabar mi app»: Muse Team opens the app like a phone, scrolls it and adds the recording to the material
  const [tourUrl, setTourUrl] = useState<string | null>(null)
  const recordApp = async () => {
    const url = (tourUrl ?? (draft.link || cur?.tour?.url || '')).trim()
    if (!url) { toast.error(T('Pegá el link de tu app', 'Paste your app link')); return }
    if (!draft.link.trim()) { draft.link = url; setDraft((d) => ({ ...d, link: url })) } // it is also where the ad sends people
    const p = await ensure(url.replace(/^https?:\/\//, '').split('/')[0])
    if (!p) return
    try { setCur(await api.studioTour(p.id, url)); setTourUrl(null) } catch (e) { toast.error(T('No se pudo grabar', 'Could not record'), (e as Error).message) }
  }
  const touring = cur?.tour?.status === 'working'
  const agents = list?.agents ?? []
  if (!list && !failed) return <PageLoader caption={T('Abriendo el estudio de anuncios…', 'Opening the ad studio…')} />
  return (
    <div className="min-h-full bg-paper">
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader onBack={onBack} kicker={T('Estudio de anuncios', 'Ad Studio')} title={T('Un anuncio con tus videos e imágenes', 'An ad from your videos and images')}
          subtitle={T('Subí lo que tengas. El equipo escucha lo que se dice, elige los mejores momentos, arma el video con subtítulos, transiciones y tus imágenes, lo revisa hasta aprobarlo y te lo deja en vertical y cuadrado para Meta.', 'Upload what you have. The team listens to what is said, picks the best moments, edits the video with subtitles, transitions and your images, reviews it until it is approved and gives it to you vertical and square for Meta.')} />

        {list && !list.ready && <p className="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">{T('Este servidor no tiene el motor de video instalado.', 'This server does not have the video engine installed.')}</p>}
        {list && !list.model && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-ink-2">
            <AlertTriangle size={15} className="text-danger" />
            <span className="min-w-[min(100%,260px)] flex-1">{T('El equipo necesita una clave de modelo para trabajar. Recomendado: Meta Muse, que además escucha tus videos.', 'The team needs a model key to work. Recommended: Meta Muse, which also listens to your videos.')}</span>
            <button onClick={() => useArena.getState().set({ view: 'settings' })} className={PILL}><KeyRound size={14} /> {T('Agregar clave', 'Add key')}</button>
          </div>
        )}
        {list && list.model && !list.transcriber && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#C28A12]/40 bg-[#C28A12]/10 px-3 py-2 text-[13px] text-ink-2">
            <AlertTriangle size={15} className="text-[#C28A12]" />
            <span className="min-w-[min(100%,260px)] flex-1">{T('Para escuchar tus videos y subtitularlos, el equipo usa Meta Muse Voice Transcribe: agregá tu clave de Meta. Sin eso, arma el anuncio con lo que se ve.', 'To listen to your videos and subtitle them the team uses Meta Muse Voice Transcribe: add your Meta key. Without it, the ad is built from what is on screen.')}</span>
            <button onClick={() => useArena.getState().set({ view: 'settings' })} className={PILL}><KeyRound size={14} /> {T('Agregar clave', 'Add key')}</button>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          {/* the user's ads */}
          <aside data-tour="studio-ads" className="flex flex-col gap-2">
            <button onClick={fresh} className={`${PILL} justify-center`}><Plus size={14} /> {T('Anuncio nuevo', 'New ad')}</button>
            {(list?.projects ?? []).map((p) => (
              <button key={p.id} onClick={() => open(p.id)} className={`flex items-center gap-2.5 rounded-xl border p-2 text-left transition ${cur?.id === p.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-accent/60'}`}>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2">
                  {p.media[0]?.thumb ? <img src={api.studioFileUrl(p.id, p.media[0].thumb)} alt="" className="h-full w-full object-cover" /> : <Film size={16} className="text-ink-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-ink">{p.title}</span>
                  <span className="block text-[11.5px] text-ink-3">{p.status === 'done' ? T('Listo', 'Ready') : p.running || p.status === 'running' ? T('El equipo trabaja…', 'Team working…') : p.status === 'error' ? T('Con error', 'Failed') : T(`${p.media.length} archivos`, `${p.media.length} files`)}</span>
                </span>
              </button>
            ))}
          </aside>

          <main className="flex min-w-0 flex-col gap-4">
            {/* what to advertise + the material */}
            <section className={CARD}>
              <div data-tour="studio" className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2">
                <label className="min-[640px]:col-span-2"><span className={LABEL}>{T('¿Qué querés anunciar?', 'What do you want to advertise?')}</span>
                  <textarea ref={whatRef} value={draft.instructions} disabled={busy} onChange={(e) => { setDraft({ ...draft, instructions: e.target.value }); if (e.target.value.trim()) setNeedWhat(false) }} onBlur={() => save({ instructions: draft.instructions })} rows={2} maxLength={2000}
                    placeholder={T('Ej.: mi estudio de uñas en Palermo; que reserven el primer turno con 20 % off', 'E.g.: my nail studio; get them to book the first appointment at 20% off')} className={`${INPUT} mt-1 resize-y ${needWhat ? 'ring-2 ring-accent' : ''}`} />
                  {needWhat && <span className="mt-1 block text-[12px] font-semibold text-accent">{T('Escribí acá qué querés anunciar y volvé a tocar «Escribir el guion y las tomas». Con esto Muse escribe lo que decís.', 'Write here what you want to advertise and tap «Write the script and shots» again. Muse uses it to write what you say.')}</span>}</label>
                <label><span className={LABEL}>{T('Nombre', 'Name')}</span><input value={draft.title} disabled={busy} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onBlur={() => save({ title: draft.title })} maxLength={80} className={`${INPUT} mt-1`} /></label>
                <label><span className={LABEL}>{T('Link de destino', 'Destination link')}</span><input value={draft.link} disabled={busy} onChange={(e) => setDraft({ ...draft, link: e.target.value })} onBlur={() => save({ link: draft.link })} placeholder="https://" maxLength={300} type="url" name="ad-destination-link" autoComplete="off" className={`${INPUT} mt-1`} /></label>
                <div className="min-[640px]:col-span-2 flex flex-wrap items-center gap-1.5">
                  <span className={`${LABEL} mr-1`}>{T('Objetivo', 'Goal')}</span>
                  {GOALS.map(([k, es, e2]) => <button key={k} type="button" disabled={busy} onClick={() => save({ goal: k })} className={`rounded-full border px-3 py-1 text-[12.5px] ${draft.goal === k ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent'}`}>{T(es, e2)}</button>)}
                </div>
              </div>

              <div data-tour="studio-files" onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) upload([...e.dataTransfer.files]) }}
                className={`mt-4 rounded-2xl border-2 border-dashed p-4 transition ${drag ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                <input ref={fileRef} type="file" multiple accept="video/*,image/*" className="hidden" onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = '' }} />
                {!cur?.media.length && !ups.length ? (
                  <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-2 py-6 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent"><Upload size={22} /></span>
                    <span className="text-[15px] font-semibold text-ink">{T('Arrastrá tus videos e imágenes o tocá para elegirlos', 'Drag your videos and images or tap to pick them')}</span>
                    <span className="text-[12.5px] text-ink-3">{list ? T(`Videos de hasta ${list.limits.video_mb} MB (en total ${list.limits.minutes} minutos), imágenes de hasta ${list.limits.image_mb} MB, hasta ${list.limits.files} archivos`, `Videos up to ${list.limits.video_mb} MB (${list.limits.minutes} minutes in all), images up to ${list.limits.image_mb} MB, up to ${list.limits.files} files`) : ''}</span>
                  </button>
                ) : (
                  <div className="grid grid-cols-3 gap-2 min-[520px]:grid-cols-4 min-[860px]:grid-cols-6">
                    {cur?.media.map((m) => (
                      <div key={m.id} className="group relative aspect-[3/4] overflow-hidden rounded-xl border border-line bg-black">
                        {m.thumb && <img src={api.studioFileUrl(cur.id, m.thumb)} alt={m.name} className="h-full w-full object-cover" />}
                        <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10.5px] font-semibold text-white">{m.kind === 'video' ? <Film size={10} /> : <ImageIcon size={10} />}{m.kind === 'video' ? `${Math.round(m.duration ?? 0)} s` : T('imagen', 'image')}</span>
                        {!busy && <button onClick={() => api.studioDeleteMedia(cur.id, m.id).then(setCur).catch((e) => toast.error(T('No se pudo quitar', 'Could not remove'), (e as Error).message))} aria-label={T('Quitar', 'Remove')} className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"><X size={12} /></button>}
                      </div>
                    ))}
                    {ups.map((u) => (
                      <div key={u.name} className="relative flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 p-2 text-center">
                        {u.err ? <AlertTriangle size={18} className="text-danger" /> : <Loader2 size={18} className="animate-spin text-accent" />}
                        <span className="w-full truncate text-[11px] text-ink-2">{u.name}</span>
                        {u.err ? <span className="text-[10.5px] leading-tight text-danger">{u.err}</span> : <span className="h-1 w-full overflow-hidden rounded-full bg-surface"><span className="block h-full bg-accent" style={{ width: `${Math.round(u.p * 100)}%` }} /></span>}
                        {u.err && <button onClick={() => setUps((x) => x.filter((it) => it.name !== u.name))} className="text-[11px] text-ink-3 underline">{T('Cerrar', 'Close')}</button>}
                      </div>
                    ))}
                    {!busy && <button type="button" onClick={() => fileRef.current?.click()} className="flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-ink-3 transition hover:border-accent hover:text-accent"><Plus size={18} /><span className="text-[11.5px]">{T('Sumar', 'Add')}</span></button>}
                  </div>
                )}
              </div>

              {!busy && (
                <div data-tour="studio-record" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-[12.5px] text-ink-2">
                  <MonitorSmartphone size={15} className="shrink-0 text-accent" />
                  <span className="min-w-[min(100%,220px)] flex-1">{touring ? (cur?.tour?.step || T('Grabando tu app…', 'Recording your app…')) : T('¿Es una app o una web? Muse Team la abre como un celular, la recorre y suma la grabación.', 'Is it an app or a website? Muse Team opens it like a phone, walks through it and adds the recording.')}</span>
                  {touring ? <Loader2 size={15} className="animate-spin text-accent" /> : <>
                    <input value={tourUrl ?? (draft.link || cur?.tour?.url || '')} onChange={(e) => setTourUrl(e.target.value)} placeholder="https://" type="url" autoComplete="off" className="h-8 w-full rounded-lg border border-line bg-paper px-2.5 text-[12.5px] outline-none focus:border-accent min-[640px]:w-56" />
                    <button onClick={recordApp} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110"><Film size={13} /> {T('Grabar mi app', 'Record my app')}</button>
                  </>}
                  {cur?.tour?.status === 'error' && !touring && <span className="w-full text-[12px] text-danger">{cur.tour.error} {T('Tocá «Grabar mi app» para probar de nuevo.', 'Tap «Record my app» to try again.')}</span>}
                </div>
              )}
              {!busy && !cur?.media.length && !ups.length && <div data-tour="studio-twin"><TwinPanel cur={cur} ensure={() => ensure()} onCur={(p) => { setCur(p); loadList() }} /></div>}
              {cur?.gen?.status === 'working' && (
                <p className="mt-4 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2.5 text-[13px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" /> {cur.gen.step || T('Generando el material…', 'Generating the footage…')}</p>
              )}
              {!!cur?.gen?.credits?.length && <p className="mt-2 text-[11.5px] text-ink-4">{T('Tomas de apoyo: ', 'Stock shots: ')}{cur.gen.credits.map((c, i) => <a key={i} href={c.page} target="_blank" rel="noreferrer" className="hover:underline">{i ? ', ' : ''}{c.author}{c.site ? ` (${c.site})` : ''}</a>)}</p>}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {busy ? (
                  <button onClick={() => cur && api.studioStop(cur.id).then(setCur)} className={PILL}><Square size={13} /> {T('Detener', 'Stop')}</button>
                ) : (
                  <button onClick={run} disabled={!cur?.media.length || !!ups.some((u) => !u.err) || !list?.ready} className={PRIMARY}>
                    {cur?.status === 'done' || cur?.status === 'error' ? <RotateCcw size={15} /> : <Clapperboard size={15} />} {cur?.status === 'done' ? T('Hacer otra versión', 'Make another version') : cur?.status === 'error' ? T('Reintentar desde donde quedó', 'Retry from where it stopped') : T('Armar el anuncio con el equipo', 'Make the ad with the team')}
                  </button>
                )}
                {cur && !busy && <button onClick={() => { if (window.confirm(T('¿Borrar este anuncio y sus archivos?', 'Delete this ad and its files?'))) api.studioDelete(cur.id).then(() => { fresh(); loadList() }) }} className="ml-auto flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition hover:bg-danger/10 hover:text-danger" aria-label={T('Borrar el anuncio', 'Delete the ad')}><Trash2 size={15} /></button>}
                {cur?.status === 'error' && <span className="w-full text-[13px] text-danger">{cur.error}</span>}
              </div>
            </section>

            {cur && (cur.timeline?.length || busy || cur.final) ? (
              <>
                {/* the five agents */}
                <section className="grid grid-cols-2 gap-2 min-[640px]:grid-cols-5">
                  {agents.map((a) => {
                    const st = cur.agents?.[a.id]?.status ?? 'waiting'
                    const Icon = ICONS[a.id as keyof typeof ICONS] ?? Wand2
                    return (
                      <div key={a.id} className={`rounded-xl border p-3 ${st === 'working' && busy ? 'border-accent bg-accent-soft' : st === 'error' ? 'border-danger/40 bg-danger/5' : st === 'returned' ? 'border-[#C28A12]/50 bg-[#C28A12]/10' : 'border-line bg-surface'}`}>
                        <div className="flex items-center gap-2">
                          <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${st === 'done' ? 'bg-[#2E9E6A]/15 text-[#2E9E6A]' : 'bg-accent-soft text-accent'}`}>{st === 'working' && busy ? <Loader2 size={15} className="animate-spin" /> : st === 'done' ? <CheckCircle2 size={15} /> : st === 'error' ? <AlertTriangle size={15} className="text-danger" /> : <Icon size={15} />}</span>
                          <span className="text-[13px] font-bold text-ink">{T(a.es, a.en)}</span>
                        </div>
                        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{T(a.role_es, a.role_en)}</p>
                        <p className="mt-1 text-[11px] font-semibold text-ink-2">{st === 'error' || (st === 'working' && !busy) ? T('se trabó acá', 'stuck here') : st === 'working' ? T('trabajando', 'working') : st === 'done' ? T('listo', 'done') : st === 'returned' ? T('lo devolvió', 'sent it back') : T('en espera', 'waiting')}{cur.agents?.[a.id]?.by ? <span className="font-normal text-ink-4"> · {cur.agents[a.id].by}</span> : null}</p>
                      </div>
                    )
                  })}
                </section>

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className={`${CARD} flex flex-col gap-3`}>
                    <h3 className="text-[15px] font-bold text-ink">{T('Lo que hizo el equipo', 'What the team did')}{cur.round ? <span className="ml-2 text-[12px] font-normal text-ink-3">{T(`vuelta ${cur.round}`, `round ${cur.round}`)}</span> : null}</h3>
                    {(cur.timeline ?? []).map((e, i) => <Event key={i} e={e} p={cur} names={Object.fromEntries(agents.map((a) => [a.id, T(a.es, a.en)]))} />)}
                    {busy && <div className="flex items-center gap-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin text-accent" /> {T('Trabajando…', 'Working…')}</div>}
                  </div>
                  <div className="flex flex-col gap-3">
                    {cur.final ? (
                      <div className={CARD}>
                        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-bold text-ink"><CheckCircle2 size={15} className="text-[#2E9E6A]" /> {cur.final.approved ? T('Aprobado y listo', 'Approved and ready') : T('Listo (con observaciones)', 'Ready (with notes)')}</div>
                        {(['vertical', 'square'] as const).map((f) => (
                          <figure key={f} className="mb-3">
                            <video src={api.studioFileUrl(cur.id, cur.final![f], cur.final!.ts)} poster={api.studioFileUrl(cur.id, cur.final![f].replace('.mp4', '.jpg'), cur.final!.ts)} controls playsInline preload="none" className={`w-full rounded-xl border border-line bg-black ${f === 'vertical' ? 'aspect-[9/16]' : 'aspect-square'}`} />
                            <figcaption className="mt-1 flex items-center justify-between text-[12px] text-ink-3">{f === 'vertical' ? T('9:16 · Reels y Stories', '9:16 · Reels and Stories') : T('1:1 · feed', '1:1 · feed')}
                              <a href={api.studioFileUrl(cur.id, cur.final![f], cur.final!.ts, true)} download className="flex items-center gap-1 font-semibold text-accent"><Download size={12} /> MP4</a></figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : cur.preview ? (
                      <div className={CARD}>
                        <div className="mb-2 text-[13px] font-bold text-ink">{T(`Corte ${cur.preview.round + 1}`, `Cut ${cur.preview.round + 1}`)}</div>
                        <video key={cur.preview.file} src={api.studioFileUrl(cur.id, cur.preview.file, cur.preview.ts)} controls autoPlay muted loop playsInline className="aspect-[9/16] w-full rounded-xl border border-line bg-black" />
                        <p className="mt-2 text-[11.5px] text-ink-4">{T('Vista previa a media resolución. El final sale en alta.', 'Half-resolution preview. The final one comes out in full.')}</p>
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : null}
          </main>
        </div>
      </div>
    </div>
  )
}

/** One step of an agent in the timeline: what it found, planned, changed or decided. */
function Event({ e, p, names }: { e: StudioEvent; p: StudioProject; names: Record<string, string> }) {
  const T = useT()
  const Icon = ICONS[e.agent] ?? Wand2
  const media = Object.fromEntries(p.media.map((m) => [m.id, m.name]))
  if (e.kind === 'step') return <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Icon size={13} className="text-accent" /> <b className="text-ink-2">{names[e.agent]}</b> {e.text}</div>
  return (
    <div className={`rounded-xl border p-3 text-[13px] ${e.kind === 'verdict' ? (e.data.approved ? 'border-[#2E9E6A]/40 bg-[#2E9E6A]/5' : 'border-[#C28A12]/40 bg-[#C28A12]/5') : e.kind === 'warn' ? 'border-[#C28A12]/40 bg-[#C28A12]/5' : 'border-line bg-surface-2/40'}`}>
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink"><Icon size={14} className="text-accent" /> {names[e.agent]}{e.round ? <span className="text-[11px] font-normal text-ink-4">· {T(`vuelta ${e.round}`, `round ${e.round}`)}</span> : null}</div>
      {e.text && <p className="leading-relaxed text-ink-2">{e.text}</p>}
      {e.data.highlights && e.data.highlights.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {e.data.highlights.map((h, i) => <li key={i} className="text-[12.5px] text-ink-2"><span className="font-mono text-[11px] text-ink-4">{media[h.video] ?? h.video} {h.start.toFixed(1)}–{h.end.toFixed(1)} s</span> «{h.quote}» <span className="text-ink-4">— {h.why}</span></li>)}
        </ul>
      )}
      {e.data.plan && (
        <ol className="mt-2 flex flex-col gap-1 text-[12.5px] text-ink-2">
          {e.data.plan.sequence.map((s, i) => <li key={i}><span className="font-mono text-[11px] text-ink-4">{i + 1}.</span> {s.type === 'video' ? `${T('Video', 'Video')} ${media[s.media ?? ''] ?? ''} ${s.from?.toFixed(1)}–${s.to?.toFixed(1)} s` : s.type === 'image' ? `${T('Imagen', 'Image')} ${media[s.media ?? ''] ?? ''} · ${s.d} s` : `${T('Placa', 'Card')} · ${s.d} s`}{s.title || s.text ? ` — «${s.title || s.text}»` : ''}</li>)}
        </ol>
      )}
      {e.kind === 'verdict' && (
        <div className="mt-2 flex flex-col gap-1 text-[12.5px]">
          {(e.data.strengths ?? []).map((x, i) => <span key={`s${i}`} className="text-[#2E9E6A]">✓ {x}</span>)}
          {(e.data.fix ?? []).map((x, i) => <span key={`f${i}`} className="text-ink-2">→ {x}</span>)}
        </div>
      )}
    </div>
  )
}

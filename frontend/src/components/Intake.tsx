import DOMPurify from 'dompurify'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, FileText, FolderOpen, FolderPlus, Loader2, Maximize2, Paperclip, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'
import FieldTitle from './FieldTitle'
import { createPortal } from 'react-dom'
import { intake as intakeApi, type IntakeQuestion, type IntakeState } from '../lib/api'
import { brandTheme } from '../lib/brand'
import { fmtUsd } from '../lib/parse'
import type { Provider } from '../types'
import AiPicker from './AiPicker'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'
import { tr, useT } from '../lib/i18n'

interface Props {
  idea: string
  onIdea: (text: string) => void
  providers: Provider[]
  onConnected?: (p: Provider) => void
  /** The generated Markdown prompt (and the attached material as context) is handed to the council config. */
  onPrompt: (markdown: string, context: string | null) => void
  /** Whether a generated prompt is currently what the council will debate. */
  promptActive: boolean
  onDiscardPrompt: () => void
  /** The team, so the analyst can also write a prompt per role tailored to this project. */
  team?: { id: string; name: string; role?: string | null; label?: string; mandate?: string; persona?: string }[]
  onRolePrompts?: (prompts: Record<string, string>) => void
}

const fmtSize = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n > 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`)

/**
 * "Qué querés construir" + attachments + «Generar prompt engineering a mi texto»: the analyst model reads everything,
 * shows what it is doing live, asks what it needs, and hands a Markdown brief to the council.
 */
export default function Intake({ idea, onIdea, providers, onConnected, onPrompt, promptActive, onDiscardPrompt, team, onRolePrompts }: Props) {
  const T = useT()
  const [st, setSt] = useState<IntakeState | null>(null)
  const [provider, setProvider] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [uploading, setUploading] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [showPath, setShowPath] = useState(false)
  const [thinking, setThinking] = useState('')
  const [reading, setReading] = useState<{ name: string; kind: string; chars: number }[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [showThinking, setShowThinking] = useState(false)
  const [sending, setSending] = useState(false) // answers sent, waiting for the analyst to pick them up
  const [extra, setExtra] = useState('')
  const [roleOffer, setRoleOffer] = useState<'ask' | 'working' | 'done' | 'skipped'>('ask') // prompts per role, offered after the brief
  const makeRolePrompts = async () => {
    if (!st || !team?.length) return
    setRoleOffer('working')
    try {
      const r = await intakeApi.rolePrompts(st.id, team, provider, model)
      onRolePrompts?.(r.prompts)
      setRoleOffer('done')
      toast.ok(tr('Prompts por rol listos', 'Role prompts ready'), tr(`${Object.keys(r.prompts).length} roles con su prompt a medida de este proyecto. Podés editarlos en cada tarjeta.`, `${Object.keys(r.prompts).length} roles got a prompt tailored to this project. You can edit them on each card.`))
    } catch (e) {
      setRoleOffer('ask')
      toast.error(tr('No se pudieron generar los prompts por rol', 'Could not generate the role prompts'), (e as Error).message)
    }
  } // what the user wants the model to add after a prompt exists
  const [full, setFull] = useState(false) // prompt opened at full screen
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const closeWs = useRef<() => void>(() => {})
  const liveRef = useRef<HTMLDivElement>(null) // the live-analysis panel, scrolled into view when work starts

  const ensure = async () => {
    if (st) return st
    const s = await intakeApi.create()
    setSt(s)
    return s
  }

  // live events from the analyst
  useEffect(() => {
    if (!st?.id) return
    closeWs.current()
    closeWs.current = intakeApi.connect(
      st.id,
      (ev) => {
        if (ev.type === 'snapshot') { setSt((cur) => ({ ...(cur ?? {}), ...(ev as IntakeState) })); return }
        if (ev.type === 'status') setSt((cur) => (cur ? { ...cur, status: ev.status, step: ev.step } : cur))
        if (ev.type === 'retry') { setThinking(''); toast.error(tr('Formato inesperado, le pido que lo repita', 'Unexpected format, asking it to repeat'), ev.reason) }
        if (ev.type === 'reading') setReading((r) => [...r.slice(-80), { name: ev.name, kind: ev.kind, chars: ev.chars }])
        if (ev.type === 'delta') setThinking((t) => (t + ev.delta).slice(-6000))
        if (ev.type === 'questions') {
          setTimeout(() => liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
          setSt((cur) => (cur ? { ...cur, status: 'waiting', questions: ev.questions, understanding: ev.understanding, rounds: ev.round } : cur))
          setAnswers({})
          setThinking('')
        }
        if (ev.type === 'done') {
          setSt((cur) => (cur ? { ...cur, status: 'done', prompt: ev.prompt, understanding: ev.understanding, cost_usd: ev.cost_usd } : cur))
          onPrompt(ev.prompt, ev.context ?? null)
          setRoleOffer('ask')
          toast.ok(tr('Prompt listo', 'Prompt ready'), tr('El consejo va a arrancar con este brief. Revisalo y editalo si querés.', 'The council will start from this brief. Review and edit it if you want.'))
        }
        if (ev.type === 'error') {
          setSt((cur) => (cur ? { ...cur, status: 'error', error: ev.error } : cur))
          toast.error(tr('No se pudo generar el prompt', 'Could not generate the prompt'), ev.error)
        }
      },
      () => {},
    )
    return () => closeWs.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.id])

  const addFiles = async (list: FileList | null, folder = false) => {
    if (!list || !list.length) return
    const files = Array.from(list).filter((f) => !f.name.startsWith('.'))
    if (!files.length) return
    setUploading(true)
    try {
      const s = await ensure()
      const paths = files.map((f) => (folder ? (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name : f.name))
      // in batches so a whole project doesn't go in one request
      let last: IntakeState | null = null
      for (let i = 0; i < files.length; i += 40) {
        last = await intakeApi.upload(s.id, files.slice(i, i + 40), paths.slice(i, i + 40))
      }
      if (last) setSt(last)
      toast.ok(`${files.length} ${files.length === 1 ? tr('archivo adjuntado', 'file attached') : tr('archivos adjuntados', 'files attached')}`)
    } catch (e) {
      toast.error(tr('No se pudo adjuntar', 'Could not attach'), (e as Error).message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
      if (dirRef.current) dirRef.current.value = ''
    }
  }

  // native Finder chooser (the backend runs on this Mac): folders/projects or documents, anywhere on the disk
  const pickNative = async (kind: 'folder' | 'files') => {
    setUploading(true)
    try {
      const s = await ensure()
      const r = await intakeApi.pick(s.id, kind)
      setSt(r)
      if (r.cancelled) return
      toast.ok(tr(`${r.added} archivo${r.added === 1 ? '' : 's'} adjuntado${r.added === 1 ? '' : 's'}`, `${r.added} file${r.added === 1 ? '' : 's'} attached`), r.errors?.length ? r.errors.join(' · ') : undefined)
    } catch (e) {
      const msg = (e as Error).message
      if (/macOS|nativo/i.test(msg)) setShowPath(true)  // not a Mac: fall back to typing the path
      toast.error(tr('No se pudo abrir el Finder', 'Could not open the Finder'), msg)
    } finally {
      setUploading(false)
    }
  }

  const addPath = async () => {
    if (!pathInput.trim()) return
    setUploading(true)
    try {
      const s = await ensure()
      const r = await intakeApi.addPath(s.id, pathInput.trim())
      setSt(r)
      setPathInput('')
      setShowPath(false)
      toast.ok(`${r.added} ${r.added === 1 ? tr('archivo de la carpeta', 'file from the folder') : tr('archivos de la carpeta', 'files from the folder')}`)
    } catch (e) {
      toast.error(tr('No se pudo leer la ruta', 'Could not read the path'), (e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const run = async (addition = '') => {
    if (!idea.trim()) return toast.error(tr('Escribí qué querés construir', 'Write what you want to build'))
    if (!provider) return toast.error(tr('Elegí una IA en la lista para analizar tu texto', 'Pick an AI from the list to analyse your text'))
    try {
      const s = await ensure()
      setReading([])
      setThinking('')
      setAnswers({})
      setEditing(false)
      const r = await intakeApi.run(s.id, idea, provider, model, addition)
      setSt(r)
      setTimeout(() => liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
      if (addition) setExtra('')
    } catch (e) {
      toast.error(tr('No se pudo arrancar el análisis', 'Could not start the analysis'), (e as Error).message)
    }
  }

  const send = async (ans: Record<string, string> = answers) => {
    if (!st || sending) return
    setSending(true)
    setThinking('')
    try {
      await intakeApi.answer(st.id, ans)
      // the form hides right away; the analyst's "status" event (running) arrives over the WS and takes over
      setSt((cur) => (cur ? { ...cur, status: 'running', step: tr('Procesando tus respuestas', 'Processing your answers') } : cur))
      setTimeout(() => liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    } catch (e) {
      toast.error(tr('No se pudieron enviar las respuestas', 'Could not send the answers'), (e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const cancel = async () => {
    if (!st) return
    await intakeApi.cancel(st.id).then(setSt).catch(() => {})
  }

  const promptHtml = useMemo(() => (st?.prompt ? DOMPurify.sanitize(marked.parse(st.prompt, { async: false }) as string) : ''), [st?.prompt])
  const busy = st?.status === 'running'
  const waiting = st?.status === 'waiting'
  const attachments = st?.attachments ?? []
  const theme = brandTheme(provider)

  return (
    <div className="space-y-3">
      {/* what the user wants — replaced by the generated prompt once there is one */}
      {!(st?.status === 'done' && st.prompt && promptActive) && (
      <label data-tour="idea" className="block">
        <FieldTitle title={T('Qué querés construir', 'What do you want to build')} sub={T('Contalo con tus palabras: para quién es y qué tiene que hacer.', 'Tell it in your own words: who it is for and what it must do.')} />
        <textarea
          className="mt-1 h-32 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent"
          value={idea}
          onChange={(e) => onIdea(e.target.value)}
          placeholder={T('Contá con tus palabras qué necesitás: para quién es, qué tiene que hacer, qué ya tenés (datos, diseños, un proyecto empezado)…', 'Tell in your own words what you need: who it is for, what it must do, what you already have (data, designs, a started project)…')}
          disabled={busy}
        />
      </label>
      )}

      {/* attachments */}
      <div data-tour="attach" className="rounded-xl border border-dashed border-line bg-surface/60 p-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-ink-3"><Paperclip size={13} className="inline align-[-2px]" />{T(' Adjuntá lo que ayude a entender el proyecto:', ' Attach whatever helps understand the project:')}</span>
          <button type="button" disabled={uploading || busy} onClick={() => fileRef.current?.click()} className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 hover:border-accent/50 disabled:opacity-50"><FileText size={12} />{T(' documentos', ' documents')}</button>
          <button type="button" disabled={uploading || busy} onClick={() => dirRef.current?.click()} className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 hover:border-accent/50 disabled:opacity-50"><FolderPlus size={12} />{T(' carpeta', ' folder')}</button>
          <button type="button" disabled={uploading || busy} onClick={() => pickNative('folder')} onContextMenu={(e) => { e.preventDefault(); setShowPath(!showPath) }} className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 hover:border-accent/50 disabled:opacity-50" title={T('Abre el Finder para elegir una carpeta o un proyecto de esta computadora (click derecho: escribir la ruta)', 'Opens the Finder to pick a folder or a project on this computer (right click: type the path)')}><FolderOpen size={12} />{T(' proyecto local', ' local project')}</button>
          {uploading && <Loader2 size={13} className="animate-spin text-accent" />}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
          {/* folder picker: webkitdirectory keeps each file's relative path */}
          <input ref={dirRef} type="file" multiple className="hidden" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => addFiles(e.target.files, true)} />
        </div>
        {showPath && (
          <div className="mt-2 flex gap-1.5">
            <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPath()} placeholder={T('~/Documents/mi-proyecto', '~/Documents/my-project')} className="w-full rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent" />
            <button type="button" onClick={addPath} disabled={!pathInput.trim() || uploading} className="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-semibold text-white disabled:opacity-40">{T('Adjuntar', 'Attach')}</button>
          </div>
        )}
        {attachments.length > 0 && (
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto scroll-thin text-[12px]">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-surface-2">
                <FileText size={12} className={a.kind === 'text' ? 'text-accent' : 'text-ink-4'} />
                <span className="min-w-0 flex-1 truncate font-mono" title={a.name}>{a.name}</span>
                <span className="text-ink-4">{a.kind === 'text' ? `${a.chars.toLocaleString()} ${T('car.', 'chars')}` : a.kind === 'skipped' ? T('omitido (tope)', 'skipped (cap)') : fmtSize(a.size)}</span>
                {!busy && <button type="button" onClick={() => st && intakeApi.remove(st.id, a.id).then(setSt)} className="text-ink-4 hover:text-danger" title={T('Quitar', 'Remove')}><Trash2 size={12} /></button>}
              </li>
            ))}
          </ul>
        )}
        {attachments.length > 0 && <div className="mt-1 text-[11px] text-ink-4">{attachments.length} {T('archivo', 'file')}{attachments.length === 1 ? '' : 's'} · {(st?.context_chars ?? 0).toLocaleString()} {T('caracteres de texto que el análisis va a leer', 'characters of text the analysis will read')}</div>}
      </div>

      {/* generate */}
      {!busy && !waiting && !(st?.status === 'done' && st.prompt && promptActive) && (
        <div className="flex flex-wrap items-center gap-2">
          <button data-tour="prompt" type="button" onClick={() => run()} disabled={!idea.trim() || !provider || uploading} style={{ background: theme.accent }} className="flex max-w-full shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-40">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white"><ProviderLogo provider={provider} size={15} /></span>
            {promptActive ? tr('Regenerar prompt engineering', 'Regenerate prompt engineering') : tr('Generar prompt engineering a mi texto', 'Prompt-engineer my text')}
          </button>
          <div className="flex min-w-[min(100%,260px)] flex-1 flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
            <span className="shrink-0">{T('con', 'with')}</span>
            <AiPicker provider={provider} model={model} simulated onChange={(p, m) => { setProvider(p); setModel(m) }} onConnected={onConnected} className="flex-1" />
          </div>
        </div>
      )}

      {/* live analysis */}
      <AnimatePresence>
        {(busy || waiting) && (
          <motion.div ref={liveRef} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="scroll-mt-4 rounded-2xl border p-4" style={{ borderColor: theme.border, background: theme.bg }}>
            <div className="flex items-center gap-3">
              <motion.span animate={busy ? { scale: [1, 1.15, 1], opacity: [1, 0.7, 1] } : { scale: 1, opacity: 1 }} transition={{ repeat: Infinity, duration: 1.3 }} className="flex"><ProviderLogo provider={provider} size={28} /></motion.span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{st?.step || T('Analizando…', 'Analysing…')}{busy && <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1 }}>…</motion.span>}</div>
                <div className="text-[11.5px] text-ink-3">{busy ? T('Estoy leyendo tu texto y el material para entender qué necesitás y hasta dónde llega.', 'I am reading your text and the material to understand what you need and how far it goes.') : tr('Respondé lo que puedas; lo que no sepas, lo decido con el criterio más razonable.', 'Answer what you can; whatever you do not know, I decide with the most reasonable criterion.')}</div>
              </div>
              <button type="button" onClick={cancel} className="text-ink-3 hover:text-danger" title={T('Cancelar', 'Cancel')}><X size={15} /></button>
            </div>

            {/* files being read */}
            {reading.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-[11px] text-ink-3"><span>{T('Material leído', 'Material read')}</span><span>{reading.length} / {attachments.length}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-black/10"><motion.div className="h-full rounded-full" style={{ background: theme.accent }} animate={{ width: `${Math.min(100, (reading.length / Math.max(1, attachments.length)) * 100)}%` }} /></div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {reading.slice(-12).map((r, i) => (
                    <motion.span key={`${r.name}-${i}`} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{r.name.split('/').pop()}</motion.span>
                  ))}
                </div>
              </div>
            )}

            {/* nothing streamed yet: make it obvious the model is working */}
            {busy && !thinking && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 flex items-center gap-3 rounded-lg bg-white/60 px-3 py-2.5">
                <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2.4, ease: 'linear' }} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed" style={{ borderColor: theme.accent }}><ProviderLogo provider={provider} size={16} /></motion.span>
                <div className="text-[12.5px] text-ink-2">{T('procesando', 'processing')}<motion.span animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 1 }}>…</motion.span> <span className="text-ink-4">{T('el modelo está leyendo; en segundos vas a ver lo que piensa', 'the model is reading; in seconds you will see what it thinks')}</span></div>
              </motion.div>
            )}

            {/* streamed reasoning / draft */}
            {busy && thinking && (
              <div className="mt-3">
                <button type="button" onClick={() => setShowThinking(!showThinking)} className="text-[11px] uppercase tracking-widest text-ink-3 hover:text-ink">{showThinking ? T('ocultar', 'hide') : T('ver', 'show')} {T('lo que va pensando', 'what it is thinking')}</button>
                <motion.pre initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`mt-1 overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-white/60 p-2 font-mono text-[11px] leading-relaxed text-ink-2 ${showThinking ? 'max-h-64 overflow-y-auto scroll-thin' : 'max-h-10'}`}>{showThinking ? thinking : thinking.slice(-140)}</motion.pre>
              </div>
            )}

            {/* questions */}
            {waiting && st && (
              <div className="mt-3 space-y-3">
                {st.understanding && <div className="rounded-lg bg-white/70 p-2.5 text-[12.5px] text-ink-2"><span className="font-semibold text-ink">{T('Lo que entendí: ', 'What I understood: ')}</span>{st.understanding}</div>}
                {st.questions.map((q, i) => (
                  <QuestionBox key={q.id} q={q} idx={i} value={answers[q.id] ?? ''} onChange={(v) => setAnswers({ ...answers, [q.id]: v })} />
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => send()} disabled={sending} style={{ background: theme.accent }} className="flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{sending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {T('Enviar respuestas', 'Send answers')}</button>
                  <button type="button" onClick={() => { setAnswers({}); send({}) }} disabled={sending} className="rounded-xl border border-line bg-white/70 px-3 py-1.5 text-[12.5px] text-ink-2 hover:text-ink disabled:opacity-60">{T('Decidilo vos', 'You decide')}</button>
                  <span className="text-[11px] text-ink-4">{T('ronda', 'round')} {st.rounds} {T('de', 'of')} 3</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* the result: takes the place of the user's text */}
      {st?.status === 'done' && st.prompt && promptActive && (
        <>
          <div className="rounded-2xl border p-4" style={{ borderColor: theme.border, background: theme.bg }}>
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles size={15} style={{ color: theme.accent }} />
              <span className="text-sm font-semibold text-ink">{T('Prompt generado: el consejo arranca con este brief', 'Prompt generated: the council starts from this brief')}</span>
              <span className="ml-auto font-mono text-[11px] text-ink-3">{st.cost_usd ? fmtUsd(st.cost_usd) : ''}</span>
              <button type="button" onClick={() => setFull(true)} className="flex items-center gap-1 rounded-lg border border-line bg-white/70 px-2 py-1 text-[12px]" title={T('Leer completo a pantalla completa', 'Read it all at full screen')}><Maximize2 size={12} />{T(' pantalla completa', ' full screen')}</button>
              <button type="button" onClick={() => { setDraft(st.prompt); setEditing(!editing) }} className="flex items-center gap-1 rounded-lg border border-line bg-white/70 px-2 py-1 text-[12px]"><Pencil size={12} /> {editing ? T('ver', 'view') : T('editar', 'edit')}</button>
              <button type="button" onClick={onDiscardPrompt} className="flex items-center gap-1 rounded-lg border border-line bg-white/70 px-2 py-1 text-[12px] text-ink-3 hover:text-danger" title={T('Volver a mi texto original', 'Back to my original text')}><X size={12} />{T(' volver a mi texto', ' back to my text')}</button>
            </div>
            {editing ? (
              <div className="mt-2">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="h-72 w-full resize-y rounded-lg border border-line bg-surface p-2 font-mono text-[12px] outline-none focus:border-accent" />
                <button type="button" onClick={() => { setSt({ ...st, prompt: draft }); onPrompt(draft, st.context ?? null); setEditing(false) }} className="mt-1.5 rounded-lg bg-accent px-3 py-1 text-[12px] font-semibold text-white">{T('Guardar cambios', 'Save changes')}</button>
              </div>
            ) : (
              <article onClick={() => setFull(true)} className="md mt-2 max-h-72 cursor-zoom-in overflow-y-auto scroll-thin rounded-lg bg-white/80 p-3 text-[13px]" dangerouslySetInnerHTML={{ __html: promptHtml }} />
            )}
          </div>

          {/* offer: a prompt per role, tailored to this project (asked first, explained, never silent) */}
          {team && team.length > 0 && onRolePrompts && roleOffer !== 'skipped' && (
            <div className="rounded-xl border p-3" style={{ borderColor: theme.border, background: theme.bg }}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white"><ProviderLogo provider={provider} size={15} /></span>
                <div className="min-w-0 flex-1 text-[12.5px] text-ink-2">
                  <div className="text-sm font-semibold text-ink">{roleOffer === 'done' ? T('Prompts por rol generados', 'Role prompts generated') : T('¿Querés que también escriba el prompt de cada rol a medida de este proyecto?', 'Want me to also write each role\'s prompt tailored to this project?')}</div>
                  {roleOffer === 'done' ? (
                    <div className="mt-0.5">{T('Cada rol ya tiene su personalidad adaptada a este brief. Revisalas en las tarjetas de la derecha; podés editarlas o volver a generarlas.', 'Each role now has its personality adapted to this brief. Review them on the cards on the right; you can edit or regenerate them.')}</div>
                  ) : (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      <li>{T('Lee el brief y, por cada rol del equipo, escribe qué debe priorizar, qué riesgos vigilar y en qué ser exigente, citando este proyecto.', 'It reads the brief and, for each role in the team, writes what to prioritise, which risks to watch and where to be strict, citing this project.')}</li>
                      <li>{T('Reemplaza el prompt actual de cada rol (el genérico). Después podés editarlos uno por uno en las tarjetas.', 'It replaces each role\'s current (generic) prompt. You can then edit them one by one on the cards.')}</li>
                      <li>{T('Es una sola llamada al modelo elegido arriba; cuesta centavos.', 'It is a single call to the model chosen above; it costs cents.')}</li>
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {roleOffer === 'done' ? (
                      <button type="button" onClick={makeRolePrompts} className="flex items-center gap-1 rounded-lg border border-line bg-white/70 px-2.5 py-1 text-[12px] text-ink-2 hover:text-ink"><RotateCcw size={12} /> {T('Volver a generar', 'Generate again')}</button>
                    ) : (
                      <>
                        <button type="button" onClick={makeRolePrompts} disabled={roleOffer === 'working'} style={{ background: theme.accent }} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-60">{roleOffer === 'working' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} {roleOffer === 'working' ? T('Escribiendo los prompts…', 'Writing the prompts…') : T('Sí, generar los prompts por rol', 'Yes, generate the role prompts')}</button>
                        <button type="button" onClick={() => setRoleOffer('skipped')} disabled={roleOffer === 'working'} className="rounded-lg border border-line bg-white/70 px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink">{T('No, dejar los actuales', 'No, keep the current ones')}</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* add something more → the model rewrites the prompt */}
          {!busy && !waiting && (
            <div className="rounded-xl border border-line bg-surface/60 p-3">
              <span className="text-xs uppercase tracking-widest text-ink-3">{T('¿Querés que el modelo agregue o cambie algo?', 'Want the model to add or change something?')}</span>
              <textarea value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={T('ej.: sumá notificaciones push, que funcione sin conexión, que el admin pueda exportar a Excel…', 'e.g.: add push notifications, make it work offline, let the admin export to Excel…')} className="mt-1 h-20 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => run(extra)} disabled={!extra.trim()} style={{ background: theme.accent }} className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-40">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white"><ProviderLogo provider={provider} size={15} /></span>
                  {T('Regenerar prompt engineering', 'Regenerate prompt engineering')}
                </button>
                <button type="button" onClick={() => run()} className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink" title={T('Volver a analizar desde cero con el texto y adjuntos actuales', 'Analyse again from scratch with the current text and attachments')}><RotateCcw size={12} />{T(' desde cero', ' from scratch')}</button>
                <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  {T('con', 'with')}
                  <AiPicker provider={provider} model={model} simulated onChange={(p, m) => { setProvider(p); setModel(m) }} onConnected={onConnected} />
                </div>
              </div>
            </div>
          )}

          {full && createPortal(
            <div className="fixed inset-0 z-[150] flex flex-col bg-paper" onKeyDown={(e) => e.key === 'Escape' && setFull(false)}>
              <div className="flex items-center gap-3 border-b border-line px-6 py-3">
                <ProviderLogo provider={provider} size={20} />
                <span className="font-semibold text-ink">{T('Prompt para el consejo', 'Prompt for the council')}</span>
                <span className="text-[12px] text-ink-3">{st.prompt.length.toLocaleString()} {T('caracteres', 'characters')}</span>
                <button type="button" onClick={() => setFull(false)} className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm hover:bg-surface-2"><X size={14} />{T(' cerrar', ' close')}</button>
              </div>
              <article className="md mx-auto w-full max-w-4xl flex-1 overflow-y-auto scroll-thin px-4 py-5 sm:px-8 sm:py-8 text-[15px] leading-relaxed" dangerouslySetInnerHTML={{ __html: promptHtml }} />
            </div>,
            document.body,
          )}
        </>
      )}
      {st?.status === 'error' && st.error && (
        <div className="rounded-xl border border-danger/40 bg-danger/5 p-3 text-[12.5px] text-danger">
          {st.error} <button type="button" onClick={() => run()} className="ml-2 underline">{T('reintentar', 'retry')}</button>
        </div>
      )}
      <ModelsHint providers={providers} />
    </div>
  )
}

function QuestionBox({ q, idx, value, onChange }: { q: IntakeQuestion; idx: number; value: string; onChange: (v: string) => void }) {
  const T = useT()
  return (
    <motion.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: idx * 0.08 }} className="rounded-xl border border-line bg-white/80 p-3">
      <div className="text-[13.5px] font-bold text-ink">{idx + 1}. {q.question}</div>
      {q.why && <div className="mt-0.5 text-[11.5px] font-medium text-ink-3">{q.why}</div>}
      {q.options.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {q.options.map((o) => {
            const on = value === o
            return (
              <label key={o} className={`flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] font-semibold leading-snug transition ${on ? 'border-accent bg-accent-soft text-ink' : 'border-line bg-surface text-ink-2 hover:border-accent/50'}`}>
                <input type="radio" name={q.id} checked={on} onChange={() => onChange(o)} className="sr-only" />
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md border ${on ? 'border-accent bg-accent text-white' : 'border-ink-4 bg-white'}`}>{on && <Check size={11} strokeWidth={3} />}</span>
                <span className="min-w-0 flex-1">{o}</span>
              </label>
            )
          })}
        </div>
      )}
      <input value={q.options.includes(value) ? '' : value} onChange={(e) => onChange(e.target.value)} placeholder={T('o escribí tu respuesta…', 'or type your answer…')} className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium outline-none focus:border-accent" />
    </motion.div>
  )
}

function ModelsHint({ providers }: { providers: Provider[] }) {
  const T = useT()
  const n = providers.filter((p) => p.configured && p.id !== 'mock').length
  if (n) return null
  return <div className="text-[11px] text-ink-4">{T('Elegí en la lista la IA que prefieras. Con «Simulado» el prompt es un ejemplo de prueba.', 'Pick the AI you prefer from the list. With “Simulated” the prompt is a sample.')}</div>
}


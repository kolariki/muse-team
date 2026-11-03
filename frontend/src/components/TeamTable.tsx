import { Camera, Loader2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type Employee } from '../lib/api'
import { getLang, tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import AgentAvatar from './AgentAvatar'
import { focusEmployee, loadEmployees, useEmployees } from './MyTeam'
import { loadMyPhoto, removeMyPhoto, saveMyPhoto, useMyPhoto } from '../lib/myPhoto'
import { toast } from './Toast'
import { openTeam } from './TeamMemory'

// the seat each kind of role takes at the table (product first, QA last), and the colour of its place
const ORDER = ['ceo', 'product-manager', 'product-designer', 'head-engineering', 'cto', 'frontend', 'backend', 'fullstack', 'mobile', 'growth', 'qa', 'security']
const SEATS = ['seat-mint', 'seat-violet', 'bg-surface-2', 'seat-honey', 'bg-surface-2']  // index.css: a light and a dark version of each
const BUILDS = /engineer|frontend|backend|fullstack|mobile|cto/

const label = (e: Employee) => (getLang() === 'en' ? e.role_label_en : e.role_label) || e.name

/** «La mesa del equipo» on the home: the user's AI team as people at a table, what each one did or is doing now, and the user
 *  as the one who decides. The team is «Mi equipo» (same portraits, same roles); a seat opens it. */
export default function TeamTable() {
  const T = useT()
  const list = useEmployees((s) => s.list)
  const [live, setLive] = useState<{ title: string; buildId: string; sessionId: string } | null>(null)
  useEffect(() => {
    if (!list) loadEmployees()
    api.dashboard().then((d) => {
      for (const s of d.sessions) {
        const b = s.builds.find((x) => x.status === 'running' || x.status === 'reviewing')
        if (b) { setLive({ title: s.title || s.topic || tr('tu proyecto', 'your project'), buildId: b.id, sessionId: s.id }); return }
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // a new account has no employees yet: the roles a first project brings, so the table is never empty
  const starter = ([['product-manager', 'Producto', 'Product'], ['product-designer', 'Diseño', 'Design'], ['head-engineering', 'Ingeniería', 'Engineering'], ['growth', 'Crecimiento', 'Growth'], ['qa', 'QA', 'QA']] as const)
    .map(([role, es, en]) => ({ id: role, key: role, role, name: es, role_label: es, role_label_en: en, projects: 0, lessons: 0, last_used: 0 }) as unknown as Employee)
  const team = [...(list?.length ? list : starter)]
    .sort((a, b) => (ORDER.indexOf(a.role ?? '') + 1 || 99) - (ORDER.indexOf(b.role ?? '') + 1 || 99) || b.last_used - a.last_used)
    .slice(0, 5)
  const builder = team.find((e) => BUILDS.test(e.role ?? '')) ?? null
  const open = (e?: Employee) => { focusEmployee(e && list?.some((x) => x.id === e.id) ? e.id : null); openTeam('team') }
  const photo = useMyPhoto((s) => s.url)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  useEffect(() => { loadMyPhoto() }, [])
  const pick = async (f: File | undefined) => {
    if (!f) return
    setUploading(true)
    try { await saveMyPhoto(f) } catch (err) { toast.error(T('No se pudo subir la foto', 'Could not upload the photo'), (err as Error).message) } finally { setUploading(false) }
  }
  const goLive = () => live && useArena.getState().set({ pendingBuild: { buildId: live.buildId, sessionId: live.sessionId } })

  const line = (e: Employee) => {
    if (live && e === builder) return T(`Construyendo «${live.title}» ahora`, `Building «${live.title}» right now`)
    if (e.projects) return e.lessons
      ? T(`Trabajó en ${e.projects} ${e.projects === 1 ? 'proyecto' : 'proyectos'} y aprendió ${e.lessons} ${e.lessons === 1 ? 'cosa' : 'cosas'} de cómo trabajás`, `Worked on ${e.projects} ${e.projects === 1 ? 'project' : 'projects'} and learned ${e.lessons} ${e.lessons === 1 ? 'thing' : 'things'} about how you work`)
      : T(`Trabajó en ${e.projects} ${e.projects === 1 ? 'proyecto' : 'proyectos'} con vos`, `Worked on ${e.projects} ${e.projects === 1 ? 'project' : 'projects'} with you`)
    return T('Se suma en tu primer proyecto', 'Joins on your first project')
  }

  return (
    <section aria-labelledby="team-table" className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="team-table" className="text-[28px] leading-none sm:text-[34px]">{T('Tu equipo', 'Your team')}</h2>
          <p className="mt-2 max-w-[640px] text-[15px] text-ink-2">{T('Discuten tu idea, la diseñan, la programan y se revisan entre ellos. Vos les hablás como a un equipo y decidís.', 'They debate your idea, design it, code it and review each other. You talk to them like a team and you decide.')}</p>
        </div>
        <span className="lane-ring lane-ring-pill inline-flex shrink-0"><button onClick={() => open()} className="h-10 rounded-full border border-line bg-surface px-4 text-[13.5px] font-semibold text-ink transition hover:border-accent hover:text-accent">{T('Ver y editar mi equipo', 'See and edit my team')}</button></span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2.5 sm:gap-3 sm:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
        {team.map((e, i) => {
          const isLive = !!live && e === builder
          return (
            <button key={e.id} onClick={isLive ? goLive : () => open(e)} title={isLive ? undefined : T('Abrir en Mi equipo para editarlo', 'Open in My team to edit')} className={`flex flex-col items-start gap-2.5 rounded-[22px] p-3 text-left sm:gap-3 sm:p-4 transition hover:-translate-y-0.5 ${isLive ? 'seat-live text-white' : `${SEATS[i % SEATS.length]} text-ink`}`}>
              <span className="relative">
                <AgentAvatar agent={{ name: e.name, role: e.role, provider: e.provider }} size={64} ring={false} logo={0} />
                {isLive && <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 animate-pulse rounded-full border-2 border-surface bg-[#8FD3A8]" aria-hidden />}
              </span>
              <span>
                <span className="block text-[17px] font-extrabold leading-tight">{label(e)}</span>
                <span className={`block text-[13px] ${isLive ? 'text-[#B9CCC5]' : 'text-ink-3'}`}>{isLive ? T('trabajando ahora', 'working now') : e.name !== label(e) && !label(e).toLowerCase().includes(e.name.toLowerCase()) ? e.name : T('en tu equipo', 'on your team')}</span>
              </span>
              <span className={`text-[14px] leading-snug ${isLive ? 'text-white' : 'text-ink-2'}`}>{line(e)}</span>
            </button>
          )
        })}
        <div className="flex flex-col items-start gap-2.5 rounded-[22px] border-2 border-dashed border-line p-3 sm:gap-3 sm:p-4">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(ev) => { pick(ev.target.files?.[0]); ev.target.value = '' }} />
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} aria-label={photo ? T('Cambiar mi foto', 'Change my photo') : T('Poner mi foto', 'Add my photo')} title={photo ? T('Cambiar mi foto', 'Change my photo') : T('Poner mi foto', 'Add my photo')}
              className={`group relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full ${photo ? '' : 'border-2 border-dashed border-ink-4 text-ink-3 hover:border-accent hover:text-accent'}`}>
              {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : uploading ? <Loader2 size={20} className="animate-spin" /> : <Camera size={20} />}
              {photo && <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition group-hover:opacity-100">{uploading ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}</span>}
            </button>
            {photo && <button type="button" onClick={() => removeMyPhoto().catch(() => {})} className="flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition hover:bg-danger/10 hover:text-danger" aria-label={T('Quitar mi foto', 'Remove my photo')} title={T('Quitar mi foto', 'Remove my photo')}><Trash2 size={14} /></button>}
          </span>
          <span>
            <span className="block text-[17px] font-extrabold leading-tight text-ink">{T('Vos', 'You')}</span>
            <span className="block text-[13px] text-ink-3">{photo ? T('quien decide', 'the one who decides') : T('tocá el círculo para poner tu foto', 'tap the circle to add your photo')}</span>
          </span>
          <span className="text-[14px] leading-snug text-ink-2">{T('Aprobás el diseño, pedís cambios y das el OK para publicar.', 'You approve the design, ask for changes and give the OK to publish.')}</span>
        </div>
      </div>
    </section>
  )
}

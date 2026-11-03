import PageHeader from './PageHeader'
import HomeLoader from './HomeLoader'
import { AnimatePresence } from 'framer-motion'
import { FileArchive, FolderOpen, Gavel, Loader2, Plus, Puzzle, Trash2, UploadCloud } from 'lucide-react'
import { zipFromDrop, zipFromFileList, type ZipStats } from '../lib/projectZip'
import { useEffect, useRef, useState } from 'react'
import { api, type EngineStatus } from '../lib/api'
import { PALETTE, brandTheme } from '../lib/brand'
import type { AgentConfig, Provider, Role } from '../types'
import { useAiConnect } from './AiConnect'
import ModelSelect from './ModelSelect'
import ProviderLogo, { BrandLogoRow, BrandStripes, LogoWatermark } from './ProviderLogo'
import PersonaField from './PersonaField'
import SkillPicker from './SkillPicker'
import { toast } from './Toast'
import { pick as pickLang, tr, useLang, useT } from '../lib/i18n'

const DEFAULT_TEAM: { role: string; name: string }[] = [
  { role: 'cto', name: 'CTO' },
  { role: 'head-engineering', name: 'Head of Eng' },
  { role: 'security', name: 'Security' },
  { role: 'qa', name: 'QA' },
  { role: 'product-manager', name: 'Product' },
  { role: 'product-designer', name: 'Diseño' },
]

interface Props {
  onBack: () => void
  onStart: (form: FormData) => Promise<void>
}

/** Upload an existing project and let the team audit it. */
export default function AuditSetup({ onBack, onStart }: Props) {
  const T = useT()
  const lang = useLang()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [autoSkills, setAutoSkills] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const ai = useAiConnect(providers, (np) => setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x))))
  const [roles, setRoles] = useState<{ groups: string[]; groups_en?: string[]; roles: Role[] }>({ groups: [], roles: [] })
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [team, setTeam] = useState<AgentConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const [stats, setStats] = useState<ZipStats | null>(null)
  const [packing, setPacking] = useState<string | null>(null)

  const rolesRef = useRef(roles)
  rolesRef.current = roles
  const personaOf = (roleId: string) => { const role = rolesRef.current.roles.find((x) => x.id === roleId); return role ? pickLang(role, 'persona') : '' }
  const [loaded, setLoaded] = useState({ roles: false, engines: false, providers: false, timeout: false })
  const mark = (k: keyof typeof loaded) => setLoaded((l) => (l[k] ? l : { ...l, [k]: true }))
  const booting = !loaded.timeout && !(loaded.roles && loaded.engines && loaded.providers)
  useEffect(() => {
    const t = setTimeout(() => mark('timeout'), 8000)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    api.roles().then((r) => {
      setRoles(r)
      // every auditor starts with its role's default prompt (the user can rewrite it)
      setTeam((t) => t.map((a) => { const role = r.roles.find((x) => x.id === a.role); return a.persona?.trim() || !role ? a : { ...a, persona: pickLang(role, 'persona') } }))
    }).catch(() => {}).finally(() => mark('roles'))
    api.engines().then(setEngines).catch(() => {}).finally(() => mark('engines'))
    api.providers().then((ps) => {
      setProviders(ps)
      const p = ps.find((x) => x.configured && x.id !== 'mock') ?? ps.find((x) => x.id === 'mock')
      if (p) {
        setProvider(p.id)
        setModel(p.default_model)
        setTeam(DEFAULT_TEAM.map((t, i) => ({ id: t.role, name: t.name, role: t.role, provider: p.id, model: p.default_model, persona: personaOf(t.role), color: p.id === 'mock' ? PALETTE[i % PALETTE.length] : null })))
      }
    }).catch((e) => setError(e.message)).finally(() => mark('providers'))
  }, [])

  useEffect(() => {
    const ok = engines.find((e) => e.ok)
    if (ok && !engines.find((e) => e.id === provider) && !providers.find((p) => p.configured && p.id !== 'mock')) {
      setProvider(ok.id)
      setModel('default')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines, providers])

  const isEngine = !!engines.find((e) => e.id === provider)
  const pick = (f: File | null) => {
    if (!f) return
    if (!/\.zip$/i.test(f.name)) return setError(tr('Subí un archivo .zip del proyecto o elegí la carpeta', 'Upload a .zip of the project or pick the folder'))
    setError(null)
    setStats(null)
    setFile(f)
    if (!name) setName(f.name.replace(/\.zip$/i, ''))
  }
  /** The browser walks the folder, drops node_modules/.git/builds/binaries and zips only the code, so the upload is a few MB. */
  const pack = async (run: (onProgress: (scanned: number, kept: number) => void) => Promise<{ file: File; stats: ZipStats }>) => {
    setError(null)
    setPacking(tr('Leyendo la carpeta…', 'Reading the folder…'))
    try {
      const r = await run((scanned, kept) => setPacking(tr(`Leyendo la carpeta… ${scanned} archivos, ${kept} útiles`, `Reading the folder… ${scanned} files, ${kept} kept`)))
      setFile(r.file)
      setStats(r.stats)
      if (!name) setName(r.stats.root)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPacking(null)
    }
  }
  const pickFolder = (list: FileList | null) => {
    if (!list?.length) return
    void pack((p) => zipFromFileList(list, p))
  }
  const drop = async (dt: DataTransfer) => {
    const hasDir = Array.from(dt.items ?? []).some((it) => it.webkitGetAsEntry?.()?.isDirectory)
    if (hasDir) return pack(async (p) => {
      const r = await zipFromDrop(dt, p)
      if (!r || !('file' in r)) throw new Error(tr('No pude leer la carpeta', 'Could not read the folder'))
      return r
    })
    pick(dt.files[0] ?? null)
  }
  const updateAgent = (i: number, patch: Partial<AgentConfig>) => setTeam((t) => t.map((a, j) => (j === i ? { ...a, ...patch } : a)))

  const start = async () => {
    if (!file) return setError(tr('Falta la carpeta o el .zip del proyecto', 'The project folder or .zip is missing'))
    if (!team.length) return setError(tr('Elegí al menos un rol', 'Pick at least one role'))
    setBusy(true)
    setError(null)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('name', name || file.name.replace(/\.zip$/i, ''))
    fd.append('description', description)
    fd.append('team', JSON.stringify(team))
    fd.append('provider', provider)
    fd.append('model', model)
    fd.append('auto_skills', String(autoSkills))
    fd.append('language', lang === 'en' ? 'English' : 'español rioplatense')
    try {
      await onStart(fd)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const input = 'w-full rounded-lg bg-surface border border-line px-3 py-2 text-sm outline-none focus:border-accent transition shadow-sm'

  return (
    <div className="h-full overflow-y-auto scroll-thin arena-bg">
      <AnimatePresence>{booting && <HomeLoader key="loader" caption={T('Armando el equipo auditor…', 'Assembling the audit team…')} />}</AnimatePresence>
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader onBack={onBack} kicker={T('Auditoría de proyecto', 'Project audit')} title={T('Que el equipo evalúe tu proyecto', 'Let the team evaluate your project')} subtitle={T('Subí tu código y cada rol lo revisa desde su área: qué está bien, qué hay que mejorar y propuestas concretas con prioridad. Después podés aplicar las mejoras con el constructor y que el consejo las apruebe.', 'Upload your code and each role reviews it from its own area: what is right, what needs improving and concrete, prioritised proposals. Then you can apply the improvements with the builder and have the council approve them.')} />

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="panel relative flex flex-col rounded-2xl p-5" style={{ clipPath: 'inset(0 round 1rem)' }}>
            {/* the auditing companies as soft brand bands behind the upload panel, logos + share following the scroll */}
            <BrandStripes providers={team.map((a) => a.provider)} logos={false} />
            <div className="absolute inset-0 bg-surface/35" aria-hidden />
            <div className="relative space-y-4">
            <div
              data-tour="audit"
              onDragOver={(e) => {
                e.preventDefault()
                setDrag(true)
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDrag(false)
                void drop(e.dataTransfer)
              }}
              onClick={() => dirRef.current?.click()}
              className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition ${drag ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/50'}`}
            >
              <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
              {/* webkitdirectory is not in React's typings: set through the ref */}
              <input ref={(el) => { dirRef.current = el; if (el) el.setAttribute('webkitdirectory', ''); }} type="file" multiple className="hidden" onChange={(e) => { pickFolder(e.target.files); e.target.value = '' }} />
              {packing ? (
                <div className="flex items-center justify-center gap-3 text-ink-2"><Loader2 className="animate-spin text-accent" size={18} /> <span className="font-medium">{packing}</span></div>
              ) : file ? (
                <div>
                  <div className="flex items-center justify-center gap-3"><FileArchive className="text-accent" /> <span className="font-medium">{file.name}</span> <span className="text-xs text-ink-3">{(file.size / 1024 / 1024).toFixed(1)} MB</span></div>
                  {stats && (
                    <div className="mt-1.5 text-xs text-ink-3">
                      {T(`${stats.files} archivos de código (${(stats.bytes / 1024 / 1024).toFixed(1)} MB) · ${stats.skipped} descartados: node_modules, .git, builds, binarios y archivos > 400 KB`, `${stats.files} code files (${(stats.bytes / 1024 / 1024).toFixed(1)} MB) · ${stats.skipped} dropped: node_modules, .git, builds, binaries and files > 400 KB`)}
                      {stats.truncated && <span className="text-danger"> · {T('se cortó en 2500 archivos / 25 MB', 'capped at 2500 files / 25 MB')}</span>}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] text-ink-3">{T('Hacé clic o arrastrá otra carpeta para cambiarla', 'Click or drop another folder to change it')}</div>
                </div>
              ) : (
                <>
                  <UploadCloud className="mx-auto text-ink-3" size={30} />
                  <div className="mt-2 font-medium">{T('Arrastrá la carpeta del proyecto o hacé clic para elegirla', 'Drop the project folder here or click to pick it')}</div>
                  <div className="mt-1 text-xs text-ink-3">{T('Tably descarta node_modules, .git, builds y binarios acá mismo y sube solo el código: no hace falta preparar nada.', 'Tably drops node_modules, .git, builds and binaries right here and uploads only the code: nothing to prepare.')}</div>
                  <button type="button" onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }} className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 transition hover:border-accent hover:text-accent"><FolderOpen size={12} /> {T('…o subir un .zip', '…or upload a .zip')}</button>
                </>
              )}
            </div>
            <label className="block">
              <span className="text-xs uppercase tracking-widest text-ink-3">{T('Nombre del proyecto', 'Project name')}</span>
              <input className={`${input} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder={T('mi-app', 'my-app')} />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-widest text-ink-3">{T('Qué es y qué te preocupa', 'What it is and what worries you')}</span>
              <textarea className={`${input} mt-1 h-28 resize-none`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={T('Ej.: app de turnos para peluquerías, Next.js + Supabase. Me preocupa la seguridad y que escale a 10k usuarios. Quiero saber si está lista para producción.', 'E.g.: booking app for hair salons, Next.js + Supabase. I worry about security and scaling to 10k users. I want to know if it is production-ready.')} />
            </label>
            {/* engine card wears the chosen company: logo, colours and watermark, like the role cards */}
            <div className="relative overflow-hidden rounded-xl border p-3" style={{ background: brandTheme(provider).bg, borderColor: brandTheme(provider).border }}>
              <LogoWatermark provider={provider} opacity={0.12} />
              <div className="relative">
              <span className="flex items-center gap-2 text-xs uppercase tracking-widest text-ink-3"><ProviderLogo provider={provider} size={22} /> {T('Motor para el informe y las mejoras', 'Engine for the report and the improvements')}</span>
              <select
                className={`${input} mt-2`}
                value={provider}
                onChange={(e) => {
                  const id = e.target.value
                  if (ai.ask(id, (np) => { setProvider(np.id); setModel(np.default_model) })) return
                  if (engines.find((x) => x.id === id)) {
                    setProvider(id)
                    setModel('default')
                    return
                  }
                  const p = providers.find((x) => x.id === id)!
                  setProvider(p.id)
                  setModel(p.default_model)
                }}
              >
                {engines.length > 0 && (
                  <optgroup label={T('Sin API · agentes locales', 'No API · local agents')}>
                    {engines.map((e) => <option key={e.id} value={e.id} disabled={!e.ok}>{e.label}{e.ok ? '' : ` (${e.installed ? T('sin login', 'not logged in') : T('no instalado', 'not installed')})`}</option>)}
                  </optgroup>
                )}
                <optgroup label={T('Por API', 'Via API')}>
                  {providers.filter((p) => p.configured).map((p) => <option key={p.id} value={p.id}>{p.id === 'mock' ? T('Simulado (sin API)', 'Simulated (no API)') : p.label}</option>)}
                </optgroup>
                {ai.options}
              </select>
              {ai.dialog}
              {isEngine ? (
                <p className="mt-1.5 text-[12px] text-ink-3">{T('Con un agente local,', 'With a local agent,')} <b>{T('todos', 'all')}</b> {T('los roles auditan leyendo tu carpeta directamente, sin API.', 'roles audit by reading your folder directly, without the API.')}</p>
              ) : (
                <div className="mt-2"><ModelSelect provider={provider} value={model} onChange={setModel} /></div>
              )}
              </div>
            </div>
            </div>
            <div className="relative mt-2 flex-1 min-h-[150px]">
              <div className="sticky top-24"><BrandLogoRow providers={team.map((a) => a.provider)} align="start" /></div>
            </div>
          </div>

          <div data-tour="audit-team" className="panel rounded-2xl p-5">
            <div className="flex items-center">
              <span className="text-xs uppercase tracking-widest text-ink-3">{T('Equipo auditor', 'Audit team')} <span className="ml-1 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] text-ink-2">{team.length}/8</span></span>
              <button
                type="button"
                disabled={suggesting || !(name.trim() || description.trim())}
                onClick={async () => {
                  // catalog skills per auditor, from the project description and each role
                  setSuggesting(true)
                  try {
                    const r = await api.suggestSkills(`${name}\n${description}`, team.map((a) => { const role = roles.roles.find((x) => x.id === a.role); return { id: a.id, label: role?.label ?? a.name, group: role?.group, mandate: role?.mandate } }), 2)
                    let added = 0
                    const next = team.map((a) => { const sug = (r.per_role[a.id] ?? []).filter((x) => (x.score ?? 0) >= 15 && !(a.skills ?? []).includes(x.id)).map((x) => x.id); added += sug.length; return sug.length ? { ...a, skills: [...(a.skills ?? []), ...sug] } : a })
                    setTeam(next)
                    toast.ok(added ? tr(`${added} skill${added === 1 ? '' : 's'} del catálogo sugerida${added === 1 ? '' : 's'}`, `${added} catalog skill${added === 1 ? '' : 's'} suggested`) : tr('Sin sugerencias claras', 'No clear suggestions'), added ? tr('Quedaron cargadas en cada rol; sacá las que no quieras.', 'They are loaded on each role; remove the ones you do not want.') : tr('Contá más en «Qué es y qué te preocupa» o buscá en el catálogo de cada rol.', 'Say more in “What it is and what worries you” or search each role\'s catalog.'))
                  } catch (e) {
                    toast.error(tr('No se pudieron sugerir skills', 'Could not suggest skills'), (e as Error).message)
                  } finally {
                    setSuggesting(false)
                  }
                }}
                className="ml-auto flex h-8 items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-3 text-xs font-medium text-accent shadow-sm transition hover:border-accent hover:bg-accent/5 disabled:opacity-30"
                title={T('Elegir del catálogo las skills que mejor encajan con el proyecto, rol por rol', 'Pick from the catalog the skills that best fit the project, role by role')}
              >{suggesting ? <Loader2 size={13} className="animate-spin" /> : <Puzzle size={13} />} {T('Sugerir skills', 'Suggest skills')}</button>
              <button
                disabled={team.length >= 8}
                onClick={() => setTeam((t) => [...t, { id: `rol-${t.length + 1}`, name: `Auditor ${t.length + 1}`, role: 'devils-advocate', provider: isEngine ? 'mock' : provider, model: isEngine ? 'mock-1' : model, persona: personaOf('devils-advocate'), color: PALETTE[t.length % PALETTE.length] }])}
                className="ml-2 flex h-8 items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-3 text-xs font-medium text-accent shadow-sm transition hover:border-accent hover:bg-accent/5 disabled:opacity-30"
              >
                <Plus size={14} /> {T('Agregar rol', 'Add role')}
              </button>
            </div>
            <label className="mt-2 flex h-7 items-center gap-2 text-sm leading-none whitespace-nowrap">
              <input type="checkbox" checked={autoSkills} onChange={(e) => setAutoSkills(e.target.checked)} className="accent-accent h-4 w-4 shrink-0" />
              <span>{T('El equipo elige skills', 'The team picks skills')}</span>
              <span tabIndex={0} title={T('Al arrancar la auditoría, cada rol recibe las skills del catálogo que mejor encajan con el proyecto. Se suman a las que elegiste; nunca las reemplazan.', 'When the audit starts, each role gets the catalog skills that best fit the project. They are added to the ones you chose; never replaced.')} className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-ink-4 text-[9px] font-bold text-ink-3">?</span>
            </label>
            <div className="mt-3 space-y-2">
              {team.map((a, i) => {
                const r = roles.roles.find((x) => x.id === a.role)
                return (
                  <div key={i} className="relative overflow-hidden rounded-xl border p-3 shadow-[0_10px_24px_-16px_rgba(30,38,34,.45)] transition hover:shadow-[0_14px_30px_-16px_rgba(30,38,34,.5)]" style={{ background: brandTheme(a.provider).bg, borderColor: brandTheme(a.provider).border }}>
                    <LogoWatermark provider={a.provider} opacity={0.1} />
                    <div className="relative">
                    <div className={`grid gap-2 items-center ${isEngine ? 'grid-cols-[auto_1fr_1.4fr_auto]' : 'grid-cols-[auto_1fr_1.4fr_1fr_1.3fr_auto]'}`}>
                      <ProviderLogo provider={a.provider} size={24} />
                      <input className={input} value={a.name} onChange={(e) => updateAgent(i, { name: e.target.value, id: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `rol-${i}` })} />
                      <select
                        className={input}
                        value={a.role ?? ''}
                        onChange={(e) => {
                          const nr = roles.roles.find((x) => x.id === e.target.value)
                          const untouched = !a.persona?.trim() || (r ? a.persona === pickLang(r, 'persona') || a.persona === r.persona || a.persona === r.persona_en : false)
                          updateAgent(i, { role: e.target.value, name: nr && (a.name === r?.label || /^Auditor/.test(a.name)) ? nr.label : a.name, id: nr ? nr.id : a.id, persona: nr && untouched ? pickLang(nr, 'persona') : a.persona })
                        }}
                      >
                        {roles.groups.map((g, gi) => (
                          <optgroup key={g} label={lang === 'en' ? roles.groups_en?.[gi] ?? g : g}>{roles.roles.filter((x) => x.group === g && x.id !== 'custom').map((x) => <option key={x.id} value={x.id}>{pickLang(x, 'label')}</option>)}</optgroup>
                        ))}
                      </select>
                      {!isEngine && (
                        <>
                          <select className={input} value={a.provider} onChange={(e) => { if (ai.ask(e.target.value, (np) => updateAgent(i, { provider: np.id, model: np.default_model }))) return; const np = providers.find((x) => x.id === e.target.value)!; updateAgent(i, { provider: np.id, model: np.default_model }) }}>
                            {providers.filter((p) => p.configured).map((p) => <option key={p.id} value={p.id}>{p.id === 'mock' ? T('Simulado (sin API)', 'Simulated (no API)') : p.label}</option>)}
                            {ai.options}
                          </select>
                          <ModelSelect provider={a.provider} value={a.model} onChange={(m) => updateAgent(i, { model: m })} className="text-xs" />
                        </>
                      )}
                      <button onClick={() => setTeam((t) => t.filter((_, j) => j !== i))} disabled={team.length <= 1} className="text-ink-3 hover:text-danger disabled:opacity-20"><Trash2 size={15} /></button>
                    </div>
                    {r?.mandate && <div className="mt-1.5 text-[11px] text-ink-3">{T('Evalúa:', 'Evaluates:')} {pickLang(r, 'mandate')}</div>}
                    <PersonaField className="mt-2" value={a.persona ?? ''} onChange={(v) => updateAgent(i, { persona: v })} placeholder={T('personalidad / prompt del rol: cómo audita, qué prioriza, en qué es exigente…', 'personality / role prompt: how it audits, what it prioritises, where it is strict…')} roleLabel={a.name} />
                    <div className="mt-2"><SkillPicker value={a.skills ?? []} onChange={(ids) => updateAgent(i, { skills: ids })} /></div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {error && <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
        <div className="mt-6 flex items-center justify-end gap-3">
          {!isEngine && <span className="text-[12px] text-ink-3 flex items-center gap-1.5"><ProviderLogo provider={provider} size={14} /> {T('informe y mejoras con', 'report and improvements with')} {model}</span>}
          <button onClick={start} disabled={busy || !file} className="flex items-center gap-2 rounded-2xl bg-accent text-white px-7 py-3.5 font-bold text-lg hover:brightness-110 disabled:opacity-50">
            <Gavel size={20} /> {busy ? T('Subiendo…', 'Uploading…') : T('Auditar proyecto', 'Audit project')}
          </button>
        </div>
      </div>
    </div>
  )
}

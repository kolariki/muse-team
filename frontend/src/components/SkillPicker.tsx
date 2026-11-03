import { Check, ChevronDown, ExternalLink, Loader2, Plus, Puzzle, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type CatalogCategory, type CatalogSkill, type SkillSummary } from '../lib/api'
import { pick } from '../lib/i18n'
import { toast } from './Toast'
import { tr, useT } from '../lib/i18n'

let cache: { skills: SkillSummary[]; templates: SkillSummary[] } | null = null
export const catalogSeen = new Map<string, CatalogSkill>() // catalog skills the UI has listed, by id (for chip names)
const listeners = new Set<() => void>()
export async function loadSkills(force = false) {
  if (!cache || force) {
    cache = await api.skills()
    listeners.forEach((l) => l())
  }
  return cache
}
export function invalidateSkills() {
  cache = null
}

/** Chips + popover to attach skills (user's library + templates) to a role. `onChange` receives the selected ids. */
export default function SkillPicker({ value, onChange, compact = false, busy = false }: { value: string[]; onChange: (ids: string[]) => void | Promise<void>; compact?: boolean; busy?: boolean }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(cache)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false })
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [catalog, setCatalog] = useState<{ skills: CatalogSkill[]; categories: CatalogCategory[]; total: number; running: boolean } | null>(null)
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})
  // catalog search (debounced) — the server holds the full index
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      api.catalog(q, cat, 120).then((r) => {
        r.skills.forEach((sk) => catalogSeen.set(sk.id, sk))
        setCatalog({ skills: r.skills, categories: r.categories, total: r.total, running: r.sync?.running })
      }).catch(() => setCatalog({ skills: [], categories: [], total: 0, running: false }))
    }, 180)
    return () => clearTimeout(t)
  }, [open, q, cat])
  useEffect(() => {
    loadSkills().then(setData).catch(() => {})
    const l = () => setData(cache)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  useEffect(() => {
    if (!open) return
    // the popover is portaled to <body> (role cards clip overflow): place it under the button, or above when near the bottom
    const place = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      // always opens upward (the pickers sit low in the cards and dialogs); only falls back to below when there is no room above
      const up = r.top > 260
      setPos({ top: up ? r.top - 6 : r.bottom + 6, left: Math.min(r.left, window.innerWidth - 436), up })
    }
    place()
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  // names for catalog skills attached before this picker listed them (e.g. suggested or saved in a preset)
  const [, bump] = useState(0)
  useEffect(() => {
    const missing = value.filter((id) => id.startsWith('cat-') && !catalogSeen.has(id))
    if (!missing.length) return
    Promise.all(missing.map((id) => api.skill(id).then((sk) => catalogSeen.set(id, sk as unknown as CatalogSkill)).catch(() => {}))).then(() => bump((n) => n + 1))
  }, [value])
  const all = [...(data?.skills ?? []), ...(data?.templates ?? [])]
  const selected = value.map((id) => all.find((s) => s.id === id) ?? catalogSeen.get(id)).filter(Boolean) as (Partial<CatalogSkill> & SkillSummary)[]
  const needle = q.trim().toLowerCase()
  const match = (sk: SkillSummary) => !needle || `${sk.name} ${sk.description} ${sk.tags}`.toLowerCase().includes(needle)
  const byCat = (catalog?.skills ?? []).reduce<Record<string, CatalogSkill[]>>((acc, sk) => { (acc[sk.category] ||= []).push(sk); return acc }, {})
  const catLabel = (id: string) => { const c = catalog?.categories.find((x) => x.id === id); return c ? pick(c, 'label') : id }
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  const create = async () => {
    if (!name.trim() || !body.trim()) return
    setSaving(true)
    try {
      const sk = await api.saveSkill({ name, body })
      invalidateSkills()
      const d = await loadSkills(true)
      setData(d)
      setName(''); setBody(''); setCreating(false)
      await onChange([...value, sk.id])
      toast.ok(tr('Skill creada', 'Skill created'), tr(`${sk.name} queda en tu biblioteca y ya está cargada en este rol.`, `${sk.name} is in your library and already loaded on this role.`))
    } catch (e) {
      toast.error(tr('No se pudo crear la skill', 'Could not create the skill'), (e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" onClick={() => setOpen(!open)} className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] ${value.length ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface text-ink-3 hover:text-ink'} ${compact ? '' : 'w-full'}`} title={T('Skills: conocimiento que este rol aplica (guías, convenciones, datos)', 'Skills: knowledge this role applies (guides, conventions, data)')}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Puzzle size={12} />}
        {value.length ? `${value.length} skill${value.length === 1 ? '' : 's'}` : 'skills'}
        {compact && selected.length > 0 && <span className="truncate text-ink-2 font-normal">· {selected.map((s) => pick(s, 'name')).join(', ')}</span>}
        <ChevronDown size={11} className="ml-auto" />
      </button>
      {/* the chosen skills, one chip each: hover (or tap) tells what it does, × takes it off the role */}
      {!compact && selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {selected.map((sk) => <SkillChip key={sk.id} skill={sk} onRemove={() => toggle(sk.id)} />)}
        </div>
      )}
      {open && createPortal(
        <div ref={popRef} style={{ position: 'fixed', top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, left: pos.left, maxHeight: pos.up ? Math.min(460, pos.top - 12) : 460 }} className="z-[420] flex w-[min(420px,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-paper shadow-lg text-[12.5px]">
          {/* search + category filter over everything (your skills, templates and the public catalog) */}
          <div className="border-b border-line p-2">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1">
              <Search size={13} className="text-ink-3" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={T('buscar una skill (ej. stripe, testing, figma, seo…)', 'search a skill (e.g. stripe, testing, figma, seo…)')} className="w-full bg-transparent text-[12.5px] outline-none" />
              {q && <button type="button" onClick={() => setQ('')} className="text-ink-3 hover:text-ink"><X size={12} /></button>}
            </div>
            {catalog && catalog.categories.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button type="button" onClick={() => setCat('')} className={`rounded-full border px-2 py-0.5 text-[10.5px] ${!cat ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-3 hover:text-ink'}`}>{T('todas', 'all')} · {catalog.total}</button>
                {catalog.categories.map((c) => (
                  <button key={c.id} type="button" onClick={() => setCat(cat === c.id ? '' : c.id)} className={`rounded-full border px-2 py-0.5 text-[10.5px] ${cat === c.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-3 hover:text-ink'}`}>{pick(c, 'label')} · {c.count}</button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto scroll-thin p-2">
          {!data && <div className="px-2 py-3 text-ink-3">{T('cargando…', 'loading…')}</div>}
          {data && data.skills.length === 0 && !creating && !needle && <div className="px-2 py-1.5 text-ink-3">{T('Todavía no tenés skills propias. Creá una, usá una plantilla o elegí del catálogo.', 'You have no skills of your own yet. Create one, use a template or pick from the catalog.')}</div>}
          {data && data.skills.filter(match).length > 0 && <div className="px-2 pt-1 text-[10px] uppercase tracking-widest text-ink-3">{T('Tus skills', 'Your skills')}</div>}
          {data?.skills.filter(match).map((s) => (
            <label key={s.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2 cursor-pointer">
              <input type="checkbox" className="accent-accent mt-0.5" checked={value.includes(s.id)} onChange={() => toggle(s.id)} />
              <span className="min-w-0"><span className="font-medium">{pick(s, 'name')}</span>{pick(s, 'description') && <span className="block text-[11px] text-ink-3 line-clamp-2">{pick(s, 'description')}</span>}</span>
            </label>
          ))}
          {data && data.templates.filter(match).length > 0 && !cat && <div className="px-2 pt-2 text-[10px] uppercase tracking-widest text-ink-3">{T('Plantillas', 'Templates')}</div>}
          {!cat && data?.templates.filter(match).map((s) => (
            <label key={s.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2 cursor-pointer">
              <input type="checkbox" className="accent-accent mt-0.5" checked={value.includes(s.id)} onChange={() => toggle(s.id)} />
              <span className="min-w-0"><span className="font-medium">{pick(s, 'name')}</span>{pick(s, 'description') && <span className="block text-[11px] text-ink-3 line-clamp-2">{pick(s, 'description')}</span>}</span>
            </label>
          ))}
          {/* public catalog, grouped by category (CEO, CTO, developer, QA…) */}
          {catalog && (
            <div className="mt-2">
              <div className="flex items-center px-2 text-[10px] uppercase tracking-widest text-ink-3">
                {T('Catálogo público', 'Public catalog')}{catalog.running && <span className="ml-2 normal-case tracking-normal text-accent"><Loader2 size={10} className="inline animate-spin" />{T(' descargando más…', ' downloading more…')}</span>}
                <span className="ml-auto normal-case tracking-normal">{catalog.skills.length}{catalog.skills.length >= 120 ? '+' : ''} {catalog.skills.length === 1 ? T('resultado', 'result') : T('resultados', 'results')}</span>
              </div>
              {catalog.skills.length === 0 && <div className="px-2 py-1.5 text-ink-3">{needle ? tr('Nada en el catálogo con esa búsqueda.', 'Nothing in the catalog for that search.') : tr('El catálogo todavía está vacío: se descarga en segundo plano.', 'The catalog is still empty: it downloads in the background.')}</div>}
              {Object.entries(byCat).map(([cid, list]) => {
                const expanded = openCats[cid] ?? (!!needle || !!cat || Object.keys(byCat).length <= 3)
                return (
                  <div key={cid} className="mt-1">
                    <button type="button" onClick={() => setOpenCats({ ...openCats, [cid]: !expanded })} className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11.5px] font-semibold text-ink hover:bg-surface-2">
                      <ChevronDown size={11} className={`transition ${expanded ? '' : '-rotate-90'}`} /> {catLabel(cid)} <span className="font-normal text-ink-3">· {list.length}</span>
                    </button>
                    {expanded && list.map((s) => (
                      <label key={s.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2 cursor-pointer">
                        <input type="checkbox" className="accent-accent mt-0.5" checked={value.includes(s.id)} onChange={() => toggle(s.id)} />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{pick(s, 'name')}</span>
                          <span className="ml-1 text-[10.5px] text-ink-4">{s.source}</span>
                          {pick(s, 'description') && <span className="block text-[11px] text-ink-3 line-clamp-2">{pick(s, 'description')}</span>}
                        </span>
                        <a href={s.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="mt-0.5 text-ink-4 hover:text-accent" title={T('Ver en GitHub', 'View on GitHub')}><ExternalLink size={11} /></a>
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
          </div>
          <div className="border-t border-line p-2">
            {creating ? (
              <div className="space-y-1.5 px-1">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={T('nombre (ej. Formato de datos INPRES)', 'name (e.g. INPRES data format)')} className="w-full rounded-md border border-line bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent" />
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder={T('contenido en Markdown: reglas, convenciones, referencias, datos… (pegá un documento si querés)', 'Markdown content: rules, conventions, references, data… (paste a document if you like)')} className="w-full rounded-md border border-line bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent" />
                <div className="flex gap-1.5">
                  <button type="button" disabled={saving || !name.trim() || !body.trim()} onClick={create} className="flex items-center gap-1 rounded-md bg-accent text-white px-2.5 py-1 text-[12px] font-semibold disabled:opacity-40">{saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {T('Guardar y cargar', 'Save and load')}</button>
                  <button type="button" onClick={() => setCreating(false)} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px]"><X size={12} />{T(' cancelar', ' cancel')}</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center">
                <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-accent hover:bg-accent-soft"><Plus size={13} />{T(' Nueva skill (texto o documento pegado)', ' New skill (text or pasted document)')}</button>
                <button
                  type="button"
                  onClick={async () => {
                    // translate the catalog's names/descriptions to Spanish with the first connected provider
                    try {
                      const ps = await api.providers()
                      const p = ps.find((x) => x.configured && x.id !== 'mock') ?? ps.find((x) => x.configured)
                      if (!p) return toast.error(tr('Conectá una IA primero', 'Connect an AI first'))
                      const r = await api.catalogTranslate(p.id, p.default_model)
                      toast.ok(tr('Traduciendo el catálogo', 'Translating the catalog'), tr(`${r.translated} de ${r.total_skills} ya en español; sigue en segundo plano con ${p.label}.`, `${r.translated} of ${r.total_skills} already in Spanish; continues in the background with ${p.label}.`))
                    } catch (e) {
                      toast.error(tr('No se pudo traducir', 'Could not translate'), (e as Error).message)
                    }
                  }}
                  className="ml-auto mr-3 text-[11px] text-ink-3 hover:text-accent"
                  title={T('Traducir nombres y descripciones del catálogo al español con Muse', 'Translate the catalog names and descriptions to Spanish with Muse')}
                >{T('traducir catálogo', 'translate catalog')}</button>
                <button type="button" onClick={() => api.catalogSync().then((r) => toast.ok(r.started ? tr('Actualizando el catálogo', 'Updating the catalog') : tr('Ya se está actualizando', 'Already updating'), tr('Se descargan las fuentes públicas en segundo plano.', 'The public sources download in the background.'))).catch((e) => toast.error(tr('No se pudo actualizar', 'Could not update'), (e as Error).message))} className="text-[11px] text-ink-3 hover:text-accent" title={T('Volver a descargar las fuentes públicas del catálogo', 'Download the catalog sources again')}>{T('actualizar catálogo', 'refresh catalog')}</button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/** One chosen skill: name on a chip; hovering or tapping opens a card with what it does, where it comes from and a link. */
function SkillChip({ skill, onRemove }: { skill: Partial<CatalogSkill> & SkillSummary; onRemove: () => void }) {
  const T = useT()
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const open = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: Math.min(Math.max(8, r.left), window.innerWidth - 340) })
    setShow(true)
  }
  const desc = pick(skill, 'description') || ''
  const isCatalog = String(skill.id).startsWith('cat-')
  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        onMouseEnter={open}
        onMouseLeave={() => setShow(false)}
        onFocus={open}
        onBlur={() => setShow(false)}
        onClick={(e) => { e.stopPropagation(); show ? setShow(false) : open() }}
        className="group inline-flex max-w-full cursor-help items-center gap-1 rounded-full border border-accent/30 bg-accent-soft py-0.5 pl-2 pr-1 text-[11px] text-accent"
      >
        <Puzzle size={10} className="shrink-0" />
        <span className="truncate">{pick(skill, 'name')}</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); onRemove() }} className="ml-0.5 rounded-full p-0.5 text-accent/60 hover:bg-accent hover:text-white" title={T('Quitar esta skill', 'Remove this skill')} aria-label={T('Quitar esta skill', 'Remove this skill')}><X size={10} /></button>
      </span>
      {show && createPortal(
        <div role="tooltip" style={{ position: 'fixed', top: pos.top, left: pos.left }} className="pointer-events-none z-[450] w-[330px] rounded-xl border border-line bg-surface p-3 text-[12px] leading-snug text-ink shadow-[0_18px_40px_-16px_rgba(30,38,34,.45)]">
          <div className="flex items-center gap-1.5 font-semibold"><Puzzle size={12} className="text-accent" /> {pick(skill, 'name')}</div>
          <div className="mt-1 text-ink-2">{desc || T('Esta skill no trae descripción; su contenido se suma al prompt del rol tal cual.', 'This skill has no description; its content is added to the role prompt as is.')}</div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-ink-3">
            {skill.category && <span>{T('Categoría', 'Category')}: {skill.category}</span>}
            {isCatalog && skill.repo ? <span>{T('Fuente', 'Source')}: {skill.repo}</span> : <span>{isCatalog ? T('Catálogo público', 'Public catalog') : T('Tu biblioteca', 'Your library')}</span>}
          </div>
          <div className="mt-1.5 text-[10.5px] text-ink-4">{T('Qué hace: su contenido se inyecta en el prompt de este rol para que trabaje con ese conocimiento.', 'What it does: its content is injected into this role’s prompt so it works with that knowledge.')}</div>
        </div>,
        document.body,
      )}
    </>
  )
}

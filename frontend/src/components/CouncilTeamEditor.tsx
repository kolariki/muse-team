import { motion } from 'framer-motion'
import { Check, Loader2, Plus, Trash2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useBuild, type TeamMember } from '../buildStore'
import { api } from '../lib/api'
import type { Provider, Role } from '../types'
import { PALETTE, brandTheme } from '../lib/brand'
import { pick as pickLang, tr, useLang, useT } from '../lib/i18n'
import ModelSelect from './ModelSelect'
import ProviderLogo, { LogoWatermark } from './ProviderLogo'
import { toast } from './Toast'
import { useAiConnect } from './AiConnect'

/** Who sits at the council: add or remove roles, change the company/model or the name. Saved on the build. */
export default function CouncilTeamEditor({ onSaved }: { onSaved?: (team: TeamMember[]) => void }) {
  const T = useT()
  const lang = useLang()
  const b = useBuild()
  const [draft, setDraft] = useState<TeamMember[]>(() => b.team.map((t) => ({ ...t })))
  const [providers, setProviders] = useState<Provider[]>([])
  const [roles, setRoles] = useState<{ groups: string[]; groups_en?: string[]; roles: Role[] }>({ groups: [], roles: [] })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  useEffect(() => {
    api.providers().then(setProviders).catch(() => {})
    api.roles().then(setRoles).catch(() => {})
  }, [])
  const usable = providers.filter((p) => p.configured && p.id !== 'mock')
  const ai = useAiConnect(providers, (np) => setProviders((ps) => ps.map((x) => (x.id === np.id ? np : x))))
  const dirty = JSON.stringify(draft.map(({ id, name, role, provider, model }) => ({ id, name, role, provider, model }))) !== JSON.stringify(b.team.map(({ id, name, role, provider, model }) => ({ id, name, role, provider, model })))
  const update = (i: number, patch: Partial<TeamMember>) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const roleLabel = (id: string | null) => { const r = roles.roles.find((x) => x.id === id); return r ? pickLang(r, 'label') : id ?? '' }

  const add = () => {
    const p = usable[0] ?? providers[0]
    if (!p) return
    const free = roles.roles.find((r) => r.id !== 'custom' && !draft.some((d) => d.role === r.id)) ?? roles.roles.find((r) => r.id !== 'custom')
    if (!free) return
    const n = draft.length + 1
    setDraft((d) => [...d, { id: `${free.id}-${Date.now().toString(36).slice(-4)}`, name: pickLang(free, 'label'), role: free.id, role_label: pickLang(free, 'label'), provider: p.id, model: p.default_model, color: PALETTE[(n - 1) % PALETTE.length], skills: [] }])
  }
  const save = async () => {
    if (!b.id || draft.length < 2) return
    setSaving(true)
    try {
      const r = await api.setTeam(b.id, b.sessionId, draft)
      useBuild.getState().set({ team: r.team })
      setDraft(r.team.map((t) => ({ ...t })))
      setSavedAt(Date.now())
      onSaved?.(r.team)
      toast.ok(tr('Consejo actualizado', 'Council updated'), `${r.team.length} ${tr('roles', 'roles')}: ${r.team.map((t) => t.role_label).join(', ')}`)
    } catch (e) {
      toast.error(tr('No se pudo guardar el consejo', 'Could not save the council'), (e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const input = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] shadow-sm outline-none transition focus:border-accent'

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold"><Users size={14} className="text-accent" /> {T('Quiénes se sientan en el consejo', 'Who sits at the council')} <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] text-ink-2">{draft.length}/8</span></span>
        <button type="button" disabled={draft.length >= 8 || !roles.roles.length} onClick={add} className="ml-auto flex h-8 items-center gap-1.5 rounded-full border border-accent/40 bg-surface px-3 text-[12px] font-medium text-accent shadow-sm transition hover:bg-accent/5 disabled:opacity-30"><Plus size={13} /> {T('Agregar rol', 'Add role')}</button>
      </div>
      <div className="mt-2 space-y-2">
        {draft.map((a, i) => {
          const theme = brandTheme(a.provider)
          return (
            <motion.div key={a.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-xl border p-2.5 shadow-[0_10px_24px_-16px_rgba(30,38,34,.45)]" style={{ background: theme.bg, borderColor: theme.border }}>
              <LogoWatermark provider={a.provider} opacity={0.08} />
              <div className="relative grid items-center gap-2 grid-cols-[auto_1fr_1.3fr_1fr_1.2fr_auto]">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface shadow-sm" style={{ border: `1.5px solid ${theme.accent}` }}><ProviderLogo provider={a.provider} size={18} /></span>
                <input className={input} value={a.name} onChange={(e) => update(i, { name: e.target.value })} placeholder={T('Nombre', 'Name')} />
                <select className={input} value={a.role ?? ''} onChange={(e) => { const r = roles.roles.find((x) => x.id === e.target.value); update(i, { role: e.target.value, role_label: r ? pickLang(r, 'label') : e.target.value, name: !a.name || a.name === roleLabel(a.role) ? (r ? pickLang(r, 'label') : a.name) : a.name }) }}>
                  {roles.groups.map((g, gi) => (
                    <optgroup key={g} label={lang === 'en' ? roles.groups_en?.[gi] ?? g : g}>{roles.roles.filter((x) => x.group === g && x.id !== 'custom').map((x) => <option key={x.id} value={x.id}>{pickLang(x, 'label')}</option>)}</optgroup>
                  ))}
                </select>
                <select className={input} value={a.provider} onChange={(e) => { if (ai.ask(e.target.value, (np) => update(i, { provider: np.id, model: np.default_model }))) return; const np = providers.find((x) => x.id === e.target.value); if (np) update(i, { provider: np.id, model: np.default_model }) }}>
                  {usable.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  {a.provider === 'mock' && <option value="mock">{T('Simulado (sin API)', 'Simulated (no API)')}</option>}
                  {ai.options}
                </select>
                {ai.dialog}
                <ModelSelect provider={a.provider} value={a.model} onChange={(m) => update(i, { model: m })} className="text-xs" />
                <button type="button" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} disabled={draft.length <= 2} className="rounded-md p-1 text-ink-3 transition hover:bg-danger/10 hover:text-danger disabled:opacity-20" title={T('Sacar del consejo', 'Remove from the council')}><Trash2 size={15} /></button>
              </div>
            </motion.div>
          )
        })}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[11px] text-ink-4">{T('Mínimo 2 roles con API key. Los roles que quedan conservan su personalidad y skills.', 'At least 2 roles with an API key. Roles that stay keep their persona and skills.')}</span>
        {savedAt && !dirty && <span className="ml-auto flex items-center gap-1 text-[12px] text-ok"><Check size={13} /> {T('guardado', 'saved')}</span>}
        {dirty && (
          <>
            <button type="button" onClick={() => setDraft(b.team.map((t) => ({ ...t })))} className="ml-auto text-[12px] text-ink-3 hover:text-ink">{T('descartar', 'discard')}</button>
            <button type="button" disabled={saving || draft.length < 2} onClick={save} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">{saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {T('Guardar consejo', 'Save council')}</button>
          </>
        )}
      </div>
    </div>
  )
}

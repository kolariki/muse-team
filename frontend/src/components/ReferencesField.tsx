import { Link2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'

type Status = { chrome: string | null; rea: { ok: boolean }; deep_fee_usd: number; max_references: number }

/**
 * Reference apps / URLs the team should look at, plus the paid deep analysis (REA). Reusable at any stage: setup,
 * brief, council launch, verdict. Enter/comma adds; the team proposes references when the list is empty.
 */
export default function ReferencesField({ value, onChange, deep, onDeep, compact = false, engineHint = true }: { value: string[]; onChange: (refs: string[]) => void; deep: boolean; onDeep: (v: boolean) => void; compact?: boolean; engineHint?: boolean }) {
  const T = useT()
  const [input, setInput] = useState('')
  const [st, setSt] = useState<Status | null>(null)
  useEffect(() => { api.researchStatus().then(setSt).catch(() => {}) }, [])
  const add = () => {
    const parts = input.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
    if (!parts.length) return
    onChange([...new Set([...value, ...parts])].slice(0, st?.max_references ?? 6))
    setInput('')
  }
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.25em] text-ink-3"><Link2 size={11} className="text-accent" /> {T('Apps o páginas de referencia', 'Reference apps or pages')}</div>
      <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-paper px-3 shadow-sm transition focus-within:border-accent ${compact ? 'py-1.5' : 'py-2'}`}>
        {value.map((r) => (
          <span key={r} className="flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[11.5px] text-accent">
            {r}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== r))} className="text-accent/70 hover:text-danger" title={T('Quitar', 'Remove')}><X size={11} /></button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          onBlur={add}
          placeholder={value.length ? T('otra app o URL…', 'another app or URL…') : T('ej. apple.com/weather, windy.com (Enter para agregar)', 'e.g. apple.com/weather, windy.com (Enter to add)')}
          className="min-w-[200px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink-4"
        />
      </div>
      <label className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] ${st && !st.rea.ok ? 'opacity-60' : ''}`}>
        <input type="checkbox" className="accent-accent h-4 w-4" checked={deep} disabled={!!st && !st.rea.ok} onChange={(e) => onDeep(e.target.checked)} />
        {T('Análisis profundo e ingeniería inversa', 'Deep analysis and reverse engineering')}
        <span className="rounded-full border border-gold/50 bg-gold/10 px-2 py-[1px] text-[10.5px] font-semibold text-gold">{T('pago por uso', 'pay per use')} · USD {(st?.deep_fee_usd ?? 9).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        <span className="text-[11.5px] text-ink-4">{st && !st.rea.ok ? T('(REA no está instalado en este servidor)', '(REA is not installed on this server)') : engineHint ? T('(REA analiza bundles, rutas y APIs de los referentes; aplica con Muse Code como constructor)', '(REA analyses the references’ bundles, routes and APIs; applies with Muse Code as builder)') : ''}</span>
      </label>
      <div className="mt-1 text-[11px] text-ink-4">{st && !st.chrome ? T('Sin Chrome para capturas: se analiza el texto de cada sitio.', 'No Chrome for screenshots: each site’s text is analysed.') : T('El equipo entra a cada referente, saca capturas y anota qué emular y qué evitar en research/REFERENCES.md.', 'The team visits each reference, takes screenshots and notes what to emulate and avoid in research/REFERENCES.md.')}</div>
    </div>
  )
}

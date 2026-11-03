import { Check, ChevronDown, Copy, ShieldCheck, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type DeployFailures } from '../lib/api'
import { useT } from '../lib/i18n'

/** Admin only: the deploy failures Muse Cloud has seen, which ones the automatic fix solved, and the rule each one taught. */
export default function DeployLessons() {
  const T = useT()
  const [d, setD] = useState<DeployFailures | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => { api.deployFailures().then(setD).catch(() => setD(null)) }, [])
  if (!d) return null
  const pct = d.total ? Math.round((d.fixed / d.total) * 100) : 0
  return (
    <div className="mt-8">
      <h2 className="text-2xl">{T('Errores de publicación', 'Publishing errors')}</h2>
      <p className="mt-1 text-[13px] text-ink-2">{T('Cada falla al publicar en Railway queda guardada. El constructor la arregla solo y, desde ese momento, todas las apps nuevas se construyen evitándola. Las que se repiten se previenen directamente en la configuración de Muse Team.', 'Every failure publishing to Railway is saved. The builder fixes it by itself and, from then on, every new app is built avoiding it. The ones that repeat are prevented directly in Muse Team’s configuration.')}</p>
      <div className="mt-3 rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap gap-6 text-[13px]">
          <div><div className="serif text-[26px] leading-none">{d.total}</div><div className="mt-1 text-ink-3">{T(`fallas en ${d.days} días`, `failures in ${d.days} days`)}</div></div>
          <div><div className="serif text-[26px] leading-none">{pct}%</div><div className="mt-1 text-ink-3">{T('se arreglaron solas', 'fixed themselves')}</div></div>
          <div><div className="serif text-[26px] leading-none">{d.groups.length}</div><div className="mt-1 text-ink-3">{T('tipos de error', 'kinds of error')}</div></div>
        </div>
        {d.groups.length === 0 ? (
          <div className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-ink-3">{T('Todavía no falló ninguna publicación.', 'No publish has failed yet.')}</div>
        ) : (
          <div className="mt-4 space-y-2">
            {d.groups.map((g) => (
              <details key={g.signature} className="group rounded-xl border border-line bg-paper px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">{g.label}</span>
                    <span className="text-[12px] text-ink-3">{T(`${g.count} vez/veces · ${g.apps} app(s) · ${g.fixed} arreglada(s) solas`, `${g.count} time(s) · ${g.apps} app(s) · ${g.fixed} fixed by themselves`)}{g.unfixed ? T(` · ${g.unfixed} sin arreglar`, ` · ${g.unfixed} not fixed`) : ''}</span>
                  </span>
                  {g.prevented
                    ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2.5 py-0.5 text-[11.5px] font-medium text-ok"><ShieldCheck size={12} /> {T('Ya se previene', 'Prevented now')}</span>
                    : <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-ink-3"><Wrench size={12} /> {g.rule ? T('Lo evita el constructor', 'The builder avoids it') : T('Error nuevo', 'New error')}</span>}
                  <ChevronDown size={15} className="shrink-0 text-ink-3 transition group-open:rotate-180" />
                </summary>
                <div className="mt-3 space-y-2 text-[12.5px]">
                  {g.rule && <div><span className="font-semibold">{T('Regla: ', 'Rule: ')}</span>{g.rule}</div>}
                  {g.fix_summary && <div><span className="font-semibold">{T('Cómo se arregló: ', 'How it was fixed: ')}</span>{g.fix_summary}</div>}
                  <pre className="max-h-48 overflow-auto rounded-lg bg-[#1f2622] p-3 font-mono text-[11.5px] leading-relaxed text-[#e6ebe7]">{g.excerpt || '—'}</pre>
                  {!g.prevented && (
                    <button onClick={async () => { try { await navigator.clipboard.writeText(`Error de publicación en Muse Cloud (${g.signature}, ${g.count} veces): ${g.label}\n\n${g.excerpt}${g.fix_summary ? `\n\nCómo se arregló: ${g.fix_summary}` : ''}\n\nPrevenilo en la configuración de Muse Team (Dockerfile generado / chequeos) para que no vuelva a pasar.`); setCopied(g.signature); setTimeout(() => setCopied(null), 1500) } catch { /* ignore */ } }} className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:brightness-110">
                      {copied === g.signature ? <Check size={13} /> : <Copy size={13} />} {copied === g.signature ? T('Copiado', 'Copied') : T('Copiar el pedido para prevenirlo', 'Copy the request to prevent it')}
                    </button>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

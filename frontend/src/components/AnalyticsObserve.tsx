import { AlertTriangle, Bot, ChevronDown, FlaskConical, Loader2, Send, Trophy, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { reconnectBuild } from '../buildStore'
import { api, type AiSummary, type AnalyticsApp, type ErrorIssue, type Experiments } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { toast } from './Toast'
import { PanelLoader } from './HomeLoader'
import { Tile, TrendChart } from './AnalyticsDetail'

const ago = (ts: number) => {
  const s = Math.max(1, Math.round(Date.now() / 1000 - ts))
  if (s < 90) return tr('recién', 'just now')
  const m = Math.round(s / 60)
  if (m < 60) return tr(`hace ${m} min`, `${m} min ago`)
  const h = Math.round(m / 60)
  return h < 36 ? tr(`hace ${h} h`, `${h} h ago`) : tr(`hace ${Math.round(h / 24)} días`, `${Math.round(h / 24)} days ago`)
}
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(5)}` : '$0')

/** Open the build so the user watches the builder work on what they asked from Analytics. */
function goToBuild(app: AnalyticsApp, sessionId?: string | null) {
  const sid = sessionId ?? app.session_id
  if (!sid) return
  useArena.getState().set({ pendingBuild: { buildId: app.build_id, sessionId: sid } })
  setTimeout(() => reconnectBuild(app.build_id), 1500)
}

// ------------------------------------------------------------------------------------------------ errors (like Sentry)

const SOURCE = (): Record<string, string> => ({ server: tr('servidor', 'server'), browser: tr('navegador', 'browser'), run: tr('al probarla', 'while testing') })
const STATUS = (): Record<string, [string, string]> => ({
  open: [tr('abierto', 'open'), 'border-danger/30 bg-danger/5 text-danger'],
  fixing: [tr('arreglando', 'fixing'), 'border-accent/30 bg-accent-soft text-accent'],
  deploying: [tr('publicando arreglo', 'shipping fix'), 'border-accent/30 bg-accent-soft text-accent'],
  needs_approval: [tr('espera tu OK', 'needs your OK'), 'border-gold/40 bg-gold/10 text-gold'],
  stuck: [tr('necesita revisión', 'needs a look'), 'border-gold/40 bg-gold/10 text-gold'],
  fixed: [tr('arreglado', 'fixed'), 'border-ok/30 bg-ok/10 text-ok'],
  ignored: [tr('ignorado', 'ignored'), 'border-line bg-surface text-ink-3'],
})

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  return (
    <div className="flex h-6 items-end gap-[2px]" aria-hidden>
      {values.map((v, i) => <span key={i} className={`w-[4px] rounded-t-sm ${v ? 'bg-danger/70' : 'bg-line'}`} style={{ height: `${Math.max(2, (v / max) * 24)}px` }} />)}
    </div>
  )
}

export function ErrorsTab({ app, days }: { app: AnalyticsApp; days: number }) {
  const T = useT()
  const [d, setD] = useState<{ issues: ErrorIssue[]; build_id: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => api.analyticsErrors(app.slug, days).then(setD).catch(() => setD({ issues: [], build_id: app.build_id }))
  useEffect(() => { load() }, [app.slug, days]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (e: ErrorIssue, action: 'fix' | 'approve' | 'dismiss') => {
    if (!app.session_id) return
    setBusy(e.id)
    try {
      await api.appErrorAction(app.session_id, app.build_id, e.id, action)
      toast.ok(action === 'dismiss' ? T('Listo, lo dejamos así', 'Done, left as is') : T('El constructor lo está arreglando', 'The builder is fixing it'), '')
      load()
    } catch (err) {
      toast.error(T('No se pudo', 'Could not'), (err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  if (!d) return <div className="mt-8 min-h-[300px]"><PanelLoader caption={T('Leyendo los errores…', 'Reading the errors…')} /></div>
  const openN = d.issues.filter((x) => !['fixed', 'ignored'].includes(x.status)).length
  const total = d.issues.reduce((n, x) => n + x.in_period, 0)
  return (
    <div className="mt-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label={T('Errores distintos', 'Distinct errors')} value={d.issues.length} />
        <Tile label={T('Abiertos', 'Open')} value={openN} warn={openN > 0} />
        <Tile label={T('Veces en el período', 'Times in the period')} value={total} />
        <Tile label={T('Arreglados por Muse Team', 'Fixed by Muse Team')} value={d.issues.filter((x) => x.status === 'fixed').length} />
      </div>
      <div className="panel mt-4 rounded-2xl">
        {d.issues.length === 0 && <div className="px-5 py-10 text-center text-[13px] text-ink-3">{T('Sin errores en este período. Muse Team vigila el servidor y los navegadores de tus usuarios: si aparece uno, lo ves acá y el constructor lo arregla.', 'No errors in this period. Muse Team watches the server and your users’ browsers: if one shows up you see it here and the builder fixes it.')}</div>}
        {d.issues.map((e) => {
          const [label, cls] = STATUS()[e.status] ?? [e.status, 'border-line bg-surface text-ink-3']
          const isOpen = open === e.id
          return (
            <div key={e.id} className="border-b border-line last:border-0">
              <button onClick={() => setOpen(isOpen ? null : e.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-surface-2/60">
                <AlertTriangle size={15} className={e.status === 'fixed' ? 'shrink-0 text-ok' : 'shrink-0 text-danger'} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">{e.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink-3">
                    <span>{SOURCE()[e.source] ?? e.source}</span><span>·</span><span>{T('última vez', 'last seen')} {ago(e.last_ts)}</span><span>·</span><span>{T('primera', 'first')} {ago(e.first_ts)}</span>
                  </div>
                </div>
                <Spark values={e.series} />
                <span className="w-14 shrink-0 text-right font-mono text-[13px] tabular-nums text-ink">{e.count}×</span>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${cls}`}>{label}</span>
                <ChevronDown size={14} className={`shrink-0 text-ink-3 transition ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && (
                <div className="space-y-3 px-5 pb-4">
                  {(e.what || e.fix) && (
                    <div className="rounded-xl border border-line bg-paper px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
                      {e.what && <div><b className="text-ink">{T('Qué pasó', 'What happened')}:</b> {e.what}</div>}
                      {e.fix && <div><b className="text-ink">{T('Cómo se arregla', 'How it is fixed')}:</b> {e.fix}</div>}
                      {e.impact && <div><b className="text-ink">{T('Qué cambia', 'What changes')}:</b> {e.impact}</div>}
                    </div>
                  )}
                  {e.detail && <div className="break-words font-mono text-[12px] text-ink-2">{e.detail}</div>}
                  {e.sample && e.sample !== e.detail && <pre className="max-h-64 overflow-auto scroll-thin rounded-xl bg-[#1E2622] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[#E6ECE8] whitespace-pre-wrap">{e.sample}</pre>}
                  {app.session_id && (
                    <div className="flex flex-wrap gap-2">
                      {e.status === 'needs_approval' && <button disabled={busy === e.id} onClick={() => act(e, 'approve')} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-50">{T('Aprobar el arreglo', 'Approve the fix')}</button>}
                      {['open', 'stuck', 'ignored', 'fixed'].includes(e.status) && <button disabled={busy === e.id} onClick={() => act(e, 'fix')} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-50">{busy === e.id ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />} {T('Arreglar ahora', 'Fix now')}</button>}
                      {!['fixed', 'ignored'].includes(e.status) && <button disabled={busy === e.id} onClick={() => act(e, 'dismiss')} className="flex h-8 items-center rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2 hover:border-accent hover:text-accent disabled:opacity-50">{T('Ahora no', 'Not now')}</button>}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ AI calls (like Langfuse)

function AiTable({ title, rows }: { title: string; rows: AiSummary['models'] }) {
  const T = useT()
  return (
    <div className="panel rounded-2xl p-4">
      <div className="text-[11.5px] uppercase tracking-widest text-ink-3">{title}</div>
      {rows.length ? (
        <table className="mt-2 w-full text-[12.5px]">
          <thead className="text-[10.5px] uppercase tracking-wider text-ink-4"><tr><th className="py-1 text-left font-medium"></th><th className="py-1 text-right font-medium">{T('llamadas', 'calls')}</th><th className="py-1 text-right font-medium">tokens</th><th className="py-1 text-right font-medium">{T('demora', 'latency')}</th><th className="py-1 text-right font-medium">{T('costo', 'cost')}</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key} className="border-t border-line/60"><td className="max-w-[180px] truncate py-1.5 pr-2 font-mono text-[12px] text-ink-2">{r.key}{r.errors ? <span className="ml-1.5 text-danger">· {r.errors} {T('err', 'err')}</span> : null}</td><td className="py-1.5 text-right tabular-nums">{r.calls}</td><td className="py-1.5 text-right tabular-nums">{r.tokens.toLocaleString()}</td><td className="py-1.5 text-right tabular-nums">{r.latency ? `${(r.latency / 1000).toFixed(1)} s` : '—'}</td><td className="py-1.5 text-right font-semibold tabular-nums">{usd(r.cost)}</td></tr>)}</tbody>
        </table>
      ) : <div className="mt-2 text-[12px] text-ink-4">{T('Sin datos todavía', 'No data yet')}</div>}
    </div>
  )
}

export function AiTab({ app, days }: { app: AnalyticsApp; days: number }) {
  const T = useT()
  const [d, setD] = useState<AiSummary | null>(null)
  const [metric, setMetric] = useState<'cost' | 'calls'>('cost')
  const [asking, setAsking] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { api.analyticsAi(app.slug, days).then(setD).catch(() => {}) }, [app.slug, days])
  const ask = async () => {
    setAsking(true)
    try {
      const r = await api.analyticsAsk(app.slug, 'ai')
      toast.ok(T('El constructor está conectando las llamadas de IA', 'The builder is wiring the AI calls'), T('Cuando termine, publicá: desde ahí ves costo, tokens y errores de cada llamada.', 'When it is done, publish: from then on you see cost, tokens and errors of every call.'))
      goToBuild(app, r.session_id)
    } catch (e) {
      toast.error(T('No se pudo arrancar', 'Could not start'), (e as Error).message)
      setAsking(false)
    }
  }
  if (!d) return <div className="mt-8 min-h-[300px]"><PanelLoader caption={T('Leyendo las llamadas de IA…', 'Reading the AI calls…')} /></div>
  const k = d.kpis
  return (
    <div className="mt-5">
      {k.calls === 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-[13px] text-ink-2">
          <Bot size={16} className="shrink-0 text-accent" />
          <span className="min-w-[min(100%,220px)] flex-1">{T('Todavía no llegó ninguna llamada de IA. Si tu app usa Muse, el constructor la conecta para ver acá cuánto cuesta cada función, los tokens, la demora y los errores.', 'No AI call has arrived yet. If your app uses Muse, the builder wires it so you see here what each feature costs, the tokens, latency and errors.')}</span>
          {app.session_id && <button onClick={ask} disabled={asking} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-50">{asking ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />} {T('Conectar las llamadas de IA', 'Wire the AI calls')}</button>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label={T('Costo', 'Cost')} value={usd(k.cost)} />
        <Tile label={T('Llamadas', 'Calls')} value={k.calls} />
        <Tile label={T('Costo por llamada', 'Cost per call')} value={usd(k.cost_per_call)} />
        <Tile label={T('Tokens', 'Tokens')} value={(k.input_tokens + k.output_tokens).toLocaleString()} />
        <Tile label={T('Demora promedio', 'Avg latency')} value={(k.latency ? `${(k.latency / 1000).toFixed(1)} s` : '—')} />
        <Tile label={T('Errores', 'Errors')} value={k.errors} warn={k.errors > 0} />
      </div>
      <div className="panel mt-4 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold text-ink">{metric === 'cost' ? T('Costo por día (USD)', 'Cost per day (USD)') : T('Llamadas por día', 'Calls per day')}</div>
          <div role="group" className="flex rounded-full border border-line p-0.5">
            {(['cost', 'calls'] as const).map((m) => <button key={m} onClick={() => setMetric(m)} aria-pressed={metric === m} className={`rounded-full px-2.5 py-1 text-[12px] transition ${metric === m ? 'bg-accent text-white' : 'text-ink-2 hover:text-ink'}`}>{m === 'cost' ? T('costo', 'cost') : T('llamadas', 'calls')}</button>)}
          </div>
        </div>
        <TrendChart points={d.series.map((p) => ({ x: p.day, y: p[metric] }))} />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <AiTable title={T('Por función de la app', 'By app feature')} rows={d.features} />
        <AiTable title={T('Por modelo', 'By model')} rows={d.models} />
      </div>
      {d.recent.length > 0 && (
        <div className="panel mt-4 rounded-2xl p-5">
          <div className="text-[13px] font-semibold text-ink">{T('Últimas llamadas', 'Latest calls')}</div>
          <div className="mt-2 divide-y divide-line/60">
            {d.recent.map((r, i) => (
              <div key={i}>
                <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-3 py-2 text-left text-[12.5px]">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${r.status === 'error' ? 'bg-danger' : 'bg-ok'}`} />
                  <span className="w-24 shrink-0 text-ink-3">{ago(r.ts)}</span>
                  <span className="min-w-0 flex-1 truncate"><b className="text-ink">{r.name || '—'}</b> <span className="font-mono text-[11.5px] text-ink-3">{r.model}</span></span>
                  <span className="shrink-0 tabular-nums text-ink-3">{(r.input_tokens + r.output_tokens).toLocaleString()} tok</span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-ink-3">{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)} s` : '—'}</span>
                  <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{usd(r.cost_usd)}</span>
                </button>
                {open === i && (r.error || r.input || r.output) && (
                  <div className="mb-2 space-y-1.5 rounded-xl border border-line bg-paper px-3 py-2 text-[12px]">
                    {r.error && <div className="text-danger">{r.error}</div>}
                    {r.input && <div><b className="text-ink">{T('Entrada', 'Input')}:</b> <span className="text-ink-2">{r.input}</span></div>}
                    {r.output && <div><b className="text-ink">{T('Salida', 'Output')}:</b> <span className="text-ink-2">{r.output}</span></div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ A/B experiments

export function ExperimentsTab({ app, days }: { app: AnalyticsApp; days: number }) {
  const T = useT()
  const [d, setD] = useState<Experiments | null>(null)
  const [goals, setGoals] = useState<Record<string, string>>({})
  const [idea, setIdea] = useState('')
  const [asking, setAsking] = useState(false)
  useEffect(() => { api.analyticsExperiments(app.slug, days, goals).then(setD).catch(() => {}) }, [app.slug, days, JSON.stringify(goals)]) // eslint-disable-line react-hooks/exhaustive-deps
  const ask = async () => {
    if (!idea.trim()) return
    setAsking(true)
    try {
      const r = await api.analyticsAsk(app.slug, 'ab', idea.trim())
      toast.ok(T('El constructor está armando el experimento', 'The builder is setting up the experiment'), T('Cuando termine, publicá: los resultados aparecen acá a medida que llegan visitas.', 'When it is done, publish: results show up here as visits come in.'))
      setIdea('')
      goToBuild(app, r.session_id)
    } catch (e) {
      toast.error(T('No se pudo arrancar', 'Could not start'), (e as Error).message)
    } finally {
      setAsking(false)
    }
  }
  if (!d) return <div className="mt-8 min-h-[300px]"><PanelLoader caption={T('Leyendo los experimentos…', 'Reading the experiments…')} /></div>
  return (
    <div className="mt-5 space-y-4">
      {app.session_id && (
        <div className="panel rounded-2xl p-5">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><FlaskConical size={15} className="text-accent" /> {T('Probar una idea nueva', 'Test a new idea')}</div>
          <p className="mt-1 text-[12.5px] text-ink-3">{T('Contá qué querés comparar y qué tiene que pasar para que gane. La mitad de las visitas ve la versión actual y la otra mitad la nueva; Muse Team cuenta cuál convierte más.', 'Say what you want to compare and what has to happen for it to win. Half the visitors see the current version and half the new one; Muse Team counts which converts more.')}</p>
          <div className="mt-3 flex gap-2">
            <input value={idea} onChange={(e) => setIdea(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder={T('Ej.: el botón «Reservar» en verde y arriba de todo, ¿reservan más?', 'E.g.: the «Book» button green and on top, do more people book?')} className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-paper px-3 text-[13px] outline-none focus:border-accent" />
            <button onClick={ask} disabled={asking || !idea.trim()} className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 text-[13px] font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-40">{asking ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {T('Armar el experimento', 'Set it up')}</button>
          </div>
        </div>
      )}
      {d.experiments.length === 0 && <div className="panel rounded-2xl px-5 py-10 text-center text-[13px] text-ink-3">{T('Todavía no hay experimentos con visitas. Cuando armes uno y lo publiques, acá ves cuál versión gana.', 'No experiments with visits yet. Once you set one up and publish it, here you see which version wins.')}</div>}
      {d.experiments.map((x) => {
        const best = Math.max(0.0001, ...x.variants.map((v) => v.rate))
        return (
          <div key={x.name} className="panel rounded-2xl p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[14px] font-semibold text-ink">{x.name}</span>
              <span className="text-[12px] text-ink-3">· {x.visitors} {T('visitantes', 'visitors')}</span>
              {x.winner ? <span className="flex items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[11px] font-semibold text-ok"><Trophy size={11} /> {T('gana', 'winner')}: {x.winner}</span>
                : <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-3">{T('todavía sin ganador claro', 'no clear winner yet')}</span>}
              <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">{T('Objetivo', 'Goal')}
                <select value={x.goal ?? ''} onChange={(e) => setGoals({ ...goals, [x.name]: e.target.value })} className="h-8 rounded-lg border border-line bg-paper px-2 font-mono text-[12px] text-ink">
                  {d.goals.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-3 space-y-2">
              {x.variants.map((v, i) => (
                <div key={v.variant} className="grid grid-cols-[90px_1fr_auto] items-center gap-3 text-[12.5px]">
                  <span className="font-mono font-semibold text-ink">{v.variant}{i === 0 && <span className="ml-1 font-sans text-[10.5px] font-normal text-ink-4">{T('base', 'base')}</span>}</span>
                  <div className="relative h-7 overflow-hidden rounded-lg bg-surface-2">
                    <div className={`absolute inset-y-0 left-0 rounded-lg ${x.winner === v.variant ? 'bg-ok/40' : 'bg-accent/25'}`} style={{ width: `${(100 * v.rate) / best}%` }} />
                    <span className="relative flex h-full items-center px-2 tabular-nums text-ink">{(v.rate * 100).toFixed(1)}% · {v.conversions}/{v.visitors}</span>
                  </div>
                  <span className="w-40 text-right text-[11.5px] tabular-nums text-ink-3">
                    {v.lift != null ? <span className={v.lift > 0 ? 'text-ok' : 'text-danger'}>{v.lift > 0 ? '+' : ''}{(v.lift * 100).toFixed(0)}%</span> : null}
                    {v.p != null ? ` · ${v.p < 0.05 ? T('confiable', 'reliable') : T('falta más data', 'needs more data')}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      <p className="text-[11.5px] text-ink-4">{T('Una versión gana cuando su diferencia es confiable (menos de 5 % de chance de que sea casualidad) y tiene al menos 30 visitantes.', 'A version wins when its difference is reliable (under 5% chance it is luck) and it has at least 30 visitors.')}</p>
    </div>
  )
}

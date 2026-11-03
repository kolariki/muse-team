import { AlertTriangle, Bug, Check, Loader2, RefreshCw, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type AppError, type AppErrors } from '../lib/api'
import { useT } from '../lib/i18n'

const PILL = 'flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const ORDER: AppError['status'][] = ['needs_approval', 'stuck', 'fixing', 'deploying', 'open', 'fixed', 'ignored']

function ago(ts: number, T: (es: string, en: string) => string) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))
  if (m < 1) return T('recién', 'just now')
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

/** «Publicar» → errors of the published app: what Muse Team caught and fixed by itself, and the big fixes waiting for the user's OK. */
export default function AppErrorsSection({ sessionId, buildId, live }: { sessionId: string; buildId: string; live: boolean }) {
  const T = useT()
  const [data, setData] = useState<AppErrors | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => { api.appErrors(sessionId, buildId).then(setData).catch(() => {}) }
  const working = !!data?.errors.some((e) => e.status === 'fixing' || e.status === 'deploying')
  useEffect(load, [sessionId, buildId])
  useEffect(() => {
    const id = window.setInterval(load, working ? 8000 : 45000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, buildId, working])

  const act = async (e: AppError, action: 'approve' | 'fix' | 'dismiss') => {
    setBusy(e.id + action)
    setError(null)
    try { setData(await api.appErrorAction(sessionId, buildId, e.id, action)) } catch (x) { setError((x as Error).message) } finally { setBusy(null) }
  }

  if (!data || (!data.errors.length && !live)) return null
  const rows = [...data.errors].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.last_ts - a.last_ts)
  const chip = (e: AppError) => {
    const m: Record<AppError['status'], [string, string]> = {
      needs_approval: ['border-gold/40 bg-gold/10 text-gold', T('Necesita tu OK', 'Needs your OK')],
      stuck: ['border-danger/30 bg-danger/5 text-danger', T('Sigue pasando', 'Still happening')],
      fixing: ['border-accent/30 bg-accent-soft text-accent', T('Arreglando…', 'Fixing…')],
      deploying: ['border-accent/30 bg-accent-soft text-accent', T('Publicando el arreglo…', 'Publishing the fix…')],
      open: ['border-line bg-paper text-ink-3', T('Detectado', 'Detected')],
      fixed: ['border-ok/30 bg-ok/10 text-ok', T('Arreglado', 'Fixed')],
      ignored: ['border-line bg-paper text-ink-4', T('Descartado', 'Dismissed')],
    }
    const [cls, label] = m[e.status]
    return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[1px] text-[11px] font-medium ${cls}`}>{(e.status === 'fixing' || e.status === 'deploying') && <Loader2 size={10} className="animate-spin" />}{e.status === 'fixed' && <Check size={10} />}{label}</span>
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Bug size={17} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight">{T('Errores de la app', 'App errors')}</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{T('Muse Team vigila la app publicada: los errores del servidor y de los navegadores van al constructor, que los arregla y vuelve a publicar solo. Si el arreglo es grande, te lo explica y espera tu OK.', 'Muse Team watches the published app: server and browser errors go to the builder, which fixes them and republishes by itself. If the fix is big, it explains it and waits for your OK.')}</div>
        </div>
        {data.summary.fixed > 0 && <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2.5 py-0.5 text-[11.5px] font-medium text-ok"><Check size={11} /> {data.summary.fixed} {T('arreglados solos', 'fixed by itself')}</span>}
      </div>
      {error && <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
      <div className="mt-4 space-y-2">
        {!rows.length && <div className="flex items-center gap-2 rounded-xl border border-ok/25 bg-ok/5 px-3.5 py-2.5 text-[12.5px] text-ok"><Check size={14} /> {T('Sin errores por ahora. Si aparece alguno, se arregla solo.', 'No errors so far. If one shows up, it gets fixed by itself.')}</div>}
        {rows.map((e) => e.status === 'needs_approval' || e.status === 'stuck' ? (
          <div key={e.id} className={`rounded-xl border px-4 py-3.5 ${e.status === 'stuck' ? 'border-danger/30 bg-danger/5' : 'border-gold/40 bg-gold/5'}`}>
            <div className="flex items-start gap-2">
              <AlertTriangle size={15} className={`mt-0.5 shrink-0 ${e.status === 'stuck' ? 'text-danger' : 'text-gold'}`} />
              <div className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-ink">{e.what || e.title}</div>
              {chip(e)}
            </div>
            <dl className="mt-2.5 space-y-2 pl-6 text-[12.5px] leading-snug">
              {e.status === 'stuck' && <div className="text-ink-2">{T('Lo arreglamos dos veces y sigue pasando: hace falta mirarlo con más cuidado.', 'We fixed it twice and it keeps happening: it needs a closer look.')}</div>}
              {e.fix && <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">{T('Cómo se arregla', 'How it gets fixed')}</dt><dd className="mt-0.5 text-ink-2">{e.fix}</dd></div>}
              {e.impact && <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">{T('Qué cambia para vos', 'What changes for you')}</dt><dd className="mt-0.5 text-ink-2">{e.impact}</dd></div>}
              <div className="text-[11.5px] text-ink-4">{e.count} {T('vez/veces', 'time(s)')} · {T('última hace', 'last')} {ago(e.last_ts, T)}</div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2 pl-6">
              {e.status === 'needs_approval'
                ? <button disabled={!!busy} onClick={() => act(e, 'approve')} className={PRIMARY}>{busy === e.id + 'approve' ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} {e.applied ? T('Aprobar y publicar', 'Approve and publish') : T('Aprobar el arreglo', 'Approve the fix')}</button>
                : <button disabled={!!busy} onClick={() => act(e, 'fix')} className={PRIMARY}>{busy === e.id + 'fix' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {T('Intentar de nuevo', 'Try again')}</button>}
              <button disabled={!!busy} onClick={() => act(e, 'dismiss')} className={PILL}>{T('Ahora no', 'Not now')}</button>
            </div>
            {e.detail && <details className="mt-2 pl-6 text-[11.5px] text-ink-4"><summary className="cursor-pointer hover:text-ink-2">{T('Ver el error técnico', 'See the technical error')}</summary><code className="mt-1 block whitespace-pre-wrap break-all rounded-lg bg-paper px-2 py-1.5 font-mono text-[11px] text-ink-3">{e.detail}</code></details>}
          </div>
        ) : (
          <div key={e.id} className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className={`truncate text-[13px] ${e.status === 'ignored' ? 'text-ink-4' : 'text-ink'}`} title={e.detail ?? undefined}>{e.what || e.title}</div>
              <div className="truncate text-[11.5px] text-ink-4">{e.source === 'server' ? T('servidor', 'server') : T('navegador', 'browser')} · {e.count} {T('vez/veces', 'time(s)')} · {e.status === 'fixed' && e.fixed_ts ? `${T('arreglado hace', 'fixed')} ${ago(e.fixed_ts, T)}` : `${T('última hace', 'last')} ${ago(e.last_ts, T)}`}{e.fix && e.status === 'fixed' ? ` · ${e.fix}` : ''}</div>
            </div>
            {(e.status === 'ignored' || (e.status === 'open' && data.limit_reached)) && <button disabled={!!busy} onClick={() => act(e, 'fix')} className={PILL}>{busy === e.id + 'fix' ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} {T('Arreglar ahora', 'Fix now')}</button>}
            {chip(e)}
          </div>
        ))}
      </div>
    </section>
  )
}

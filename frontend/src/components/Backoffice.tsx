import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type BackofficeData } from '../lib/api'
import { fdeStatus, fdeStatusTone } from '../lib/fde'
import { tr, useT } from '../lib/i18n'
import { downloadBlob } from '../lib/recorder'
import { toast } from './Toast'

type Tab = 'overview' | 'tickets' | 'users' | 'accounts' | 'emails' | 'payments' | 'apps'

const date = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleDateString() : '—')
const dateTime = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—')
const usd = (n: number) => `USD ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const has = (q: string, ...parts: (string | null | undefined)[]) => !q || parts.some((p) => p?.toLowerCase().includes(q))

/** The operator's desk: every account, developer request, email, payment and published app. Only administrators reach it. */
export default function Backoffice() {
  const T = useT()
  const [data, setData] = useState<BackofficeData | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [query, setQuery] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setBusy(true)
    try {
      setData(await api.backoffice())
    } catch (e) {
      toast.error(tr('No pude cargar el backoffice', 'Could not load the backoffice'), (e as Error).message)
    }
    setBusy(false)
  }
  useEffect(() => { load() }, [])
  const q = query.trim().toLowerCase()
  const status = fdeStatus()

  const setStatus = async (id: string, next: string) => {
    try {
      await api.backofficeSetStatus(id, next)
      await load()
    } catch (e) {
      toast.error(tr('No se pudo cambiar el estado', 'Could not change the status'), (e as Error).message)
    }
  }
  const ticket = (id: string) => api.backofficeTicket(id).then((md) => downloadBlob(new Blob([md], { type: 'text/markdown' }), `pedido-${id}.md`)).catch((e) => toast.error(tr('No se pudo bajar el ticket', 'Could not download the ticket'), (e as Error).message))

  const tickets = useMemo(() => (data?.requests ?? []).filter((r) => (!onlyOpen || r.open) && has(q, r.id, r.email, r.name, r.contact, r.project, r.package_name, r.notes)), [data, onlyOpen, q])
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: 'overview', label: T('Resumen', 'Overview') },
    { id: 'tickets', label: T('Tickets', 'Tickets'), n: data?.overview.open_requests },
    { id: 'users', label: T('Usuarios', 'Users'), n: data?.overview.users },
    { id: 'accounts', label: T('Cuentas conectadas', 'Connected accounts'), n: data?.accounts.length },
    { id: 'emails', label: T('Emails', 'Emails'), n: data?.overview.emails },
    { id: 'payments', label: T('Pagos', 'Payments'), n: data?.payments.length },
    { id: 'apps', label: T('Apps', 'Apps'), n: data?.overview.apps },
  ]

  return (
    <div className="w-full px-4 pb-16 pt-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Solo administradores', 'Administrators only')}</div>
          <h1 className="serif mt-1 text-[30px] leading-tight">Backoffice</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tab !== 'overview' && (
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={T('Buscar', 'Search')} aria-label={T('Buscar', 'Search')} className="h-9 w-44 rounded-full border border-line bg-surface px-3.5 text-[13px] outline-none transition focus:border-accent" />
          )}
          <button onClick={load} disabled={busy} className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] transition hover:border-accent hover:text-accent disabled:opacity-50">{busy ? T('Actualizando…', 'Refreshing…') : T('Actualizar', 'Refresh')}</button>
        </div>
      </div>

      <div className="mt-5 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition ${tab === t.id ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-2 hover:border-accent hover:text-accent'}`}>
            {t.label}{t.n != null && <span className={`tabular-nums ${tab === t.id ? 'text-white/80' : 'text-ink-3'}`}>{t.n}</span>}
          </button>
        ))}
      </div>

      {!data ? <div className="mt-8 text-[13px] text-ink-3">{busy ? T('Cargando…', 'Loading…') : T('No hay datos.', 'No data.')}</div> : (
        <div className="mt-5">
          {tab === 'overview' && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={T('Tickets abiertos', 'Open tickets')} value={data.overview.open_requests} sub={`${data.overview.new_requests} ${T('sin atender', 'not started')}`} onClick={() => setTab('tickets')} />
              <Stat label={T('Usuarios', 'Users')} value={data.overview.users} sub={`${data.overview.verified} ${T('verificados', 'verified')}`} onClick={() => setTab('users')} />
              <Stat label={T('Cobrado', 'Collected')} value={usd(data.overview.paid_usd)} sub={`${data.payments.filter((p) => p.status === 'paid').length} ${T('pagos', 'payments')}`} onClick={() => setTab('payments')} />
              <Stat label={T('Apps publicadas', 'Published apps')} value={data.overview.apps} sub={`${data.overview.open_errors} ${T('errores abiertos', 'open errors')}`} onClick={() => setTab('apps')} />
              <Stat label={T('Emails enviados', 'Emails sent')} value={data.overview.emails} sub={`${data.overview.emails_failed} ${T('fallidos', 'failed')}`} onClick={() => setTab('emails')} />
              <Stat label={T('Cuentas conectadas', 'Connected accounts')} value={data.accounts.length} sub={T('IAs, Google, Meta y demás', 'AIs, Google, Meta and more')} onClick={() => setTab('accounts')} />
            </div>
          )}

          {tab === 'tickets' && (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-1.5">
                  <Chip on={onlyOpen} onClick={() => setOnlyOpen(true)}>{T('Pendientes', 'Pending')}</Chip>
                  <Chip on={!onlyOpen} onClick={() => setOnlyOpen(false)}>{T('Todos', 'All')}</Chip>
                </div>
                <a href="https://resend.com/inboxes/soporte@tablyteam.com" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] transition hover:border-accent hover:text-accent">{T('Abrir la casilla de soporte', 'Open the support inbox')}</a>
              </div>
              {tickets.length === 0 ? <Nothing text={T('No hay tickets para mostrar.', 'No tickets to show.')} /> : (
                <div className="flex flex-col gap-2">
                  {tickets.map((r) => (
                    <div key={r.id} className="panel rounded-xl p-4">
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <div className="min-w-0 flex-1 basis-[280px]">
                          <div className="text-[14px] font-semibold">{r.package_name} <span className="ml-1 font-mono text-[11.5px] font-normal text-ink-3">{r.id}</span></div>
                          <div className="mt-0.5 text-[12.5px] text-ink-2">{r.project || T('Sin proyecto', 'No project')} · {dateTime(r.created)}</div>
                          <div className="mt-0.5 text-[12.5px] text-ink-2">{r.name} · <a href={`mailto:${r.email}`} className="text-accent hover:underline">{r.email}</a>{r.contact && r.contact !== r.email ? ` · ${r.contact}` : ''}</div>
                        </div>
                        <span className="shrink-0 text-[13px] tabular-nums text-ink-2">{usd(r.amount_usd)}</span>
                        <select aria-label={T('Estado', 'Status')} value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} className={`h-8 shrink-0 rounded-full border px-2 text-[12px] font-medium outline-none ${fdeStatusTone(r.status)}`}>
                          {data.statuses.map((s) => <option key={s} value={s}>{status[s] ?? s}</option>)}
                        </select>
                        <button onClick={() => ticket(r.id)} className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12px] transition hover:border-accent hover:text-accent">{T('Bajar ticket', 'Download ticket')}</button>
                      </div>
                      {r.notes && <p className="mt-2.5 whitespace-pre-wrap border-t border-line pt-2.5 text-[12.5px] leading-relaxed text-ink-2">{r.notes}</p>}
                      <Reply request={r} onSent={load} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'users' && (
            <Table head={[T('Usuario', 'User'), T('Alta', 'Joined'), T('Verificado', 'Verified'), T('Proyectos', 'Projects'), T('Apps', 'Apps'), T('Pedidos', 'Requests'), T('Pagó', 'Paid'), T('Conectó', 'Connected')]}
              rows={data.users.filter((u) => has(q, u.email, u.name, u.phone, ...u.connected)).map((u) => [
                <><div className="font-medium">{u.name}</div><a href={`mailto:${u.email}`} className="text-[12px] text-accent hover:underline">{u.email}</a>{u.phone && <div className="text-[12px] text-ink-3">{u.phone}</div>}</>,
                date(u.created), u.verified ? T('Sí', 'Yes') : T('No', 'No'), u.projects, u.apps, u.requests, u.paid_usd ? usd(u.paid_usd) : '—', <span className="text-[12px] text-ink-2">{u.connected.join(', ') || '—'}</span>,
              ])} />
          )}

          {tab === 'accounts' && (
            <Table head={[T('Usuario', 'User'), T('Tipo', 'Type'), T('Servicio', 'Service'), T('Cuenta', 'Account'), T('Actualizada', 'Updated')]}
              rows={data.accounts.filter((a) => has(q, a.email, a.provider, a.account)).map((a) => [a.email, a.kind, a.provider, a.account || '—', date(a.updated)])} />
          )}

          {tab === 'emails' && (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12.5px] text-ink-3">{T('Lo que mandó la plataforma desde que existe este registro. El historial anterior está en Resend.', 'What the platform has sent since this log began. Older history is in Resend.')}</p>
                <a href="https://resend.com/emails" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] transition hover:border-accent hover:text-accent">{T('Ver en Resend', 'See in Resend')}</a>
              </div>
              <Table head={[T('Fecha', 'Date'), T('Para', 'To'), T('Desde', 'From'), T('Asunto', 'Subject'), T('Estado', 'Status')]}
                rows={data.emails.filter((m) => has(q, m.to_addr, m.subject, m.from_addr)).map((m) => [dateTime(m.ts), m.to_addr, <span className="text-[12px] text-ink-2">{m.from_addr}</span>, m.subject, <Pill ok={!!m.ok}>{m.ok ? T('Enviado', 'Sent') : T('Falló', 'Failed')}</Pill>])} />
            </>
          )}

          {tab === 'payments' && (
            <Table head={[T('Fecha', 'Date'), T('Usuario', 'User'), T('Concepto', 'Concept'), T('Monto', 'Amount'), T('Vía', 'Via'), T('Estado', 'Status')]}
              rows={data.payments.filter((p) => has(q, p.email, p.concept, p.id)).map((p) => [dateTime(p.ts), p.email, p.concept, usd(p.amount_usd), p.via, <Pill ok={p.status === 'paid'}>{p.status === 'paid' ? T('Pagado', 'Paid') : p.status}</Pill>])} />
          )}

          {tab === 'apps' && (
            <Table head={[T('App', 'App'), T('Usuario', 'User'), T('Dónde', 'Where'), T('Estado', 'Status'), T('Errores abiertos', 'Open errors'), T('Actualizada', 'Updated')]}
              rows={data.apps.filter((a) => has(q, a.slug, a.email, a.url)).map((a) => [a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{a.slug}</a> : a.slug, a.email, a.provider, a.status, a.open_errors, date(a.updated)])} />
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, onClick }: { label: string; value: ReactNode; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="panel rounded-xl p-4 text-left transition hover:border-accent">
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className="mt-1.5 text-[28px] font-semibold leading-none tracking-tight tabular-nums">{value}</div>
      <div className="mt-2 text-[12px] text-ink-3">{sub}</div>
    </button>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return <button onClick={onClick} aria-pressed={on} className={`h-8 rounded-full border px-3 text-[12.5px] font-medium transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-2 hover:border-accent'}`}>{children}</button>
}

function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-danger/30 bg-danger/10 text-danger'}`}>{children}</span>
}

function Nothing({ text }: { text: string }) {
  return <div className="panel rounded-xl p-6 text-center text-[13px] text-ink-3">{text}</div>
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const T = useT()
  if (!rows.length) return <Nothing text={T('No hay nada para mostrar.', 'Nothing to show.')} />
  return (
    <div className="panel overflow-x-auto rounded-xl">
      <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
        <thead><tr className="border-b border-line text-[12px] text-ink-3">{head.map((h) => <th key={h} className="whitespace-nowrap px-4 py-2.5 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((cells, i) => <tr key={i} className="border-b border-line last:border-0">{cells.map((c, j) => <td key={j} className="px-4 py-2.5 align-top">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function Reply({ request, onSent }: { request: BackofficeData['requests'][number]; onSent: () => Promise<void> }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      const sent = await api.backofficeReply(request.id, text)
      toast.ok(tr('Respuesta enviada', 'Reply sent'), sent.to_addr)
      setText('')
      setOpen(false)
      await onSent()
    } catch (e) {
      toast.error(tr('No se pudo enviar', 'Could not send'), (e as Error).message)
    }
    setBusy(false)
  }
  return (
    <div className="mt-2.5 border-t border-line pt-2.5">
      {request.messages.map((m) => (
        <div key={m.ts} className="mb-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]">
          <div className="text-[11.5px] text-ink-3">{T('Enviado a', 'Sent to')} {m.to_addr} · {dateTime(m.ts)}</div>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-ink-2">{m.text}</p>
        </div>
      ))}
      {!open ? <button onClick={() => setOpen(true)} className="flex h-8 items-center rounded-full border border-line bg-surface px-3 text-[12px] transition hover:border-accent hover:text-accent">{T('Responder', 'Reply')}</button> : (
        <div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} autoFocus aria-label={T('Respuesta', 'Reply')} placeholder={T('Escribí tu respuesta al cliente', 'Write your reply to the client')} className="w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[13.5px] outline-none transition focus:border-accent" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button disabled={busy || !text.trim()} onClick={send} className="flex h-9 items-center rounded-full bg-accent px-4 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40">{busy ? T('Enviando…', 'Sending…') : T('Enviar', 'Send')}</button>
            <button disabled={busy} onClick={() => setOpen(false)} className="flex h-9 items-center rounded-full border border-line bg-surface px-4 text-[13px] transition hover:border-accent hover:text-accent">{T('Cancelar', 'Cancel')}</button>
            <span className="text-[12px] text-ink-3">{T('Le llega desde soporte@tablyteam.com', 'It reaches them from soporte@tablyteam.com')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

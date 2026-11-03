import { CalendarDays, Check, Copy, ExternalLink, Link2, Loader2, Unlink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type Connection } from '../lib/api'
import { getLang, tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { toast } from './Toast'

const ICON: Record<string, typeof CalendarDays> = { 'google-calendar': CalendarDays }

/** The user's accounts connected to Tably (Google Calendar…): their apps read them through Tably, never with the user's password. */
export default function Connections({ compact = false, only }: { compact?: boolean; only?: string[] }) {
  const T = useT()
  const [d, setD] = useState<{ connections: Connection[]; google_ready: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => api.connections().then(setD).catch(() => {})
  useEffect(() => { load() }, [])
  if (!d) return null
  const rows = d.connections.filter((c) => !only || only.includes(c.id))
  const connect = async (c: Connection) => {
    setBusy(c.id)
    try {
      const { url } = await api.connectionStart(c.id)
      try { sessionStorage.setItem('tably.returnHash', location.hash) } catch { /* private mode */ }
      window.location.href = url
    } catch (e) {
      toast.error(T('No se pudo conectar', 'Could not connect'), (e as Error).message)
      setBusy(null)
    }
  }
  const disconnect = async (c: Connection) => {
    if (!confirm(T(`¿Desconectar ${c.label}? Tus apps dejan de ver esos datos.`, `Disconnect ${c.label}? Your apps stop seeing that data.`))) return
    setBusy(c.id)
    try { setD({ ...d, ...(await api.connectionDelete(c.id)) }) } finally { setBusy(null) }
  }
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {rows.map((c) => {
        const Icon = ICON[c.id] ?? Link2
        return (
          <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-accent"><Icon size={18} /></span>
            <div className="min-w-[min(100%,220px)] flex-1">
              <div className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">{c.label}
                {c.connected && <span className="inline-flex items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[10.5px] font-semibold text-ok"><Check size={10} strokeWidth={3} /> {T('conectado', 'connected')}</span>}
              </div>
              <div className="text-[12.5px] text-ink-3">{c.connected && c.account ? c.account : getLang() === 'en' ? c.what_en : c.what}</div>
            </div>
            {c.connected ? (
              <button disabled={busy === c.id} onClick={() => disconnect(c)} className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] text-ink-2 transition hover:border-danger hover:text-danger disabled:opacity-50"><Unlink size={13} /> {T('Desconectar', 'Disconnect')}</button>
            ) : c.ready ? (
              <button disabled={busy === c.id} onClick={() => connect(c)} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50">{busy === c.id ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} {T(`Conectar ${c.label}`, `Connect ${c.label}`)}</button>
            ) : (
              <button onClick={() => useArena.getState().set({ view: 'settings' })} className="flex h-9 items-center gap-1.5 rounded-full border border-gold/50 bg-gold/10 px-3.5 text-[12px] text-ink transition hover:bg-gold/20" title={T('Hace falta cargar una sola vez la conexión de Google de esta instalación', 'The install’s Google connection must be set up once')}>{T('Falta activar Google en Tably', 'Google is not enabled in Tably yet')}</button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Settings, for the admin: the install's Google OAuth client, so every user can «Conectar Google Calendar» with one click. */
export function GoogleAppSettings() {
  const T = useT()
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.googleApp>> | null>(null)
  const [cid, setCid] = useState('')
  const [sec, setSec] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => { api.googleApp().then((s) => { setSt(s); setCid(s.client_id ?? '') }).catch(() => {}) }, [])
  if (!st || !st.admin) return null
  const input = 'mt-1 h-10 w-full rounded-xl border border-line bg-paper px-3 font-mono text-[12.5px] outline-none focus:border-accent'
  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); setCopied(v); setTimeout(() => setCopied(null), 1400) } catch { /* ignore */ } }
  const Row = ({ label, v }: { label: string; v: string }) => (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px]">
      <span className="shrink-0 text-ink-3">{label}</span><code className="min-w-0 flex-1 truncate font-mono font-semibold text-ink">{v}</code>
      <button onClick={() => copy(v)} className="flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:text-accent">{copied === v ? <Check size={11} /> : <Copy size={11} />} {copied === v ? T('copiado', 'copied') : T('copiar', 'copy')}</button>
    </div>
  )
  return (
    <div className="mt-3 rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-accent"><CalendarDays size={20} /></span>
        <div>
          <div className="text-[15px] font-semibold">{T('Conexión de Google para toda la app', 'Google connection for the whole app')}</div>
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-accent">{T('crear un cliente OAuth «Aplicación web» en Google Cloud', 'create a «Web application» OAuth client in Google Cloud')} <ExternalLink size={11} /></a>
        </div>
        <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${st.configured ? 'border-ok/30 bg-ok/10 text-ok' : 'border-line text-ink-3'}`}>{st.configured ? T('Configurada', 'Configured') : T('Sin configurar', 'Not configured')}</span>
      </div>
      <p className="mt-2 text-[12.5px] text-ink-2">{T('Se carga una sola vez. Con esto cada usuario conecta su Google Calendar con un clic y sus apps lo leen a través de Tably. En Google Cloud: activá la «Google Calendar API», configurá la pantalla de consentimiento y creá el cliente con estos datos:', 'Set once. With it every user connects their Google Calendar in one click and their apps read it through Tably. In Google Cloud: enable the «Google Calendar API», set up the consent screen and create the client with these values:')}</p>
      <div className="mt-3 space-y-2">
        <Row label={T('Origen autorizado:', 'Authorized origin:')} v={st.origin} />
        <Row label={T('URI de redirección:', 'Redirect URI:')} v={st.redirect_uri} />
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Client ID<input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="…apps.googleusercontent.com" className={input} /></label>
        <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Client secret<input type="password" autoComplete="off" value={sec} onChange={(e) => setSec(e.target.value)} placeholder={st.has_secret ? '•••••••••••• (guardado)' : 'GOCSPX-…'} className={input} /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={!cid.trim() && !sec.trim()} onClick={async () => { try { setSt(await api.saveGoogleApp({ client_id: cid.trim() || undefined, client_secret: sec.trim() || undefined })); setSec(''); toast.ok(tr('Conexión de Google guardada', 'Google connection saved'), '') } catch (e) { toast.error(tr('No se pudo guardar', 'Could not save'), (e as Error).message) } }} className="flex h-10 items-center rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-40">{T('Guardar', 'Save')}</button>
        {st.configured && !st.from_env && <button onClick={async () => { setSt(await api.saveGoogleApp({ clear: true })); setCid('') }} className="flex h-10 items-center rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:border-danger hover:text-danger">{T('Borrar', 'Remove')}</button>}
      </div>
    </div>
  )
}

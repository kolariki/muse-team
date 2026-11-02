import { CheckCircle2, Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type MetaApp } from '../lib/api'
import { useT } from '../lib/i18n'
import { toast } from './Toast'

const PILL = 'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40'
const PRIMARY = 'flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none transition focus:border-accent'

/** The admin turns on the connection with Meta once for the whole installation: the Meta app's ID and secret, and the
 *  address Meta has to send people back to. Then «Conectar Meta» works for everyone. */
export default function MetaSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const T = useT()
  const [st, setSt] = useState<MetaApp | null>(null)
  const [aid, setAid] = useState('')
  const [sec, setSec] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.metaApp().then((s) => { setSt(s); setAid(s.app_id ?? '') }).catch(() => {}) }, [])
  const save = async () => {
    setBusy(true)
    try {
      const s = await api.metaAppSet({ app_id: aid.trim(), app_secret: sec.trim() || undefined })
      setSt(s)
      if (s.configured) { toast.ok(T('Meta quedó habilitado', 'Meta is enabled'), T('Ahora tocá «Conectar Meta Ads» para conectar tu cuenta.', 'Now tap «Connect Meta Ads» to connect your account.')); onDone() }
    } catch (e) { toast.error(T('No pude guardar', 'Could not save'), (e as Error).message) } finally { setBusy(false) }
  }
  if (!st) return <div className="flex items-center gap-2 py-2 text-[13px] text-ink-3"><Loader2 size={14} className="animate-spin" /></div>
  const step = 'flex gap-2 text-[12.5px] text-ink-2'
  return (
    <div className="mt-1 flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent-soft/40 p-3.5">
      <div className="text-[13.5px] font-semibold text-ink">{T('Habilitar la conexión con Meta (una sola vez, para todo Tably)', 'Enable the Meta connection (once, for all of Tably)')}</div>
      <ol className="flex flex-col gap-1.5">
        <li className={step}><b>1.</b><span>{T('Entrá a ', 'Go to ')}<a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer" className="text-accent underline">developers.facebook.com/apps</a>{T(' y creá una app de tipo «Empresa» (o abrí la que ya tengas).', ' and create a «Business» app (or open the one you have).')}</span></li>
        <li className={step}><b>2.</b><span>{T('Agregale «Inicio de sesión con Facebook para empresas», «API de marketing» e «API de Instagram». En Inicio de sesión → Configuración, pegá esta dirección en «URI de redireccionamiento de OAuth válidos»:', 'Add «Facebook Login for Business», «Marketing API» and «Instagram API». In Login → Settings, paste this address under «Valid OAuth redirect URIs»:')}</span></li>
        <li className="flex items-center gap-2 pl-5"><code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[12px] text-ink">{st.redirect_uri}</code>
          <button onClick={() => navigator.clipboard.writeText(st.redirect_uri).then(() => toast.ok(T('Dirección copiada', 'Address copied')))} className={PILL}><Copy size={14} /> {T('Copiar', 'Copy')}</button></li>
        <li className={step}><b>3.</b><span>{T('En Configuración → Básica copiá el «Identificador de la app» y la «Clave secreta» y pegalos acá:', 'In Settings → Basic copy the «App ID» and «App secret» and paste them here:')}</span></li>
      </ol>
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={aid} onChange={(e) => setAid(e.target.value)} placeholder={T('Identificador de la app (App ID)', 'App ID')} className={INPUT} inputMode="numeric" />
        <input value={sec} onChange={(e) => setSec(e.target.value)} placeholder={st.has_secret ? T('Clave secreta (ya cargada; dejala vacía para no cambiarla)', 'App secret (already set; leave empty to keep it)') : T('Clave secreta de la app', 'App secret')} className={INPUT} type="password" autoComplete="off" />
      </div>
      <p className="text-[11.5px] text-ink-3">{T('Mientras Meta no apruebe la app (revisión de la app), solo funciona con las cuentas que sean administradoras o testers de esa app. La clave se guarda cifrada y nunca vuelve al navegador.', 'Until Meta approves the app (App Review), it only works with accounts that are admins or testers of that app. The secret is stored encrypted and never goes back to the browser.')}</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || !aid.trim() || (!sec.trim() && !st.has_secret)} onClick={save} className={PRIMARY}>{busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {T('Guardar', 'Save')}</button>
        <button onClick={onCancel} className={PILL}>{T('Cancelar', 'Cancel')}</button>
      </div>
    </div>
  )
}

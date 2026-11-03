import { AnimatePresence, motion } from 'framer-motion'
import { Check, CloudUpload, Copy, Database, ExternalLink, Globe, KeyRound, Loader2, Server, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ProviderSetting } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { MUSE_FIRST, MUSE_ONLY, TICKETS_ENABLED } from '../lib/flags'
import ModelSelect, { invalidateModels } from './ModelSelect'
import ProviderLogo, { LogoWatermark } from './ProviderLogo'
import PageHeader from './PageHeader'
import HomeLoader from './HomeLoader'
import { readCache, writeCache } from '../lib/cache'
import { brandTheme } from '../lib/brand'
import SubscriptionPanel from './SubscriptionPanel'
import AccountTransfer from './AccountTransfer'
import DeployLessons from './DeployLessons'
import Connections, { GoogleAppSettings } from './Connections'

const KEY_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  meta: 'https://dev.meta.ai/',
  kimi: 'https://platform.moonshot.ai/console/api-keys',
  mistral: 'https://console.mistral.ai/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  ollama: 'https://ollama.com/download',
}

export default function Settings({ onBack }: { onBack: () => void }) {
  const T = useT()
  const [items, setItems] = useState<ProviderSetting[]>(() => readCache<ProviderSetting[]>('settings.providers') ?? [])
  const [booting, setBooting] = useState(() => !readCache('settings.providers'))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.settings().then((r) => {
      const list = r.providers.filter((p) => p.kind !== 'mock')
      if (writeCache('settings.providers', list)) setItems(list)
    }).catch((e) => setError(e.message)).finally(() => setBooting(false))
    const t = setTimeout(() => setBooting(false), 8000)
    return () => clearTimeout(t)
  }, [])

  const replace = (p: ProviderSetting) => setItems((xs) => { const next = xs.map((x) => (x.id === p.id ? p : x)); writeCache('settings.providers', next); return next })
  const ready = items.filter((p) => p.configured).length

  return (
    <div className="h-full overflow-y-auto scroll-thin arena-bg">
      <AnimatePresence>{booting && <HomeLoader key="loader" caption={T('Buscando tus proveedores…', 'Looking up your providers…')} />}</AnimatePresence>
      <div className="w-full px-4 py-5 sm:px-8 sm:py-8 2xl:px-12">
        <PageHeader
          onBack={onBack}
          kicker={T('Configuración', 'Settings')}
          title={T('Modelos y API keys', 'Models and API keys')}
          right={
            <span className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface pl-2 pr-3.5 text-sm text-ink-2 shadow-sm">
              {items.filter((p) => p.configured && p.id !== 'mock').length > 0 ? (
                <span className="flex items-center">
                  {items.filter((p) => p.configured && p.id !== 'mock').map((p, i) => (
                    <span key={p.id} title={p.label} className="flex h-7 w-7 items-center justify-center rounded-full border bg-surface shadow-sm" style={{ marginLeft: i ? -9 : 0, zIndex: 20 - i, borderColor: brandTheme(p.id).accent }}>
                      <ProviderLogo provider={p.id} size={16} />
                    </span>
                  ))}
                </span>
              ) : <span className="ml-1.5 h-2 w-2 rounded-full bg-ok" />}
              {MUSE_ONLY ? (items.find((p) => p.id === 'meta')?.configured ? T('Muse conectado', 'Muse connected') : T('Muse sin conectar', 'Muse not connected')) : <>{ready} {T('de', 'of')} {items.length} {T('proveedores listos', 'providers ready')}</>}
            </span>
          }
        />
        <div className="mt-5 inline-flex w-fit max-w-full items-start gap-2 rounded-xl border border-line bg-surface py-3 pl-4 pr-[calc(1rem+16px+0.5rem)] text-[13px] text-ink-2 shadow-sm">
          <ShieldCheck size={17} className="text-ok shrink-0 mt-0.5" />
          <span>
            {T('Tus keys se guardan', 'Your keys are stored')} <b>{T('cifradas', 'encrypted')}</b> {T('en el servidor y nunca vuelven al navegador: solo se muestran los últimos 4 caracteres. Las usan únicamente tus experimentos.', 'on the server and never return to the browser: only the last 4 characters are shown. Only your experiments use them.')}
          </span>
        </div>
        {error && <div className="mt-4 text-danger text-sm">{error}</div>}
        <div data-tour="subscription"><SubscriptionPanel /></div>
        <div data-tour="keys" className="mt-10">
          <div className="text-xs uppercase tracking-[0.3em] text-ink-3">API keys</div>
          <h2 className="text-3xl mt-1">{MUSE_FIRST ? T('Muse, el motor de tu equipo', 'Muse, the engine of your team') : T('Modelos por API, para los debates', 'API models, for the debates')}</h2>
          <p className="mt-1 text-[13px] text-ink-2">{T('Los agentes del equipo (CEO, CTO, QA…) hablan con Muse por la Meta Model API, que factura por uso. Cargá tu key de Meta para empezar.', 'The team agents (CEO, CTO, QA…) talk to Muse through the Meta Model API, billed per use. Add your Meta key to get started.')}</p>
        </div>
        <div className="mt-4 grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))]">
          {items.filter((p) => !MUSE_FIRST || p.id === 'meta').map((p, i) => (
            <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <ProviderCard p={p} onSaved={replace} />
            </motion.div>
          ))}
        </div>
        {MUSE_FIRST && !MUSE_ONLY && items.some((p) => p.id !== 'meta') && (
          <details className="mt-6 group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] text-ink-3 transition hover:text-ink [&::-webkit-details-marker]:hidden">
              <span className="transition group-open:rotate-90">▸</span>
              {T('Otros proveedores compatibles', 'Other compatible providers')} · {items.filter((p) => p.id !== 'meta').length} · <span className="text-ink-4">Claude, GPT, Gemini, DeepSeek, Grok, Llama, Kimi, Mistral, OpenRouter, Ollama</span>
            </summary>
            <div className="mt-4 grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))]">
              {items.filter((p) => p.id !== 'meta').map((p) => (
                <div key={p.id}><ProviderCard p={p} onSaved={replace} /></div>
              ))}
            </div>
          </details>
        )}
        <TablyCloudSettings />
        {TICKETS_ENABLED && <NotionAppSettings />}
        <section className="mt-8">
          <h2 className="text-2xl">{T('Tus cuentas conectadas', 'Your connected accounts')}</h2>
          <p className="mt-1 mb-3 text-[13px] text-ink-2">{T('Tus apps leen estos datos a través de Muse Team (por ejemplo tu panel personal con tu agenda), nunca con tu contraseña. Podés desconectarlas cuando quieras.', 'Your apps read this data through Muse Team (for example your personal panel with your calendar), never with your password. Disconnect them anytime.')}</p>
          <div data-tour="connections"><Connections /></div>
          <GoogleAppSettings />
        </section>
        <DeploySettings />
        <DeployLessons />
        <LangfuseSettings />
        <AccountTransfer />
      </div>
    </div>
  )
}

/** Muse Cloud: what this installation can publish/provision (operator .env) and the user's GitHub token for «Mover a GitHub». */
function TablyCloudSettings() {
  const T = useT()
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.cloudStatus>> | null>(null)
  const [tok, setTok] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [ghErr, setGhErr] = useState('')
  const load = () => { api.cloudStatus().then(setSt).catch(() => {}) }
  useEffect(load, [])
  if (!st) return null
  const rows = [
    { icon: <Globe size={15} />, title: T('Hosting estático', 'Static hosting'), ok: true, value: st.static === 'cloudflare' ? 'Cloudflare Pages' : T('Servidor de Muse Team (local)', 'Muse Team server (local)'), hint: st.static === 'cloudflare' ? null : st.missing.cloudflare },
    { icon: <Server size={15} />, title: T('Apps con servidor', 'Server apps'), ok: !!st.server, value: st.server ? 'Fly Machines' : T('No disponible', 'Not available'), hint: st.missing.fly },
    { icon: <Database size={15} />, title: 'Postgres', ok: !!st.database, value: st.database ? 'Neon' : T('No disponible', 'Not available'), hint: st.missing.neon },
    { icon: <ShieldCheck size={15} />, title: T('Auth y storage', 'Auth and storage'), ok: !!st.auth, value: st.auth ? 'Supabase' : T('No disponible', 'Not available'), hint: st.missing.supabase },
  ]
  return (
    <div className="mt-8">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white"><CloudUpload size={15} /></span>
        <h2 className="text-2xl">Muse Cloud</h2>
      </div>
      <p className="mt-1 text-[13px] text-ink-2">{T('Publicación con un clic desde el constructor: hosting, base de datos y auth salen de las cuentas de Muse Team y la app se lleva a otro lado cuando quieras. Lo que falte se configura en el .env del backend.', 'One-click publishing from the builder: hosting, database and auth come from Muse Team\'s accounts and the app can be moved elsewhere whenever you want. Anything missing is configured in the backend .env.')}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r.title} className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 ${r.ok ? 'border-ok/30 bg-ok/5' : 'border-line bg-surface'}`}>
            <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${r.ok ? 'bg-ok/15 text-ok' : 'bg-surface-2 text-ink-3'}`}>{r.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[14px] font-semibold">{r.title}
                <span className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${r.ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-line bg-surface text-ink-3'}`}>{r.ok && <span className="h-2 w-2 rounded-full bg-ok" />}{r.value}</span>
              </div>
              {r.hint && <div className="mt-1 text-[11.5px] leading-snug text-ink-4">{T('Para activarlo:', 'To enable it:')} {r.hint}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface shadow-sm ring-1 ring-black/10"><ProviderLogo provider="github" size={22} /></span>
          <div>
            <div className="text-[15px] font-semibold">GitHub</div>
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=Muse%20Team" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-accent">{T('crear token con permiso «repo»', 'create a token with the "repo" scope')} <ExternalLink size={11} /></a>
          </div>
          <span className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${st.github.set && !st.github.error ? 'border-ok/30 bg-ok/10 text-ok' : st.github.set ? 'border-danger/30 bg-danger/10 text-danger' : 'border-line bg-surface text-ink-3'}`}>{st.github.set && <span className={`h-2 w-2 rounded-full ${st.github.error ? 'bg-danger' : 'bg-ok'}`} />}{!st.github.set ? T('Sin token', 'No token') : st.github.error ? T('No funciona', 'Not working') : T('Conectado', 'Connected')}</span>
        </div>
        <p className="mt-2 text-[12.5px] text-ink-2">{T('Con este token, «Mover a GitHub» crea el repositorio en tu cuenta y sube el historial completo de la construcción.', 'With this token, "Move to GitHub" creates the repository in your account and pushes the build\'s full history.')}</p>
        <div className="mt-3 flex gap-2">
          <input type="password" autoComplete="off" placeholder={st.github.set ? `token ··${st.github.last4}` : 'ghp_…'} value={tok} onChange={(e) => setTok(e.target.value)} className="h-10 flex-1 rounded-xl border border-line bg-paper px-3 font-mono text-[13px] outline-none focus:border-accent" />
          <button disabled={!tok.trim()} onClick={async () => { try { await api.saveGithubToken(tok.trim()); setTok(''); setGhErr(''); setMsg(tr('Token de GitHub guardado y probado', 'GitHub token saved and tested')); load() } catch (e) { setMsg(''); setGhErr((e as Error).message) } }} className="flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"><Check size={14} /> {T('Guardar', 'Save')}</button>
          {st.github.set && <button onClick={async () => { await api.saveGithubToken(null, true); setMsg(tr('Token borrado', 'Token deleted')); load() }} className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 transition hover:border-danger hover:text-danger"><Trash2 size={14} /> {T('Borrar', 'Delete')}</button>}
        </div>
        {(ghErr || st.github.error) && <div className="mt-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[12px] text-danger">{ghErr || st.github.error} <a href="https://github.com/settings/tokens/new?scopes=repo&description=Muse%20Team" target="_blank" rel="noreferrer" className="font-semibold underline">{T('Crear un token nuevo', 'Create a new token')}</a></div>}
        {msg && <div className="mt-2 text-[12px] text-ok">{msg}</div>}
      </div>
      {st.apps.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-5">
          <div className="text-[11px] uppercase tracking-[0.25em] text-ink-3">{T('Apps publicadas', 'Published apps')}</div>
          <ul className="mt-2 divide-y divide-line">
            {st.apps.map((a) => (
              <li key={a.slug} className="flex items-center gap-3 py-2 text-[13px]">
                <span className={`h-2 w-2 rounded-full ${a.status === 'live' ? 'bg-ok' : a.status === 'error' ? 'bg-danger' : 'bg-ink-4'}`} />
                <span className="font-mono text-[12px]">{a.slug}</span>
                <span className="text-[11.5px] text-ink-3">{a.provider} · v{a.version ?? '?'}</span>
                {a.url && <a href={a.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent hover:underline">{a.url.replace(/^https?:\/\//, '')} <ExternalLink size={11} /></a>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The app's Notion OAuth client (one per installation, set once by the admin): with it, every user connects Notion with one click. */
function NotionAppSettings() {
  const T = useT()
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.notionApp>> | null>(null)
  const [cid, setCid] = useState('')
  const [sec, setSec] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const load = () => { api.notionApp().then((s) => { setSt(s); setCid(s.client_id ?? '') }).catch(() => {}) }
  useEffect(load, [])
  if (!st || !st.admin) return null
  const input = 'h-10 w-full rounded-xl border border-line bg-paper px-3 font-mono text-[12.5px] outline-none focus:border-accent'
  return (
    <div className="mt-3 rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface shadow-sm ring-1 ring-black/10"><ProviderLogo provider="notion" size={22} /></span>
        <div>
          <div className="text-[15px] font-semibold">{T('Conexión de Notion para toda la app', 'Notion connection for the whole app')}</div>
          <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-accent">{T('crear una integración pública (OAuth) en Notion', 'create a public (OAuth) integration in Notion')} <ExternalLink size={11} /></a>
        </div>
        <span className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${st.configured ? 'border-ok/30 bg-ok/10 text-ok' : 'border-line bg-surface text-ink-3'}`}>{st.configured ? T('Configurada', 'Configured') : T('Sin configurar', 'Not configured')}{st.from_env ? ' · .env' : ''}</span>
      </div>
      <p className="mt-2 text-[12.5px] text-ink-2">{T('Se carga una sola vez. Con esto, cada usuario conecta su Notion desde «Tickets» con un clic y Muse Team recibe un token propio de esa persona. El secret queda cifrado en el servidor; nunca llega a ningún navegador.', 'Set once. With it, every user connects their Notion from "Tickets" with one click and Muse Team receives a token of their own. The secret stays encrypted on the server; it never reaches any browser.')}</p>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px]">
        <span className="text-ink-3">{T('Redirect URI en Notion:', 'Redirect URI in Notion:')}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-ink">{st.redirect_uri}</code>
        <button onClick={async () => { try { await navigator.clipboard.writeText(st.redirect_uri); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { /* ignore */ } }} className="flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-ink-2 hover:border-accent hover:text-accent">{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? T('Copiado', 'Copied') : T('Copiar', 'Copy')}</button>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Client ID<input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="406d872b-…" className={`${input} mt-1`} /></label>
        <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Client secret<input type="password" autoComplete="off" value={sec} onChange={(e) => setSec(e.target.value)} placeholder={st.has_secret ? '••••••••••••  (guardado)' : 'secret_…'} className={`${input} mt-1`} /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={!cid.trim() && !sec.trim()} onClick={async () => { try { setSt(await api.saveNotionApp({ client_id: cid.trim() || undefined, client_secret: sec.trim() || undefined })); setSec(''); setMsg(tr('Conexión de Notion guardada', 'Notion connection saved')) } catch (e) { setMsg((e as Error).message) } }} className="flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"><Check size={14} /> {T('Guardar', 'Save')}</button>
        {st.configured && !st.from_env && <button onClick={async () => { setSt(await api.saveNotionApp({ clear: true })); setCid(''); setMsg(tr('Conexión borrada', 'Connection removed')) }} className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-danger"><Trash2 size={14} /> {T('Borrar', 'Remove')}</button>}
      </div>
      {msg && <div className="mt-2 text-[12px] text-ok">{msg}</div>}
    </div>
  )
}

/** Tracing: whether every model call lands in Langfuse, and where. Configured in the backend .env (LANGFUSE_*). */
function LangfuseSettings() {
  const T = useT()
  const [h, setH] = useState<{ langfuse: boolean; langfuse_host: string | null } | null>(null)
  useEffect(() => { api.health().then(setH).catch(() => setH({ langfuse: false, langfuse_host: null })) }, [])
  return (
    <div className="mt-8">
      <h2 className="text-2xl">{T('Trazas · Langfuse', 'Tracing · Langfuse')}</h2>
      <p className="mt-1 text-[13px] text-ink-2">{T('Cada llamada a un modelo (debates, briefs, construcciones, revisiones) queda registrada con latencia, tokens y costo.', 'Every model call (debates, briefs, builds, reviews) is recorded with latency, tokens and cost.')}</p>
      <div className="relative mt-3 overflow-hidden rounded-2xl border p-5 shadow-[0_14px_30px_-18px_rgba(30,38,34,.45)]" style={{ background: brandTheme('langfuse').bg, borderColor: h?.langfuse ? brandTheme('langfuse').accent : brandTheme('langfuse').border }}>
        <LogoWatermark provider="langfuse" opacity={0.1} />
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface shadow-sm" style={{ border: `1.5px solid ${brandTheme('langfuse').accent}` }}>
            <ProviderLogo provider="langfuse" size={28} />
          </span>
          <div className="min-w-[140px] flex-1">
            <div className="text-[15px] font-semibold">Langfuse</div>
            <div className="truncate font-mono text-[12px] text-ink-3">{h?.langfuse_host || T('sin servidor configurado', 'no server configured')}</div>
          </div>
          <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${h?.langfuse ? 'bg-ok/10 text-ok border-ok/30' : 'bg-surface-2 text-ink-3 border-line'}`}>
            {h?.langfuse && <span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_0_3px_rgba(23,137,106,.18)]" />}
            {h === null ? '…' : h.langfuse ? T('Conectado', 'Connected') : T('Desactivado', 'Off')}
          </span>
          {h?.langfuse && h.langfuse_host && <a href={h.langfuse_host} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-3 text-sm shadow-sm hover:bg-surface-2"><ExternalLink size={14} /> {T('Abrir', 'Open')}</a>}
        </div>
      </div>
      <p className="mt-2 text-[12px] text-ink-4">{T('Se configura en el .env del backend con LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY y LANGFUSE_SECRET_KEY; también podés levantarlo local con docker-compose.langfuse.yml.', 'Configured in the backend .env with LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY; you can also run it locally with docker-compose.langfuse.yml.')}</p>
    </div>
  )
}

const input = 'w-full rounded-lg bg-surface border border-line px-3 py-2 text-sm font-mono outline-none focus:border-accent transition shadow-sm'

function DeploySettings() {
  const T = useT()
  const [st, setSt] = useState<{ vercel: { set: boolean; last4: string | null }; railway: { set: boolean; last4: string | null }; status: { id: string; label: string; installed: boolean; logged_in: boolean; token: boolean; hint: string | null; token_help: string }[] } | null>(null)
  const [tok, setTok] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const load = () => {
    api.deploySettings().then(setSt).catch(() => {})
  }
  useEffect(load, [])
  if (!st) return null
  return (
    <div className="mt-8">
      <h2 className="text-2xl">Deploy</h2>
      <p className="mt-1 text-[13px] text-ink-2">{T('Tokens para publicar los proyectos construidos con un clic. Alternativa sin token: iniciá sesión en tu terminal con', 'Tokens to publish the built projects in one click. Token-free alternative: sign in from your terminal with')} <code className="font-mono">vercel login</code> / <code className="font-mono">railway login</code>.</p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {st.status.map((t) => {
          const k = st[t.id as 'vercel' | 'railway']
          return (
            <div key={t.id} className="relative overflow-hidden rounded-2xl border p-5 shadow-[0_14px_30px_-18px_rgba(30,38,34,.45)] transition hover:shadow-[0_18px_40px_-18px_rgba(30,38,34,.5)]" style={{ background: brandTheme(t.id).bg, borderColor: t.installed && (t.token || t.logged_in) ? brandTheme(t.id).accent : brandTheme(t.id).border }}>
              <LogoWatermark provider={t.id} opacity={0.1} />
              <div className="relative">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface shadow-sm" style={{ border: `1.5px solid ${brandTheme(t.id).accent}` }}>
                  <ProviderLogo provider={t.id} size={t.id === 'vercel' ? 22 : 26} />
                </span>
                <div>
                  <div className="text-[15px] font-semibold">{t.label}</div>
                  <a href={t.token_help} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-accent">{T('crear token', 'create token')} <ExternalLink size={11} /></a>
                </div>
                <span className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${t.installed && (t.token || t.logged_in) ? 'bg-ok/10 text-ok border-ok/30' : 'bg-surface-2 text-ink-3 border-line'}`}>
                  {t.installed && (t.token || t.logged_in) && <span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_0_3px_rgba(23,137,106,.18)]" />}
                  {!t.installed ? T('CLI no instalado', 'CLI not installed') : k.set || t.logged_in ? T('Conectado', 'Connected') : T('Sin acceso', 'No access')}
                </span>
              </div>
              <div className="mt-4 text-[10.5px] uppercase tracking-widest text-ink-3">{k.set ? T('Reemplazar token', 'Replace token') : 'Token'}</div>
              <div className="mt-1 flex gap-2">
                <input type="password" autoComplete="off" placeholder={k.set ? `token ··${k.last4}` : `${t.label} token`} value={tok[t.id] ?? ''} onChange={(e) => setTok({ ...tok, [t.id]: e.target.value })} className={input} />
                <button disabled={!tok[t.id]?.trim()} onClick={async () => { await api.saveDeployToken(t.id, tok[t.id].trim()); setTok({ ...tok, [t.id]: '' }); setMsg(`${t.label}: ${tr('token guardado', 'token saved')}`); load() }} className="rounded-lg bg-accent px-3.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">{T('Guardar', 'Save')}</button>
              </div>
              <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-3">
                {k.set && <span>{T('Token guardado', 'Token saved')} ··{k.last4}</span>}
                {!k.set && t.logged_in && <span>{T('Logueado desde la terminal', 'Logged in from the terminal')}</span>}
                {k.set && <button onClick={async () => { await api.saveDeployToken(t.id, null, true); setMsg(`${t.label}: ${tr('token borrado', 'token deleted')}`); load() }} className="ml-auto hover:text-danger">{T('Borrar token', 'Delete token')}</button>}
              </div>
              {!t.installed && <div className="mt-2 text-[12px] text-gold">{t.hint}</div>}
              </div>
            </div>
          )
        })}
      </div>
      {msg && <div className="mt-2 text-[12.5px] text-ok">{msg}</div>}
    </div>
  )
}

function ProviderCard({ p, onSaved }: { p: ProviderSetting; onSaved: (p: ProviderSetting) => void }) {
  const T = useT()
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(p.base_url ?? '')
  const [model, setModel] = useState(p.default_model)
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' })
  const isOllama = p.id === 'ollama'
  const theme = brandTheme(p.id)

  const test = async (k?: string) => {
    setState({ kind: 'busy', msg: tr('probando…', 'testing…') })
    const r = await api.testKey(p.id, k || undefined, isOllama ? baseUrl || undefined : undefined).catch((e) => ({ ok: false, error: (e as Error).message, models: [] as string[] }))
    if (r.ok) {
      setState({ kind: 'ok', msg: `${tr('Funciona ·', 'Works ·')} ${r.models?.length ?? 0} ${tr('modelos disponibles', 'models available')}` })
    } else setState({ kind: 'error', msg: r.error })
    return r.ok
  }

  const save = async (patch: { api_key?: string; clear_key?: boolean; default_model?: string; base_url?: string }, okMsg: string) => {
    setState({ kind: 'busy', msg: tr('guardando…', 'saving…') })
    try {
      const updated = await api.saveProvider(p.id, patch)
      if (patch.api_key || patch.clear_key || patch.base_url !== undefined) invalidateModels(p.id)
      onSaved(updated)
      setState({ kind: 'ok', msg: okMsg })
    } catch (e) {
      setState({ kind: 'error', msg: (e as Error).message })
    }
  }

  const saveKey = async () => {
    if (!key.trim()) return
    if (!(await test(key.trim()))) return // don't store a key the provider rejects
    await save({ api_key: key.trim() }, tr('Key guardada y verificada', 'Key saved and verified'))
    setKey('')
  }

  const badge =
    p.source === 'user'
      ? { text: T('Conectado', 'Connected'), hint: `${T('Tu key', 'Your key')} ··${p.user_key_last4 ?? ''}`, dot: true, cls: 'bg-ok/10 text-ok border-ok/30' }
      : p.source === 'server'
        ? { text: T('Conectado', 'Connected'), hint: T('Key del servidor', 'Server key'), dot: true, cls: 'bg-ok/10 text-ok border-ok/30' }
        : { text: T('Sin key', 'No key'), hint: '', dot: false, cls: 'bg-surface-2 text-ink-3 border-line' }

  const input = 'w-full rounded-lg bg-surface border border-line px-3 py-2 text-sm outline-none focus:border-accent transition shadow-sm'

  return (
    <div className="relative h-full overflow-hidden rounded-2xl border p-5 shadow-[0_14px_30px_-18px_rgba(30,38,34,.45)] transition hover:shadow-[0_18px_40px_-18px_rgba(30,38,34,.5)]" style={{ background: theme.bg, borderColor: p.configured ? theme.accent : theme.border }}>
      <LogoWatermark provider={p.id} opacity={0.1} />
      <div className="relative">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface shadow-sm" style={{ border: `1.5px solid ${theme.accent}` }}>
          <ProviderLogo provider={p.id} size={28} />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{p.label}</div>
          <a href={KEY_URL[p.id]} target="_blank" rel="noreferrer" className="text-[12px] text-ink-3 hover:text-accent inline-flex items-center gap-1">
            {isOllama ? T('descargar Ollama', 'download Ollama') : T('conseguir una key', 'get a key')} <ExternalLink size={11} />
          </a>
        </div>
        <span title={badge.hint} className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ${badge.cls}`}>{badge.dot && <span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_0_3px_rgba(23,137,106,.18)]" />}{badge.text}</span>
      </div>

      {isOllama ? (
        <div className="mt-4">
          <label className="text-[11px] uppercase tracking-widest text-ink-3">{T('URL del servidor', 'Server URL')}</label>
          <div className="mt-1 flex gap-2">
            <input className={`${input} font-mono`} placeholder="http://localhost:11434/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <button className="rounded-lg bg-accent px-3.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110" onClick={async () => (await test()) && save({ base_url: baseUrl }, tr('Servidor guardado', 'Server saved'))}>{T('Guardar', 'Save')}</button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <label className="text-[11px] uppercase tracking-widest text-ink-3">{p.source === 'user' ? T('Reemplazar key', 'Replace key') : 'API key'}</label>
          <div className="mt-1 flex gap-2">
            <div className="relative flex-1">
              <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
              <input
                className={`${input} pl-8 font-mono`}
                type="password"
                autoComplete="off"
                placeholder={p.key_env ?? 'api key'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveKey()}
              />
            </div>
            <button disabled={!key.trim() || state.kind === 'busy'} onClick={saveKey} className="rounded-lg bg-accent px-3.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">
              {T('Guardar', 'Save')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <label className="text-[11px] uppercase tracking-widest text-ink-3">{T('Modelo por defecto', 'Default model')}</label>
        <div className="mt-1">
          <ModelSelect
            key={`${p.source}-${p.user_key_last4 ?? ''}-${p.base_url ?? ''}`}
            provider={p.id}
            value={model}
            enabled={p.configured}
            onChange={(m) => {
              setModel(m)
              if (m && m !== p.default_model) save({ default_model: m }, `${tr('Modelo por defecto:', 'Default model:')} ${m}`)
            }}
          />
        </div>
        {!p.configured && <div className="mt-1 text-[11.5px] text-ink-3">{T('Cargá una key para ver todos los modelos disponibles.', 'Add a key to see all available models.')}</div>}
      </div>

      <div className="mt-4 flex items-center gap-3 text-[12.5px] min-h-6">
        {state.kind === 'busy' && <span className="flex items-center gap-1.5 text-ink-3"><Loader2 size={13} className="animate-spin" /> {state.msg}</span>}
        {state.kind === 'ok' && <span className="flex items-center gap-1.5 text-ok"><Check size={14} /> {state.msg}</span>}
        {state.kind === 'error' && <span className="text-danger">{state.msg}</span>}
        <div className="ml-auto flex gap-3">
          {p.configured && state.kind !== 'busy' && <button onClick={() => test()} className="text-ink-3 hover:text-accent">{T('Probar conexión', 'Test connection')}</button>}
          {p.source === 'user' && !isOllama && (
            <button onClick={() => save({ clear_key: true }, tr('Key borrada', 'Key deleted'))} className="flex items-center gap-1 text-ink-3 hover:text-danger"><Trash2 size={13} /> {T('Borrar mi key', 'Delete my key')}</button>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}

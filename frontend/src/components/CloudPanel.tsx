import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Copy, Database, ExternalLink, GitBranch, Globe, KeyRound, Loader2, Lock, Rocket, Server, ShieldCheck, Trash2, Upload, RefreshCw, ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useBuild } from '../buildStore'
import { api, getToken, type CloudInfo } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import ProviderLogo from './ProviderLogo'
import { toast } from './Toast'
import BlockedNotice, { BuilderBusyNotice } from './BlockedNotice'
import AppErrorsSection from './AppErrorsSection'

const PILL = 'flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-2 shadow-sm transition hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-2'
const PRIMARY = 'flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40'
const CARD = 'rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(30,38,34,.04),0_8px_24px_-16px_rgba(30,38,34,.18)]'

const PROVIDER_LABEL: Record<string, [string, string]> = {
  local: ['Muse Cloud · servidor propio', 'Muse Cloud · own server'],
  cloudflare: ['Muse Cloud · Cloudflare', 'Muse Cloud · Cloudflare'],
  fly: ['Muse Cloud · Fly Machines', 'Muse Cloud · Fly Machines'],
  railway: ['Muse Cloud · Railway', 'Muse Cloud · Railway'],
}

const infoCache = new Map<string, CloudInfo>()

function ago(ts: number, T: (es: string, en: string) => string) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))
  if (m < 1) return T('recién', 'just now')
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1400) } catch { toast.error(tr('No se pudo copiar', 'Could not copy'), '') } }} className={`${PILL} h-8 px-3 text-[12px]`}>
      {ok ? <Check size={13} /> : <Copy size={13} />} {label ?? (ok ? tr('Copiado', 'Copied') : tr('Copiar', 'Copy'))}
    </button>
  )
}

function Section({ icon, title, hint, right, children }: { icon: ReactNode; title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">{icon}</span>
        <div className="min-w-[180px] flex-1">
          <div className="text-[15px] font-semibold leading-tight">{title}</div>
          {hint && <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</div>}
        </div>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Terminal({ lines, open, onToggle, live }: { lines: string[]; open: boolean; onToggle: () => void; live: boolean }) {
  const T = useT()
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [lines.length])
  if (!lines.length) return null
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[#2A3430] bg-[#1E2622]">
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] uppercase tracking-[0.2em] text-[#9FB3A9]">
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-ok animate-pulse' : 'bg-[#5B6B64]'}`} />
        {T('Registro', 'Log')} · {lines.length}
        <ChevronDown size={13} className={`ml-auto transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <pre ref={ref} className="scroll-thin max-h-56 overflow-y-auto px-3 pb-3 font-mono text-[11.5px] leading-relaxed text-[#E6ECE8] whitespace-pre-wrap">{lines.join('\n')}</pre>}
    </div>
  )
}

/** Right-pane tab «Publicar»: one-click hosting, database/auth provisioning, own git remote and the way out (migration). */
export default function CloudPanel() {
  const T = useT()
  const b = useBuild()
  const [info, setInfo] = useState<CloudInfo | null>(() => (b.id ? infoCache.get(b.id) ?? null : null))
  const [error, setError] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [ghName, setGhName] = useState('')
  const [ghPrivate, setGhPrivate] = useState(true)
  const [cloneWithToken, setCloneWithToken] = useState(false)

  const reload = () => {
    if (!b.sessionId || !b.id) return
    const id = b.id
    api.cloud(b.sessionId, b.id).then((d) => {
      infoCache.set(id, d)
      setInfo(d)
      useBuild.getState().set({ cloudApp: d.app, publishing: d.publishing })
      if (!ghName) setGhName((b.title || id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60))
    }).catch((e) => setError(e.message))
  }
  useEffect(reload, [b.sessionId, b.id, b.publishing, b.cloudApp?.status, b.cloudApp?.updated, b.cloudGithub])
  useEffect(() => { if (b.publishing) setLogOpen(true) }, [b.publishing])
  // a finished build has no live socket: while something is being published, poll until it settles
  const inFlight = !!info?.publishing || info?.app?.status === 'building' || info?.app?.status === 'deploying' || b.cloudApp?.status === 'deploying' || b.publishing
  useEffect(() => {
    if (!inFlight) return
    const id = window.setInterval(reload, 2500)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight, b.sessionId, b.id])

  const app = b.cloudApp ?? info?.app ?? null
  const st = info?.status
  const live = app?.status === 'live' && !!app.url
  const deploying = app?.status === 'deploying'
  const publishing = b.publishing || !!info?.publishing || app?.status === 'building'
  const finished = ['completed', 'approved', 'audited', 'stopped', 'error', 'design_review'].includes(b.status)

  const act = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      if (okMsg) toast.ok(okMsg, '')
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const cloneUrl = info?.git.clone_url ?? ''
  const cloneUrlTok = cloneUrl && getToken() ? cloneUrl.replace('://', `://token:${getToken()}@`) : cloneUrl

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-paper/40 px-3 py-4 sm:px-6 sm:py-5">
      <div className="mx-auto max-w-[760px] space-y-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.3em] text-accent">Muse Cloud</div>
            <h3 className="mt-0.5 text-[24px] leading-tight">{T('Publicar', 'Publish')}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{T('La app sale funcionando con una URL, con base de datos y auth si las necesita, y con su repositorio git. Cuando quieras, te la llevás a tus propias cuentas.', 'The app goes live with a URL, with database and auth when needed, and its own git repository. Whenever you want, take it to your own accounts.')}</p>
          </div>
          {app && (
            <span className={`mt-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${live ? 'border-ok/30 bg-ok/10 text-ok' : app.status === 'error' ? 'border-danger/30 bg-danger/5 text-danger' : publishing || deploying ? 'border-accent/30 bg-accent-soft text-accent' : 'border-line bg-surface text-ink-3'}`}>
              {live && <span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_0_3px_rgba(23,137,106,.18)]" />}
              {(publishing || deploying) && <Loader2 size={11} className="animate-spin" />}
              {live ? T('En línea', 'Live') : deploying ? T('Desplegando', 'Deploying') : app.status === 'error' ? T('Falló', 'Failed') : publishing ? T('Publicando', 'Publishing') : T('Dada de baja', 'Taken down')}
            </span>
          )}
        </div>

        <BuilderBusyNotice what={T('Publicar toma los archivos tal como queden.', 'Publishing takes the files as they end up.')} />
        {error && <BlockedNotice kind="blocked" title={error} action={{ label: T('Cerrar', 'Close'), onClick: () => setError(null) }} />}

        {/* -------- hosting */}
        <Section
          icon={<Globe size={17} />}
          title={live ? T('Tu app está publicada', 'Your app is published') : T('Hosting', 'Hosting')}
          hint={live ? undefined : st?.static === 'cloudflare' ? T('Estáticos en Cloudflare bajo nuestro dominio; apps con servidor en ' + (st?.server === 'railway' ? 'Railway' : 'Fly Machines') + '.', 'Static sites on Cloudflare under our domain; server apps on ' + (st?.server === 'railway' ? 'Railway' : 'Fly Machines') + '.') : st?.server === 'railway' ? T('Estáticos servidos por Muse Cloud al instante. Apps con servidor: en Railway, con su propia base de datos.', 'Static sites served by Muse Cloud instantly. Server apps: on Railway, with their own database.') : T('Estáticos servidos por Muse Cloud al instante. Apps con servidor: según la instalación.', 'Static sites served by Muse Cloud instantly. Server apps: depends on the installation.')}
          right={app?.provider && <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-0.5 text-[11.5px] text-ink-3">{app.provider === 'cloudflare' ? <ProviderLogo provider="cloudflare" size={12} /> : app.provider === 'fly' || app.provider === 'railway' ? <Server size={12} /> : <Globe size={12} />} {T(...(PROVIDER_LABEL[app.provider] ?? [app.provider, app.provider]))}</span>}
        >
          {live && app?.url && (
            <a href={app.url} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3 transition hover:border-accent">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white"><Rocket size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-accent">{app.url.replace(/^https?:\/\//, '')}</span>
                <span className="block text-[11.5px] text-ink-3">v{app.version ?? '?'} · {T('actualizada hace', 'updated')} {ago(app.updated, T)}{app.kind === 'static' ? ` · ${T('estática', 'static')}` : app.kind === 'server' ? ` · ${T('con servidor', 'server')}` : ''}</span>
              </span>
              <ExternalLink size={15} className="text-accent opacity-70 transition group-hover:opacity-100" />
            </a>
          )}
          {deploying && (
            <div className="mt-3 flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-3.5 py-3 text-[13px]">
              <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-accent" />
              <div className="min-w-0">
                <div className="font-semibold text-ink">{T('Desplegando la aplicación en Railway…', 'Deploying the app on Railway…')}</div>
                <div className="mt-0.5 text-ink-2">{T('Railway construye la imagen y la arranca; suele tardar unos minutos. Te avisamos cuando esté en línea, aunque cierres este panel.', 'Railway builds the image and starts it; it usually takes a few minutes. We let you know when it is live, even if you close this panel.')}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[12px]">{app?.url && <span className="font-mono text-ink-3">{app.url}</span>}{app?.deploy_logs && <a href={app.deploy_logs} target="_blank" rel="noreferrer" className="text-accent hover:underline">{T('Ver el build en Railway', 'See the build on Railway')} ↗</a>}</div>
              </div>
            </div>
          )}
          {app?.status === 'error' && app.error && <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] leading-snug text-danger">{app.error}</div>}
          {app && (app.status === 'live' || app.status === 'deploying') && !!b.servicesMissing?.count && (
            <div className="mt-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2.5 text-[12.5px]">
              <div className="font-semibold text-ink">{T('Tu app está en línea, pero todavía le faltan servicios', 'Your app is online, but it still misses some services')}</div>
              <ul className="mt-1 space-y-0.5 text-ink-2">{b.servicesMissing.impacts.map((t) => <li key={t}>· {t}</li>)}</ul>
              <button onClick={() => useBuild.getState().set({ paneOpen: true, pane: 'deploy' })} className="mt-2 flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-110"><KeyRound size={12} /> {T('Configurar servicios', 'Set up services')}</button>
            </div>
          )}
          {app?.leaks?.keys?.length ? (
            <div className="mt-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2.5 text-[12.5px]">
              <div className="flex items-center gap-1.5 font-semibold text-ink"><KeyRound size={13} className="text-gold" /> {T('Claves que estaban escritas en el código', 'Keys that were written in the code')}</div>
              <div className="mt-0.5 text-ink-3">{app.status === 'error' ? T('Hay que pasarlas a variables de entorno para que nadie pueda verlas. Los valores ya están guardados en «Servicios»: falta que el código los lea de ahí.', 'They have to move to environment variables so nobody can see them. The values are already saved in «Services»: the code still has to read them from there.') : T('Las estamos pasando a variables de entorno (las ves en «Servicios») para que nadie pueda verlas.', 'We are moving them to environment variables (see «Services») so nobody can see them.')}</div>
              <ul className="mt-2 space-y-1.5">
                {app.leaks.keys.map((k) => (
                  <li key={k.env} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{k.service}</span>
                    <span className="font-mono text-[11px] text-ink-3">{k.env} · {k.files[0]}</span>
                    {k.live && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger">{T('sigue activa', 'still active')}</span>}
                    {k.live && k.url && <a href={k.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white hover:brightness-110"><ExternalLink size={11} /> {T('Cambiarla', 'Change it')}</a>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button disabled={publishing || deploying || !finished || Object.keys(b.files).length === 0} onClick={() => act('publish', () => api.cloudPublish(b.sessionId!, b.id!))} className={PRIMARY} title={!finished ? T('Esperá a que el constructor termine', 'Wait for the builder to finish') : undefined}>
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {publishing ? T('Publicando…', 'Publishing…') : live ? T('Republicar', 'Republish') + (info && app && info.version !== app.version ? ` · v${info.version}` : '') : T('Publicar ahora', 'Publish now')}
            </button>
            {live && app?.url && <CopyBtn text={app.url} label={T('Copiar URL', 'Copy URL')} />}
            {live && (
              <button disabled={busy === 'down'} onClick={() => { if (confirm(T('¿Dar de baja la app publicada? La URL deja de funcionar.', 'Take the published app down? The URL stops working.'))) act('down', () => api.cloudUnpublish(b.sessionId!, b.id!), T('App dada de baja', 'App taken down')) }} className={`${PILL} hover:border-danger hover:bg-danger/5 hover:text-danger`}>
                {busy === 'down' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {T('Dar de baja', 'Take down')}
              </button>
            )}
          </div>
          {live && info && app && info.version > (app.version ?? 0) && <p className="mt-2 text-[12px] text-gold">{T('Hay una versión más nueva que la publicada', 'There is a newer version than the published one')} (v{info.version} vs v{app.version}).</p>}
          {!live && !publishing && st && !st.server && <p className="mt-2 text-[12px] leading-snug text-ink-4">{T('Las apps con servidor propio necesitan', 'Apps with their own server need')} {st.missing.railway ?? st.missing.fly}. {T('Mientras tanto corrélas en «App real» o llevalas a Railway.', 'Meanwhile run them in "Real app" or take them to Railway.')}</p>}
          <Terminal lines={b.cloudLogs.length ? b.cloudLogs : info?.app?.log ?? app?.log ?? []} open={logOpen} onToggle={() => setLogOpen((v) => !v)} live={publishing} />
        </Section>

        {app && b.sessionId && b.id && <AppErrorsSection sessionId={b.sessionId} buildId={b.id} live={live} />}

        {/* -------- database & auth */}
        <Section icon={<Database size={17} />} title={T('Base de datos y auth', 'Database and auth')} hint={T('Se crean con un clic y las variables quedan guardadas en los secretos de esta construcción (y en el .env al correr o publicar).', 'Created in one click; the variables are stored in this build\'s secrets (and in the .env when running or publishing).')}>
          <div className="grid gap-2 md:grid-cols-2">
            {([
              { slot: 'database' as const, provider: 'neon' as const, icon: <Database size={15} />, title: 'Postgres', sub: T('Neon · una base por proyecto', 'Neon · one database per project'), avail: !!st?.database, missing: st?.missing.neon },
              { slot: 'auth' as const, provider: 'supabase' as const, icon: <ShieldCheck size={15} />, title: T('Auth y storage', 'Auth and storage'), sub: T('Supabase · usuarios, archivos y Postgres', 'Supabase · users, files and Postgres'), avail: !!st?.auth, missing: st?.missing.supabase },
            ]).map((d) => {
              const rec = app?.db?.[d.slot]
              return (
                <div key={d.slot} className={`rounded-xl border px-3.5 py-3 ${rec?.ok ? 'border-ok/30 bg-ok/5' : 'border-line bg-paper'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`flex h-7 w-7 items-center justify-center rounded-full ${rec?.ok ? 'bg-ok/15 text-ok' : 'bg-surface-2 text-ink-3'}`}>{d.icon}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold">{d.title}</div>
                      <div className="truncate text-[11.5px] text-ink-3">{rec?.ok ? rec.host : d.sub}</div>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    {rec?.ok ? (
                      <div className="flex flex-wrap gap-1">{rec.vars.map((v) => <code key={v} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{v}</code>)}</div>
                    ) : d.avail ? (
                      <button disabled={busy === d.provider} onClick={() => act(d.provider, () => api.cloudDb(b.sessionId!, b.id!, d.provider), T('Listo: variables guardadas', 'Done: variables saved'))} className={`${PILL} h-8 px-3 text-[12px]`}>
                        {busy === d.provider ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {T('Crear', 'Create')} {d.title}
                      </button>
                    ) : (
                      <div className="text-[11.5px] leading-snug text-ink-4">{T('No disponible en esta instalación:', 'Not available in this installation:')} {d.missing}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        {/* -------- git */}
        <Section
          icon={<GitBranch size={17} />}
          title={T('Código', 'Code')}
          hint={T('Repositorio git propio de esta construcción, con un commit por versión. Clonalo con tu token de la cuenta como contraseña.', 'This build\'s own git repository, one commit per version. Clone it using your account token as the password.')}
          right={<button disabled={busy === 'sync'} onClick={() => act('sync', () => api.gitSync(b.sessionId!, b.id!), T('Repositorio sincronizado', 'Repository synced'))} className={`${PILL} h-8 px-3 text-[12px]`}>{busy === 'sync' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {T('Sincronizar', 'Sync')}</button>}
        >
          {info?.git && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2">
                <code className="min-w-0 basis-full truncate font-mono text-[12px] text-ink-2 sm:basis-auto sm:flex-1">git clone {cloneWithToken ? cloneUrlTok : cloneUrl}</code>
                <button onClick={() => setCloneWithToken((v) => !v)} className={`${PILL} h-7 px-2.5 text-[11px]`} title={T('Incluir tu token en la URL (no la compartas)', 'Include your token in the URL (do not share it)')}><Lock size={11} /> {cloneWithToken ? T('sin token', 'without token') : T('con token', 'with token')}</button>
                <CopyBtn text={`git clone ${cloneWithToken ? cloneUrlTok : cloneUrl}`} />
              </div>
              {info.git.commits.length > 0 ? (
                <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
                  {info.git.commits.slice(0, 6).map((c) => (
                    <li key={c.hash} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                      <code className="font-mono text-[11px] text-accent">{c.hash}</code>
                      <span className="min-w-0 flex-1 truncate">{c.message}</span>
                      {c.refs.filter((r) => r.startsWith('tag:')).map((r) => <span key={r} className="rounded-full bg-accent-soft px-2 py-[1px] text-[10.5px] font-medium text-accent">{r.replace('tag: ', '')}</span>)}
                      <span className="shrink-0 text-[11px] text-ink-4">{ago(c.ts, T)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[12px] text-ink-4">{T('Todavía no hay commits: tocá «Sincronizar» o publicá la app.', 'No commits yet: hit "Sync" or publish the app.')}</p>
              )}
            </>
          )}
          <div className="mt-4 rounded-xl border border-line bg-paper p-3.5">
            <div className="flex items-center gap-2">
              <ProviderLogo provider="github" size={16} />
              <div className="text-[13px] font-semibold">{T('Mover a GitHub', 'Move to GitHub')}</div>
              {b.cloudGithub && <a href={b.cloudGithub} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent hover:underline">{b.cloudGithub.replace('https://github.com/', '')} <ExternalLink size={11} /></a>}
            </div>
            {info?.github.set ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <input value={ghName} onChange={(e) => setGhName(e.target.value)} placeholder={T('nombre del repo', 'repo name')} className="h-9 min-w-[200px] flex-1 rounded-xl border border-line bg-surface px-3 font-mono text-[12.5px] outline-none focus:border-accent" />
                <label className="flex items-center gap-1.5 text-[12px] text-ink-2"><input type="checkbox" className="accent-accent" checked={ghPrivate} onChange={(e) => setGhPrivate(e.target.checked)} /> {T('privado', 'private')}</label>
                <button disabled={!ghName.trim() || busy === 'gh'} onClick={() => act('gh', async () => { const r = await api.gitGithub(b.sessionId!, b.id!, ghName.trim(), ghPrivate); useBuild.getState().set({ cloudGithub: r.url }) }, T('Código en GitHub', 'Code on GitHub'))} className={PRIMARY}>
                  {busy === 'gh' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} {T('Crear repo y subir', 'Create repo and push')}
                </button>
              </div>
            ) : (
              <p className="mt-2 text-[12px] leading-snug text-ink-3">{T('Cargá un token de GitHub (permiso «repo») en', 'Add a GitHub token (scope "repo") in')} <button onClick={() => useArena.getState().set({ view: 'settings' })} className="text-accent hover:underline">{T('Configuración → Muse Cloud', 'Settings → Muse Cloud')}</button> {T('y el repo se crea y se sube con el historial completo.', 'and the repo is created and pushed with the full history.')}</p>
            )}
          </div>
        </Section>

        {/* -------- migrate */}
        <Section icon={<Server size={17} />} title={T('Llevarla a otro lado', 'Take it elsewhere')} hint={T('Todo lo que publicamos es estándar: un build estático o un Dockerfile, Postgres y git. Nada te ata.', 'Everything we publish is standard: a static build or a Dockerfile, Postgres and git. Nothing locks you in.')}>
          <div className="grid gap-2 md:grid-cols-2">
            <button onClick={() => useBuild.getState().set({ pane: 'deploy' })} className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-3 text-left transition hover:border-accent hover:bg-accent-soft">
              <span className="flex -space-x-1"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider="vercel" size={12} /></span><span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface ring-1 ring-black/10"><ProviderLogo provider="railway" size={14} /></span></span>
              <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{T('Hosting: Vercel o Railway', 'Hosting: Vercel or Railway')}</span><span className="block text-[11.5px] text-ink-3">{T('Con tus tokens, desde «Servicios».', 'With your tokens, from "Services".')}</span></span>
              <ArrowRight size={14} className="text-ink-3" />
            </button>
            <div className="rounded-xl border border-line bg-paper px-3.5 py-3">
              <div className="text-[13px] font-semibold">{T('Base de datos', 'Database')}</div>
              {info?.migration.has_database ? (
                <>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{info.migration.database_url_masked}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-[#1E2622] px-2 py-1 font-mono text-[11px] text-[#E6ECE8]">{info.migration.pg_dump}</code>
                    <CopyBtn text={`${info.migration.pg_dump}\n${info.migration.pg_restore}`} label={T('Copiar', 'Copy')} />
                  </div>
                </>
              ) : (
                <div className="mt-0.5 text-[11.5px] text-ink-3">{T('Esta app no tiene DATABASE_URL guardada todavía.', 'This app has no DATABASE_URL saved yet.')}</div>
              )}
            </div>
          </div>
          {info && info.migration.env_vars.length > 0 && (
            <p className="mt-3 text-[11.5px] leading-snug text-ink-4">{T('Variables guardadas:', 'Saved variables:')} {info.migration.env_vars.join(', ')}. {T('Las ves y editás en «Servicios».', 'See and edit them in "Services".')}</p>
          )}
        </Section>

        <AnimatePresence>
          {publishing && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-[12px] text-ink-3"><Loader2 size={13} className="animate-spin text-accent" /> {T('Compilando y publicando… podés cerrar este panel, sigue en el servidor.', 'Building and publishing… you can close this panel, it keeps running on the server.')}</motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

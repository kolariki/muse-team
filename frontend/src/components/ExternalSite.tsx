import { Check, Copy, ExternalLink, GitPullRequest, KeyRound, Link2, Loader2, Plus, RefreshCw, Terminal, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { api, type AnalyticsApp } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { useArena } from '../store'
import { toast } from './Toast'

const INPUT = 'h-10 w-full rounded-xl border border-line bg-paper px-3 text-[13.5px] outline-none focus:border-accent'
const PRIMARY = 'flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50'
const PILL = 'flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] text-ink-2 transition hover:border-accent hover:text-accent disabled:opacity-50'

/** «Conectar un sitio»: an app that lives outside Tably (its own GitHub + Railway/Vercel…) gets Analytics without being uploaded. */
export function ConnectSite({ onDone }: { onDone: (slug: string) => void }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ title: '', url: '', repo: '' })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const s = await api.siteCreate(f)
      setOpen(false); setF({ title: '', url: '', repo: '' })
      onDone(s.slug)
    } catch (e) { toast.error(tr('No se pudo conectar', 'Could not connect'), (e as Error).message) } finally { setBusy(false) }
  }
  if (!open) return <button onClick={() => setOpen(true)} className={PRIMARY}><Plus size={14} /> {T('Conectar un sitio que ya está online', 'Connect a site that is already live')}</button>
  return (
    <div className="panel w-full rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="serif text-[19px] leading-tight">{T('Conectar un sitio a Analíticas', 'Connect a site to Analytics')}</div>
          <p className="mt-1 text-[12.5px] text-ink-3">{T('Para apps que están en tu GitHub y tu hosting (Railway, Vercel…). No hace falta subirlas a Tably ni auditarlas: Tably les instala el script de analíticas y las visitas llegan acá.', 'For apps on your own GitHub and hosting (Railway, Vercel…). No need to upload or audit them: Tably installs the analytics script and visits land here.')}</p>
        </div>
        <button onClick={() => setOpen(false)} className="text-ink-3 hover:text-ink" aria-label={T('Cerrar', 'Close')}><X size={16} /></button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="text-[12px] font-semibold text-ink-2">{T('Nombre', 'Name')}<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Elevum" maxLength={80} className={`${INPUT} mt-1 font-normal`} /></label>
        <label className="text-[12px] font-semibold text-ink-2">{T('Link del sitio', 'Site link')}<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://elevum.com" type="url" autoComplete="off" className={`${INPUT} mt-1 font-normal`} /></label>
        <label className="text-[12px] font-semibold text-ink-2">{T('Repositorio de GitHub (para que Tably abra el PR)', 'GitHub repository (so Tably opens the PR)')}<input value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })} placeholder="https://github.com/usuario/elevum" autoComplete="off" className={`${INPUT} mt-1 font-normal`} /></label>
      </div>
      <div className="mt-4 flex justify-end">
        <button onClick={save} disabled={busy || !f.title.trim() || !(f.url.trim() || f.repo.trim())} className={PRIMARY}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} {T('Conectar', 'Connect')}</button>
      </div>
    </div>
  )
}

function CopyLine({ text }: { text: string }) {
  const T = useT()
  const [ok, setOk] = useState(false)
  const copy = () => { navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500) }).catch(() => {}) }
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11.5px] text-ink-2 scroll-thin">{text}</code>
      <button onClick={copy} className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-3 hover:text-accent">{ok ? <Check size={12} /> : <Copy size={12} />} {ok ? T('Copiado', 'Copied') : T('Copiar', 'Copy')}</button>
    </div>
  )
}

/** How a connected site gets the script: a PR on its GitHub, a command in its folder, or the package. Then «Comprobar». */
export function ExternalSetup({ a, onChange }: { a: AnalyticsApp; onChange: () => void }) {
  const T = useT()
  const x = a.external!
  const [busy, setBusy] = useState<'pr' | 'check' | 'repo' | 'del' | null>(null)
  const [repo, setRepo] = useState('')
  const [way, setWay] = useState<'cmd' | 'pkg' | null>(null)
  const pr = async () => {
    setBusy('pr')
    try {
      const r = await api.sitePr(a.slug)
      toast.ok(tr('Pull request abierto', 'Pull request opened'), tr(`Cambia ${r.files.length} archivo(s). Mergealo y tu hosting lo despliega solo.`, `It changes ${r.files.length} file(s). Merge it and your host deploys it.`))
      onChange()
    } catch (e) { toast.error(tr('No se pudo abrir el PR', 'Could not open the PR'), (e as Error).message); onChange() } finally { setBusy(null) }
  }
  const saveRepo = async () => {
    setBusy('repo')
    try { await api.siteUpdate(a.slug, { repo }); setRepo(''); onChange() } catch (e) { toast.error(tr('No se guardó', 'Not saved'), (e as Error).message) } finally { setBusy(null) }
  }
  const check = async () => {
    setBusy('check')
    try {
      const r = await api.siteCheck(a.slug)
      if (r.connected) toast.ok(tr('Conectado', 'Connected'), tr(`Ya llegaron ${r.hits} visitas o acciones.`, `${r.hits} visits or actions arrived already.`))
      else if (r.online) toast.ok(tr('El script ya está en el sitio', 'The script is on the site'), tr('Falta la primera visita: abrí el sitio y volvé a comprobar.', 'Waiting for the first visit: open the site and check again.'))
      else toast.error(tr('Todavía no llegó nada', 'Nothing arrived yet'), tr('Si ya mergeaste o hiciste push, esperá a que termine el deploy, abrí el sitio y volvé a comprobar.', 'If you already merged or pushed, wait for the deploy to finish, open the site and check again.'))
      onChange()
    } catch (e) { toast.error(tr('No se pudo comprobar', 'Could not check'), (e as Error).message) } finally { setBusy(null) }
  }
  const remove = async () => {
    if (!window.confirm(tr(`¿Desconectar ${a.title}? Se borran sus visitas en Tably.`, `Disconnect ${a.title}? Its visits in Tably are deleted.`))) return
    setBusy('del')
    try { await api.siteDelete(a.slug); onChange() } catch (e) { toast.error(tr('No se pudo desconectar', 'Could not disconnect'), (e as Error).message); setBusy(null) }
  }
  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-accent-soft/30 p-3.5 text-[12.5px] text-ink-2">
      {!a.installed && <div className="font-semibold text-ink">{T('Instalá el script de analíticas en tu sitio (elegí una forma):', 'Install the analytics script on your site (pick one way):')}</div>}
      {!a.installed && <div className="mt-2.5 space-y-3">
        {/* 1 · the PR */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-[min(100%,260px)] flex-1"><b>{T('Que Tably abra un pull request', 'Let Tably open a pull request')}</b> {T('en tu GitHub con el script en tus páginas. Lo mergeás y Railway (o tu hosting) lo despliega solo.', 'on your GitHub with the script in your pages. You merge it and Railway (or your host) deploys it.')}</span>
          {x.pr_url ? <a href={x.pr_url} target="_blank" rel="noreferrer" className={PILL}><GitPullRequest size={13} /> {T('Ver el PR', 'See the PR')} <ExternalLink size={11} /></a> : null}
          {!x.repo ? null : !x.github
            ? <button onClick={() => useArena.getState().set({ view: 'settings' })} className={PRIMARY}><KeyRound size={13} /> {T('Cargar token de GitHub', 'Add GitHub token')}</button>
            : <button onClick={pr} disabled={busy === 'pr'} className={PRIMARY}>{busy === 'pr' ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />} {x.pr_url ? T('Rehacer el PR', 'Redo the PR') : T('Abrir el PR', 'Open the PR')}</button>}
        </div>
        {!x.repo && (
          <div className="flex flex-wrap items-center gap-2">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/usuario/elevum" autoComplete="off" className={`${INPUT} h-9 min-w-[min(100%,260px)] flex-1`} />
            <button onClick={saveRepo} disabled={!repo.trim() || busy === 'repo'} className={PRIMARY}>{busy === 'repo' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {T('Guardar repositorio', 'Save repository')}</button>
          </div>
        )}
        {x.pr_error && <div className="rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-danger">{x.pr_error}</div>}
        {x.pr_url && <div className="text-ink-3">{T('Cuando mergees el PR y termine el deploy, abrí tu sitio y tocá «Comprobar».', 'Once you merge the PR and the deploy finishes, open your site and tap «Check».')}</div>}
        {/* 2 · 3 · by hand */}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setWay(way === 'cmd' ? null : 'cmd')} className={PILL}><Terminal size={13} /> {T('Con un comando', 'With a command')}</button>
          <button onClick={() => setWay(way === 'pkg' ? null : 'pkg')} className={PILL}><Copy size={13} /> {T('Con el paquete o el script', 'With the package or the script')}</button>
        </div>
        {way === 'cmd' && <div>{T('En la carpeta del proyecto corré esto; pone el script en tus páginas (index.html, plantillas o layout de Next.js). Después commit y push.', 'Run this in the project folder; it puts the script in your pages (index.html, templates or the Next.js layout). Then commit and push.')}<CopyLine text={`npx -y ${x.package}`} /></div>}
        {way === 'pkg' && <div className="space-y-2">
          <div>{T('Instalá el paquete (ya trae tu sitio adentro) e importalo una vez en el archivo de entrada (main.ts, main.tsx…):', 'Install the package (your site is already inside) and import it once in your entry file (main.ts, main.tsx…):')}<CopyLine text={`npm i ${x.package}`} /><CopyLine text={"import 'tably-analytics'"} /></div>
          <div>{T('Para ver quién es cada usuario, donde ya sabés quién inició sesión:', 'To see who each user is, wherever you know who signed in:')}<CopyLine text={"import { identify } from 'tably-analytics'; identify({ email, name, id })"} /></div>
          <div>{T('O sin instalar nada, pegá esta línea dentro del <head> de tu página:', 'Or without installing anything, paste this line inside your page <head>:')}<CopyLine text={x.snippet} /></div>
        </div>}
      </div>}
      <div className={`${a.installed ? '' : 'mt-3 border-t border-line pt-3'} flex flex-wrap items-center gap-2`}>
        <span className="min-w-0 flex-1 text-ink-3">{a.installed ? T('Sitio conectado: las visitas llegan desde tu hosting.', 'Site connected: visits arrive from your host.') : T('¿Ya lo instalaste?', 'Installed it already?')}</span>
        {!a.installed && <button onClick={check} disabled={busy === 'check'} className={PRIMARY}>{busy === 'check' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {T('Comprobar', 'Check')}</button>}
        <button onClick={remove} disabled={busy === 'del'} className={PILL}><Trash2 size={13} /> {T('Desconectar', 'Disconnect')}</button>
      </div>
    </div>
  )
}

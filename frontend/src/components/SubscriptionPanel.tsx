import { CheckCircle2, Circle, Copy, KeyRound, Loader2, Smartphone, Terminal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type EngineStatus } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { visibleEngines } from '../lib/flags'
import ProviderLogo, { LogoWatermark } from './ProviderLogo'
import { toast } from './Toast'

/** Per-engine onboarding copy: install → log in with the paid plan → the app verifies. */
const STEPS: Record<string, { plan: string; install: string; login: string; what: string; what_en: string }> = {
  'claude-code': {
    plan: 'Claude Pro / Max',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
    what: 'Se abre el navegador: entrá con la cuenta de claude.ai que tiene el plan. No hace falta API key ni tarjeta.',
    what_en: 'Your browser opens: sign in with the claude.ai account that has the plan. No API key or card needed.',
  },
  'muse-code': {
    plan: 'META_API_KEY · Meta Model API',
    install: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
    login: 'muse login',
    what: 'Con tu META_API_KEY cargada en «Modelos y API keys» no hace falta login: Muse Team corre Muse Code con esa key. `muse login` sirve para usar tu cuenta de Meta en la terminal.',
    what_en: 'With your META_API_KEY loaded in “Models and API keys” there is no login needed: Muse Team runs Muse Code with that key. `muse login` lets you use your Meta account in the terminal.',
  },
  codex: {
    plan: 'ChatGPT Plus / Pro',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    what: 'Se abre el navegador: entrá con tu cuenta de ChatGPT. Si ya estabas logueado con API key, antes corré `codex logout`.',
    what_en: 'Your browser opens: sign in with your ChatGPT account. If you were already logged in with an API key, run `codex logout` first.',
  },
}

function Cmd({ text }: { text: string }) {
  const T = useT()
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text); toast.ok(tr('Copiado', 'Copied'), text) }}
      className="group inline-flex items-center gap-2 rounded-lg bg-[#1E2622] text-[#E6ECE8] px-3 py-1.5 font-mono text-[12.5px] hover:brightness-110"
      title={T('copiar', 'copy')}
    >
      <span className="text-ink-4">$</span> {text} <Copy size={12} className="opacity-50 group-hover:opacity-100" />
    </button>
  )
}

/** "Tu suscripción": connect Claude Code / Codex CLIs so building and review use the paid plan instead of API billing. */
export default function SubscriptionPanel() {
  const T = useT()
  const [engines, setEngines] = useState<EngineStatus[] | null>(null)
  const [watching, setWatching] = useState(false)
  const [tok, setTok] = useState('')
  const [savingTok, setSavingTok] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)  // already connected locally: the server token is an extra, folded away
  const prev = useRef<EngineStatus[] | null>(null)

  const check = async (silent = false) => {
    try {
      const es = await api.engines()
      // diff against the last poll outside the state updater (StrictMode runs updaters twice → duplicate toasts)
      for (const e of es) {
        const was = prev.current?.find((p) => p.id === e.id)
        if (was && !was.ok && e.ok) toast.ok(`${e.label.split(' · ')[0]} ${tr('conectado', 'connected')}`, `${tr('Listo: usa', 'Ready: using')} ${e.auth ?? tr('tu plan', 'your plan')}.`)
      }
      prev.current = es
      setEngines(visibleEngines(es))
    } catch (e) {
      if (!silent) toast.error(tr('No pude consultar los agentes locales', 'Could not check the local agents'), (e as Error).message)
    }
  }
  useEffect(() => { check(true) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // While the user is logging in from the terminal, poll quietly until everything pending is connected (max 3 min).
  useEffect(() => {
    if (!watching) return
    const started = Date.now()
    const id = setInterval(() => {
      check(true)
      if (Date.now() - started > 180_000) setWatching(false)
    }, 4000)
    return () => clearInterval(id)
  }, [watching]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (engines && engines.every((e) => e.ok)) setWatching(false)
  }, [engines])

  if (!engines) return null

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-ink-3">{T('Constructor', 'Builder')}</div>
          <h2 className="text-3xl mt-1">{T('Construir con Muse Code', 'Build with Muse Code')}</h2>
        </div>
      </div>
      <p className="mt-1 w-full text-[13px] text-ink-2">
        {T('Muse Code es el agente oficial de Meta: con tu key puede', 'Muse Code is the official Meta agent: with your key it can')} <b>{T('construir y revisar', 'build and review')}</b> {T('el producto. La app solo le pasa el brief y lee los archivos que escribe.', 'the product. The app only hands it the brief and reads the files it writes.')}
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {engines.map((e) => {
          const s = STEPS[e.id]
          const name = e.label.split(' · ')[0]
          return (
            <div key={e.id} className={`panel relative overflow-hidden rounded-2xl p-5 ${e.ok ? 'border-ok/40' : ''}`}>
              <LogoWatermark provider={e.logo} />
              <div className="relative flex items-center gap-3">
                <ProviderLogo provider={e.logo} size={30} />
                <div className="min-w-0">
                  <div className="font-semibold text-lg leading-tight">{name}</div>
                  <div className="text-[12px] text-ink-3">{T('usa', 'uses')} {s?.plan ?? e.label}{e.version ? ` · ${e.version}` : ''}</div>
                </div>
                <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-bold ${e.ok ? 'bg-ok/15 text-ok' : e.installed ? 'bg-gold/15 text-gold' : 'bg-surface-2 text-ink-3'}`}>
                  {e.ok ? T('conectado', 'connected') : e.installed ? T('falta login', 'login needed') : T('no instalado', 'not installed')}
                </span>
              </div>

              {e.id === 'claude-code' && e.ok && !e.token_set && !remoteOpen && (
                <button onClick={() => setRemoteOpen(true)} className="relative mt-4 flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3.5 py-2.5 text-left text-[12.5px] text-ink-3 transition hover:border-accent hover:text-accent">
                  <Smartphone size={14} /> <span><b className="font-semibold">{T('Opcional', 'Optional')}:</b> {T('usala desde cualquier lado, con la PC apagada', 'use it from anywhere, with your PC off')}</span> <span className="ml-auto text-[12px] underline-offset-2 hover:underline">{T('Configurar', 'Set up')}</span>
                </button>
              )}
              {e.id === 'claude-code' && (!e.ok || e.token_set || remoteOpen) && (
                <div className={`relative mt-4 rounded-xl border px-3.5 py-3 ${e.token_set ? 'border-ok/30 bg-ok/5' : 'border-accent/30 bg-accent-soft/40'}`}>
                  <div className="flex items-center gap-2 text-[13px] font-semibold"><Smartphone size={14} className="text-accent" /> {T('Usala desde cualquier lado, con la PC apagada', 'Use it from anywhere, PC off')}{e.ok && !e.token_set && <span className="ml-auto text-[11px] font-normal text-ink-4">{T('opcional', 'optional')}</span>}</div>
                  <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{T('Conectá tu suscripción con un token: así Muse Team corre Claude Code en su servidor como vos, y podés construir y chatear con tus sesiones desde el celular aunque tu computadora esté apagada.', 'Connect your subscription with a token: Muse Team then runs Claude Code on its server as you, so you can build and chat with your sessions from your phone even with your computer off.')}</p>
                  {e.token_set ? (
                    <div className="mt-2 flex items-center gap-2 text-[12.5px]"><CheckCircle2 size={15} className="text-ok" /> {T('Token guardado (cifrado). Las construcciones y «Mis sesiones» corren con tu suscripción.', 'Token saved (encrypted). Builds and "My sessions" run on your subscription.')}
                      <button onClick={async () => { await api.saveClaudeToken(null, true); toast.ok(tr('Token borrado', 'Token deleted'), ''); check(true) }} className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-danger"><Trash2 size={12} /> {T('Borrar', 'Delete')}</button>
                    </div>
                  ) : (
                    <>
                      <ol className="mt-2 space-y-1.5 text-[12.5px] text-ink-2">
                        <li>1. {T('En tu computadora, con Claude Code logueado, corré', 'On your computer, with Claude Code logged in, run')} <Cmd text="claude setup-token" /></li>
                        <li>2. {T('Copiá el token que imprime (empieza con', 'Copy the token it prints (starts with')} <code className="font-mono">sk-ant-oat…</code>) {T('y pegalo acá.', 'and paste it here.')}</li>
                      </ol>
                      <div className="mt-2 flex gap-2">
                        <input type="password" autoComplete="off" value={tok} onChange={(ev) => setTok(ev.target.value)} placeholder="sk-ant-oat01-…" className="h-9 flex-1 rounded-xl border border-line bg-paper px-3 font-mono text-[12.5px] outline-none focus:border-accent" />
                        <button disabled={!tok.trim() || savingTok} onClick={async () => { setSavingTok(true); try { await api.saveClaudeToken(tok.trim()); setTok(''); toast.ok(tr('Suscripción conectada', 'Subscription connected'), tr('Claude Code corre con tu cuenta en este servidor.', 'Claude Code runs with your account on this server.')); check(true) } catch (err) { toast.error(tr('No se pudo guardar', 'Could not save'), (err as Error).message) } finally { setSavingTok(false) } }} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">{savingTok ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {T('Conectar', 'Connect')}</button>
                      </div>
                      <div className="mt-1.5 text-[11px] text-ink-4">{T('El token es personal y de tu plan; se guarda cifrado y solo se usa para correr Claude Code como vos.', 'The token is personal to your plan; it is stored encrypted and only used to run Claude Code as you.')}</div>
                    </>
                  )}
                </div>
              )}
              {e.ok ? (
                <div className="relative mt-4 flex items-center gap-2 rounded-xl border border-ok/30 bg-ok/5 px-3 py-2.5 text-[13px]">
                  <CheckCircle2 size={16} className="text-ok shrink-0" />
                  <div>
                    <b>{T('Listo.', 'Ready.')}</b> {T('Sesión activa', 'Active session')}{e.auth ? `: ${e.auth}` : ''}. {T('Al construir elegí «', 'When building, pick «')}{e.label}{T('» como constructor; la revisión pre-prod también puede usarlo.', '» as the builder; the pre-prod review can use it too.')}
                    {e.hint && <div className="mt-1 text-gold">{e.hint}</div>}
                  </div>
                </div>
              ) : (
                <ol className="relative mt-4 space-y-3 text-[13px]">
                  <li className="flex gap-2.5">
                    {e.installed ? <CheckCircle2 size={16} className="text-ok shrink-0 mt-0.5" /> : <Circle size={16} className="text-ink-4 shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <div className={e.installed ? 'text-ink-3 line-through' : 'font-medium'}>{T('Instalá el agente en esta máquina', 'Install the agent on this machine')}</div>
                      {!e.installed && s && <div className="mt-1.5"><Cmd text={s.install} /></div>}
                    </div>
                  </li>
                  <li className="flex gap-2.5">
                    <Circle size={16} className={`shrink-0 mt-0.5 ${e.installed ? 'text-accent' : 'text-ink-4'}`} />
                    <div className="min-w-0">
                      <div className="font-medium">{T('Iniciá sesión con tu plan desde la terminal', 'Sign in with your plan from the terminal')}</div>
                      {s && (
                        <>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2"><Terminal size={13} className="text-ink-3" /><Cmd text={s.login} /></div>
                          <div className="mt-1 text-[12px] text-ink-3">{T(s.what, s.what_en)}</div>
                        </>
                      )}
                    </div>
                  </li>
                  <li className="flex gap-2.5">
                    <Circle size={16} className="text-ink-4 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="font-medium">{T('Volvé acá: la app lo detecta sola', 'Come back here: the app detects it on its own')}</div>
                      <button
                        onClick={() => { setWatching(true); check() }}
                        className={`mt-1.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold ${watching ? 'bg-accent-soft text-accent border border-accent/40' : 'bg-accent text-white'}`}
                      >
                        {watching ? <><Loader2 size={13} className="animate-spin" /> {T('Esperando tu login…', 'Waiting for your login…')}</> : T('Ya me logueé, verificar', 'I logged in, verify')}
                      </button>
                    </div>
                  </li>
                </ol>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

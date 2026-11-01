import { motion } from 'framer-motion'
import { Eye, EyeOff, MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, auth, type User } from '../lib/api'
import TeamBackdrop from './TeamBackdrop'
import { useT } from '../lib/i18n'
import LangSwitch from './LangSwitch'
import ThemeSwitch from './ThemeSwitch'
import { MuseBadge } from './Landing'
import { MadeWith } from './Landing'

export default function Login({ onAuthed, onBack, initialMode = 'login' }: { onAuthed: (u: User) => void; onBack: () => void; initialMode?: 'login' | 'register' }) {
  const T = useT()
  const [mode, setMode] = useState<'login' | 'register'>(initialMode)
  const [allowSignup, setAllowSignup] = useState(true)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [password2, setPassword2] = useState('')
  // email verification: after sign-up (or a sign-in on an unverified account) a 6-digit code goes to the inbox
  const [verify, setVerify] = useState<{ email: string; devCode?: string } | null>(null)
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)

  useEffect(() => {
    api.authConfig().then((c) => setAllowSignup(c.allow_signup)).catch(() => {})
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    if (mode === 'register' && password !== password2) {
      setError(T('Las contraseñas no coinciden', 'The passwords do not match'))
      setBusy(false)
      return
    }
    try {
      if (mode === 'login') {
        const r = await api.login(email, password)
        auth.set(r.token)
        onAuthed(r.user)
      } else {
        const r = await api.register(email, password, name || undefined)
        if (r.pending || !r.token) {
          setVerify({ email: r.email ?? email, devCode: r.dev_code })
          setCode('')
        } else {
          auth.set(r.token)
          onAuthed(r.user)
        }
      }
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('email_unverified')) {
        // the account exists but the inbox was never confirmed: send a fresh code and ask for it
        try {
          const r = await api.resendCode(email)
          setVerify({ email: email.trim().toLowerCase(), devCode: r.dev_code })
          setCode('')
        } catch (e2) {
          setError((e2 as Error).message)
        }
      } else setError(msg.includes('at least 8') ? T('La contraseña debe tener al menos 8 caracteres', 'The password must be at least 8 characters') : msg)
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!verify) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.verifyEmail(verify.email, code)
      auth.set(r.token)
      onAuthed(r.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    if (!verify) return
    setError(null)
    try {
      const r = await api.resendCode(verify.email)
      setVerify({ ...verify, devCode: r.dev_code })
      setResent(true)
      setTimeout(() => setResent(false), 4000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const input = 'w-full rounded-xl bg-surface border border-line px-4 py-3 text-[15px] outline-none focus:border-accent transition'

  return (
    <div className="relative h-full arena-bg flex flex-col overflow-hidden">
      <div className="hidden md:contents"><TeamBackdrop blur={9} opacity={0.5} /></div>
      <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-paper px-4 sm:gap-3 sm:bg-paper/80 sm:px-6 sm:backdrop-blur">
        <button type="button" onClick={onBack} className="flex items-center gap-3 rounded-lg transition hover:opacity-80" title={T('Volver a la presentación', 'Back to the intro')}>
          <img src="/icon.svg" alt="" aria-hidden className="h-7 w-7 rounded-lg shadow-sm" draggable={false} />
          <span className="serif text-lg max-[380px]:hidden">Tably <em className="text-accent">Team</em></span>
        </button>
        <ThemeSwitch className="ml-auto h-8" auto={false} />
        <LangSwitch />
      </header>
      <div className="relative z-10 flex flex-1 min-h-0 flex-col overflow-y-auto px-4 py-6 sm:p-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="m-auto grid w-full max-w-6xl items-center gap-8 md:grid-cols-[1fr_1.15fr] md:gap-12">
        <div>
          <div className="text-xs uppercase tracking-[0.5em] text-accent">{T('tu equipo que diseña y construye', 'your team that designs and builds')}</div>
          <h1 className="mt-2 text-5xl tracking-tight sm:text-6xl md:text-7xl">
            Tably <em className="text-accent">Team</em>
          </h1>
          <MuseBadge big className="mt-4" />
          <p className="mt-4 text-ink-2 text-lg leading-relaxed max-w-md">
            {T('Escribí tu idea y Muse, el modelo de Meta, ocupa cada rol: el equipo la debate, la diseña, la construye y la revisa. Vos aprobás cada paso.', 'Write your idea and Muse, Meta\'s model, takes every role: the team debates it, designs it, builds it and reviews it. You approve every step.')}
          </p>
        </div>

        {verify ? (
          <form onSubmit={submitCode} className="panel w-full rounded-3xl p-6 sm:p-9">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent"><MailCheck size={22} /></div>
            <h2 className="mt-5 text-3xl">{T('Verificá tu email', 'Verify your email')}</h2>
            <p className="mt-1 text-sm text-ink-3">{T('Te mandamos un código de 6 dígitos a', 'We sent a 6-digit code to')} <b className="text-ink">{verify.email}</b>. {T('Vence en 15 minutos.', 'It expires in 15 minutes.')}</p>
            {verify.devCode && <div className="mt-3 rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-[12.5px] text-ink-2">{T('Modo local sin servidor de correo: tu código es', 'Local mode without a mail server: your code is')} <b className="font-mono">{verify.devCode}</b></div>}
            <input
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className={`${input} mt-5 text-center font-mono text-[28px] tracking-[0.5em]`}
            />
            {error && <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
            <button disabled={busy || code.length < 6} className="mt-5 w-full rounded-xl bg-accent text-white py-3 font-semibold hover:brightness-110 transition disabled:opacity-50">{busy ? '…' : T('Verificar y entrar', 'Verify and enter')}</button>
            <div className="mt-4 flex items-center justify-between text-sm">
              <button type="button" onClick={resend} className="text-accent hover:underline">{resent ? T('Código reenviado ✓', 'Code resent ✓') : T('Reenviar código', 'Resend code')}</button>
              <button type="button" onClick={() => { setVerify(null); setMode('login') }} className="text-ink-3 hover:text-ink">{T('Usar otra cuenta', 'Use another account')}</button>
            </div>
          </form>
        ) : (
        <form onSubmit={submit} className="panel w-full rounded-3xl p-6 sm:p-9">
          <div className="flex gap-1 rounded-xl bg-surface-2 p-1 text-sm">
            <button type="button" onClick={() => setMode('login')} className={`flex-1 rounded-lg py-2 transition ${mode === 'login' ? 'bg-surface shadow-sm font-medium' : 'text-ink-3'}`}>{T('Iniciar sesión', 'Sign in')}</button>
            {allowSignup && (
              <button type="button" onClick={() => setMode('register')} className={`flex-1 rounded-lg py-2 transition ${mode === 'register' ? 'bg-surface shadow-sm font-medium' : 'text-ink-3'}`}>{T('Crear cuenta', 'Create account')}</button>
            )}
          </div>
          <h2 className="mt-6 text-3xl">{mode === 'login' ? T('Bienvenido de vuelta', 'Welcome back') : T('Armá tu equipo', 'Build your team')}</h2>
          <p className="mt-1 text-sm text-ink-3">{mode === 'login' ? T('Tus proyectos y tu equipo te esperan.', 'Your projects and your team are waiting.') : T('Tu cuenta guarda tus proyectos, tu equipo de IAs y tus API keys, cifradas y solo tuyas.', 'Your account keeps your projects, your AI team and your API keys, encrypted and yours alone.')}</p>
          <div className="mt-5 space-y-3">
            {mode === 'register' && <input className={input} placeholder={T('Nombre', 'Name')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
            <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <div className="relative">
              <input className={`${input} pr-12`} type={showPw ? 'text' : 'password'} placeholder={T('Contraseña (8 o más)', 'Password (8 or more)')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} />
              <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-3 hover:text-ink" title={showPw ? T('Ocultar contraseña', 'Hide password') : T('Ver contraseña', 'Show password')} aria-label={showPw ? T('Ocultar contraseña', 'Hide password') : T('Ver contraseña', 'Show password')}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {mode === 'register' && (
              <div className="relative">
                <input className={`${input} pr-12`} type={showPw ? 'text' : 'password'} placeholder={T('Repetí la contraseña', 'Repeat the password')} value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required minLength={8} />
                {password2.length > 0 && (
                  <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-semibold ${password2 === password ? 'text-ok' : 'text-danger'}`}>{password2 === password ? '✓' : T('no coincide', 'no match')}</span>
                )}
              </div>
            )}
          </div>
          {error && <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
          <button disabled={busy} className="mt-5 w-full rounded-xl bg-accent text-white py-3 font-semibold hover:brightness-110 transition disabled:opacity-50">
            {busy ? '…' : mode === 'login' ? T('Entrar', 'Enter') : T('Crear cuenta', 'Create account')}
          </button>
        </form>
        )}
      </motion.div>
      </div>
      <MadeWith />
    </div>
  )
}

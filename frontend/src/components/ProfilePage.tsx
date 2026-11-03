import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api, type Profile } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { removeMyPhoto, saveMyPhoto, useMyPhoto } from '../lib/myPhoto'
import { adConsent, setAdConsent } from '../lib/tracking'
import { useArena } from '../store'
import { toast } from './Toast'

const input = 'mt-1.5 w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[14px] outline-none transition focus:border-accent'
const label = 'block text-[12.5px] font-medium text-ink-2'
const primary = 'flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[14px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40'
const plain = 'flex h-10 items-center justify-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[13.5px] transition hover:border-accent hover:text-accent disabled:opacity-40'
const fail = (e: unknown) => toast.error(tr('No se pudo guardar', 'Could not save'), (e as Error).message)

/** The person's own account: photo, name, phone, email (proved with a code) and password. */
export default function ProfilePage({ onDeleted }: { onDeleted: () => void }) {
  const T = useT()
  const [p, setP] = useState<Profile | null>(null)
  useEffect(() => { api.profile().then(setP).catch(fail) }, [])
  const update = (next: Profile) => {
    setP(next)
    const user = useArena.getState().user
    if (user) useArena.getState().set({ user: { ...user, name: next.name, email: next.email } })
  }
  return (
    <div className="w-full px-4 pb-16 pt-6 sm:px-8">
      <div className="text-[11px] uppercase tracking-[0.3em] text-accent">{T('Tu cuenta', 'Your account')}</div>
      <h1 className="serif mt-1 text-[30px] leading-tight">{T('Mi perfil', 'My profile')}</h1>
      {!p ? <div className="mt-8 text-[13px] text-ink-3">{T('Cargando…', 'Loading…')}</div> : (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
          <Photo name={p.name} />
          <Details p={p} onSaved={update} />
          <Email p={p} onChanged={update} />
          <Password />
          <AdCookies />
          <DeleteAccount onDeleted={onDeleted} />
        </div>
      )}
    </div>
  )
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="panel rounded-xl p-5">
      <h2 className="font-sans text-[15px] font-semibold">{title}</h2>
      {sub && <p className="mt-0.5 text-[12.5px] text-ink-3">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Photo({ name }: { name: string }) {
  const T = useT()
  const url = useMyPhoto((s) => s.url)
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true)
    await job().catch(fail)
    setBusy(false)
  }
  return (
    <Section title={T('Foto', 'Photo')}>
      <div className="flex flex-wrap items-center gap-4">
        {url ? <img src={url} alt="" className="h-16 w-16 rounded-full object-cover" /> : <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-[24px] font-semibold uppercase text-white">{name.slice(0, 1)}</span>}
        <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) run(() => saveMyPhoto(f)) }} />
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className={plain}>{busy ? '…' : url ? T('Cambiar foto', 'Change photo') : T('Subir foto', 'Upload photo')}</button>
        {url && <button type="button" disabled={busy} onClick={() => run(removeMyPhoto)} className={plain}>{T('Quitar', 'Remove')}</button>}
      </div>
    </Section>
  )
}

function Details({ p, onSaved }: { p: Profile; onSaved: (next: Profile) => void }) {
  const T = useT()
  const [name, setName] = useState(p.name)
  const [phone, setPhone] = useState(p.phone)
  const [busy, setBusy] = useState(false)
  const changed = name.trim() !== p.name || phone.trim() !== p.phone
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      onSaved(await api.profileUpdate({ name, phone }))
      toast.ok(tr('Datos guardados', 'Details saved'))
    } catch (err) {
      fail(err)
    }
    setBusy(false)
  }
  return (
    <Section title={T('Tus datos', 'Your details')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className={label}>{T('Nombre', 'Name')}<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} className={input} /></label>
        <label className={label}>{T('Teléfono', 'Phone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" placeholder="+54 9 11 5555 5555" className={input} /></label>
        <div className="sm:col-span-2"><button disabled={busy || !changed || !name.trim()} className={primary}>{busy ? '…' : T('Guardar', 'Save')}</button></div>
      </form>
    </Section>
  )
}

function Email({ p, onChanged }: { p: Profile; onChanged: (next: Profile) => void }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    try {
      await job()
    } catch (err) {
      fail(err)
    }
    setBusy(false)
  }
  const start = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const r = await api.emailChangeStart(email, password)
      setDevCode(r.dev_code ?? null)
      setPassword('')
      onChanged({ ...p, pending_email: email.trim().toLowerCase() })
      setOpen(false)
    })
  }
  const confirm = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      onChanged(await api.emailChangeConfirm(code))
      setCode('')
      setEmail('')
      setDevCode(null)
      toast.ok(tr('Email cambiado', 'Email changed'), tr('Cerramos las sesiones abiertas en otros dispositivos.', 'Sessions on other devices were closed.'))
    })
  }
  const cancel = () => run(async () => {
    await api.emailChangeCancel()
    setCode('')
    setDevCode(null)
    onChanged({ ...p, pending_email: null })
  })
  return (
    <Section title="Email" sub={T('Con este email entrás a tu cuenta y te escribimos.', 'You sign in with this email and we write to you here.')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 break-all text-[14px] font-medium">{p.email}</div>
        {!p.pending_email && !open && <button type="button" onClick={() => setOpen(true)} className={plain}>{T('Cambiar email', 'Change email')}</button>}
      </div>
      {open && !p.pending_email && (
        <form onSubmit={start} className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className={label}>{T('Email nuevo', 'New email')}<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="email" className={input} /></label>
          <label className={label}>{T('Tu contraseña actual', 'Your current password')}<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required autoComplete="current-password" className={input} /></label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button disabled={busy || !email || !password} className={primary}>{busy ? '…' : T('Mandarme el código', 'Send me the code')}</button>
            <button type="button" onClick={() => setOpen(false)} className={plain}>{T('Cancelar', 'Cancel')}</button>
          </div>
        </form>
      )}
      {p.pending_email && (
        <form onSubmit={confirm} className="mt-4 rounded-xl border border-line bg-paper p-4">
          <p className="text-[13px] text-ink-2">{T('Te mandamos un código a', 'We sent a code to')} <b className="break-all">{p.pending_email}</b>. {T('Tu email no cambia hasta que lo escribas acá.', 'Your email does not change until you enter it here.')}</p>
          {devCode && <p className="mt-2 font-mono text-[12.5px] text-ink-3">{T('Sin servicio de email, tu código es', 'No email service, your code is')} {devCode}</p>}
          <label className={`${label} mt-3`}>{T('Código', 'Code')}<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className={`${input} max-w-[180px] bg-surface font-mono tracking-[0.2em]`} /></label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={busy || code.replace(/\D/g, '').length !== 6} className={primary}>{busy ? '…' : T('Confirmar', 'Confirm')}</button>
            <button type="button" disabled={busy} onClick={cancel} className={plain}>{T('Cancelar el cambio', 'Cancel the change')}</button>
          </div>
        </form>
      )}
    </Section>
  )
}

function Password() {
  const T = useT()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.passwordChange(current, next)
      setCurrent('')
      setNext('')
      toast.ok(tr('Contraseña cambiada', 'Password changed'), tr('Cerramos las sesiones abiertas en otros dispositivos.', 'Sessions on other devices were closed.'))
    } catch (err) {
      fail(err)
    }
    setBusy(false)
  }
  return (
    <Section title={T('Contraseña', 'Password')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className={label}>{T('Contraseña actual', 'Current password')}<input value={current} onChange={(e) => setCurrent(e.target.value)} type="password" autoComplete="current-password" className={input} /></label>
        <label className={label}>{T('Contraseña nueva', 'New password')}<input value={next} onChange={(e) => setNext(e.target.value)} type="password" autoComplete="new-password" minLength={8} className={input} /></label>
        <div className="sm:col-span-2"><button disabled={busy || !current || next.length < 8} className={primary}>{busy ? '…' : T('Cambiar contraseña', 'Change password')}</button></div>
      </form>
    </Section>
  )
}

function AdCookies() {
  const T = useT()
  const [consent, setConsent] = useState(adConsent())
  const choose = (value: 'yes' | 'no') => { setConsent(value); setAdConsent(value) }
  return (
    <div className="lg:col-span-2">
      <Section title={T('Cookies de publicidad', 'Advertising cookies')} sub={T('Nos sirven para medir nuestros anuncios en Meta. Podés cambiar tu elección cuando quieras.', 'They help us measure our ads on Meta. You can change your choice at any time.')}>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={consent === 'yes'} onClick={() => choose('yes')} className={consent === 'yes' ? primary : plain}>{T('Aceptadas', 'Accepted')}</button>
          <button type="button" aria-pressed={consent === 'no'} onClick={() => choose('no')} className={consent === 'no' ? primary : plain}>{T('Rechazadas', 'Declined')}</button>
        </div>
      </Section>
    </div>
  )
}

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const T = useT()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [right, setRight] = useState<boolean | null>(null)  // null: nothing to say yet
  useEffect(() => {  // asks a moment after the typing stops; only the latest answer counts
    setRight(null)
    if (!password) return
    let stale = false
    const t = setTimeout(() => { api.accountCheckPassword(password).then((r) => { if (!stale) setRight(r.ok) }).catch(() => {}) }, 500)
    return () => { stale = true; clearTimeout(t) }
  }, [password])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!right) return
    setBusy(true)
    try {
      await api.accountDelete(password)
      onDeleted()
    } catch (err) {
      toast.error(tr('No se pudo eliminar la cuenta', 'Could not delete the account'), (err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="lg:col-span-2">
      <Section title={T('Eliminar mi cuenta', 'Delete my account')} sub={T('Borra para siempre tus proyectos, tus claves, tus cuentas conectadas y tus datos, y baja las apps que publicaste con Tably. No se puede deshacer. Si querés guardar algo, exportalo antes.', 'Permanently deletes your projects, keys, connected accounts and data, and takes down the apps you published with Tably. It cannot be undone. If you want to keep anything, export it first.')}>
        {!open ? <button type="button" onClick={() => setOpen(true)} className={`${plain} hover:!border-danger hover:!text-danger`}>{T('Eliminar mi cuenta', 'Delete my account')}</button> : (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <label className={`${label} min-w-[260px]`}>{T('Tu contraseña, para confirmar', 'Your password, to confirm')}<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" className={input} /></label>
            <button disabled={busy || !right} className="flex h-10 items-center justify-center rounded-full bg-danger px-5 text-[14px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40">{busy ? '…' : T('Eliminar definitivamente', 'Delete permanently')}</button>
            <button type="button" onClick={() => { setOpen(false); setPassword('') }} className={plain}>{T('Cancelar', 'Cancel')}</button>
            {right === false && <p className="w-full text-[12.5px] text-danger">{T('La contraseña no es correcta.', 'The password is not correct.')}</p>}
          </form>
        )}
      </Section>
    </div>
  )
}

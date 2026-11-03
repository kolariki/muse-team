import { useEffect, useState } from 'react'
import { useLang, useT } from '../lib/i18n'
import { adConsent, onOurSite, setAdConsent, startTracking } from '../lib/tracking'
import LegalModal from './LegalModal'

/** Asks once whether advertising cookies may run. Until the person answers yes, nothing of Meta's loads. */
export default function CookieNotice() {
  useLang()
  const T = useT()
  const [open, setOpen] = useState(onOurSite() && adConsent() === null)
  const [legal, setLegal] = useState(false)
  useEffect(() => { startTracking() }, [])
  useEffect(() => {
    const sync = () => setOpen(onOurSite() && adConsent() === null)
    window.addEventListener('tably-consent', sync)
    return () => window.removeEventListener('tably-consent', sync)
  }, [])
  return (
    <>
      {open && (
        <div role="dialog" aria-label={T('Cookies', 'Cookies')} className="panel fixed inset-x-3 bottom-3 z-[90] flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl p-4 sm:inset-x-auto sm:right-4 sm:max-w-[520px]">
          <p className="min-w-0 flex-1 basis-[280px] text-[13px] leading-snug text-ink-2">
            {T('Usamos cookies de Meta para medir nuestros anuncios. Las necesarias para que la plataforma funcione están siempre activas.', 'We use Meta cookies to measure our ads. The ones the platform needs to work are always on.')}{' '}
            <button type="button" onClick={() => setLegal(true)} className="text-accent underline underline-offset-2">{T('Privacidad', 'Privacy')}</button>
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => setAdConsent('no')} className="h-9 rounded-full border border-line bg-surface px-4 text-[13px] font-medium transition hover:border-accent hover:text-accent">{T('Rechazar', 'Decline')}</button>
            <button type="button" onClick={() => setAdConsent('yes')} className="h-9 rounded-full bg-accent px-4 text-[13px] font-semibold text-white transition hover:brightness-110">{T('Aceptar', 'Accept')}</button>
          </div>
        </div>
      )}
      {legal && <LegalModal doc="privacy" onClose={() => setLegal(false)} />}
    </>
  )
}

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../lib/i18n'

export type LegalDoc = 'terms' | 'privacy'

/** The terms or the privacy policy, read without leaving the signup. The server keeps the only copy of the text. */
export default function LegalModal({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  const T = useT()
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const path = doc === 'terms' ? 'terminos' : 'privacidad'
  useEffect(() => {
    fetch(`/api/content/legal/${path}`).then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => setHtml(d.html)).catch(() => setFailed(true))
  }, [path])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
        {html !== null ? <div className="md min-h-0 flex-1 overflow-y-auto scroll-thin px-5 py-5 sm:px-8 sm:py-7 [&_h2]:mt-5" dangerouslySetInnerHTML={{ __html: html }} /> : (
          <div className="px-6 py-8 text-[14px] text-ink-2">
            {failed ? <>{T('No se pudo cargar. Abrilo en', 'Could not load it. Open it at')} <a href={`/${path}`} target="_blank" rel="noreferrer" className="text-accent underline">/{path}</a></> : T('Cargando…', 'Loading…')}
          </div>
        )}
        <div className="flex justify-end border-t border-line p-3">
          <button type="button" autoFocus onClick={onClose} className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white transition hover:brightness-110">{T('Cerrar', 'Close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

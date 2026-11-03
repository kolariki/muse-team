import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { tr, useT } from '../lib/i18n'
import { isStaleBuildError, reloadForNewBuild } from '../lib/staleBuild'

/* ------------------------------------------------------------------ toasts */
export interface Toast {
  id: number
  kind: 'ok' | 'error' | 'info'
  title: string
  text?: string
  action?: { label: string; onClick: () => void }
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

let seq = 1
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = seq++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 9000 : 6000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

export const toast = {
  ok: (title: string, text?: string, action?: Toast['action']) => useToasts.getState().push({ kind: 'ok', title, text, action }),
  error: (title: string, text?: string) => useToasts.getState().push({ kind: 'error', title, text }),
  info: (title: string, text?: string, action?: Toast['action']) => useToasts.getState().push({ kind: 'info', title, text, action }),
}

/** Browser notification when the tab is in the background (long jobs: builds, reviews, deploys). */
export function notify(title: string, body?: string) {
  try {
    if (!('Notification' in window) || document.visibilityState === 'visible') return
    if (Notification.permission === 'granted') new Notification(title, { body, icon: '/logos/anthropic.png' })
  } catch {
    /* unsupported */
  }
}

export function requestNotifications() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  } catch {
    /* unsupported */
  }
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-32px)] pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            className={`pointer-events-auto panel rounded-2xl px-4 py-3 flex gap-3 border-l-4 ${t.kind === 'ok' ? 'border-l-ok' : t.kind === 'error' ? 'border-l-danger' : 'border-l-accent'}`}
          >
            <span className="mt-0.5 shrink-0">{t.kind === 'ok' ? <CheckCircle2 size={18} className="text-ok" /> : t.kind === 'error' ? <AlertTriangle size={18} className="text-danger" /> : <Info size={18} className="text-accent" />}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-[14px] leading-tight">{t.title}</div>
              {t.text && <div className="mt-0.5 text-[12.5px] text-ink-2 break-words">{t.text}</div>}
              {t.action && <button onClick={() => { t.action!.onClick(); dismiss(t.id) }} className="mt-1.5 text-[12.5px] font-semibold text-accent hover:underline">{t.action.label} →</button>}
            </div>
            <button onClick={() => dismiss(t.id)} className="shrink-0 text-ink-4 hover:text-ink"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ error boundary */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('UI crash', error)
    if (isStaleBuildError(error)) reloadForNewBuild()
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="h-full arena-bg flex items-center justify-center p-6">
        <div className="panel rounded-3xl p-8 max-w-lg text-center">
          <AlertTriangle className="mx-auto text-danger" size={34} />
          <h2 className="mt-3 text-3xl">{tr('Algo se rompió en la pantalla', 'Something broke on this screen')}</h2>
          <p className="mt-2 text-sm text-ink-2">{tr('Tus datos están guardados en el servidor; podés volver al inicio sin perder nada.', 'Your data is saved on the server; you can go back home without losing anything.')}</p>
          <pre className="mt-3 text-left text-[11px] font-mono text-ink-3 bg-surface-2 rounded-lg p-3 overflow-auto max-h-32">{String(this.state.error?.message ?? this.state.error)}</pre>
          <button onClick={() => { this.setState({ error: null }); this.props.onReset?.() }} className="mt-4 rounded-xl bg-accent text-white px-5 py-2.5 font-semibold">{tr('Volver al inicio', 'Back to home')}</button>
        </div>
      </div>
    )
  }
}

/** Tiny hook for confirm dialogs without window.confirm styling issues. */
/** In-app text prompt (replaces window.prompt): title, hint, an input, cancel / confirm. Resolves null when cancelled. */
export function usePrompt() {
  const T = useT()
  const [req, setReq] = useState<{ title: string; hint?: string; value: string; confirm: string; resolve: (v: string | null) => void } | null>(null)
  const prompt = (title: string, initial = '', opts: { hint?: string; confirm?: string } = {}) =>
    new Promise<string | null>((resolve) => setReq({ title, hint: opts.hint, value: initial, confirm: opts.confirm ?? T('Guardar', 'Save'), resolve }))
  const close = (v: string | null) => { req?.resolve(v); setReq(null) }
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])
  const dialog = req ? (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-paper/70 p-4 backdrop-blur-sm" onClick={() => close(null)}>
      <form className="panel w-full max-w-md rounded-2xl p-6" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (req.value.trim()) close(req.value.trim()) }}>
        <div className="text-[15px] font-semibold text-ink">{req.title}</div>
        {req.hint && <div className="mt-1 text-[12.5px] text-ink-3">{req.hint}</div>}
        <input
          autoFocus
          value={req.value}
          onChange={(e) => setReq({ ...req, value: e.target.value })}
          onFocus={(e) => e.target.select()}
          className="mt-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => close(null)} className="rounded-lg border border-line px-3 py-1.5 text-sm">{T('Cancelar', 'Cancel')}</button>
          <button type="submit" disabled={!req.value.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">{req.confirm}</button>
        </div>
      </form>
    </div>
  ) : null
  return { prompt, dialog }
}

export function useConfirm() {
  const T = useT()
  const [req, setReq] = useState<{ text: string; resolve: (ok: boolean) => void } | null>(null)
  const confirm = (text: string) => new Promise<boolean>((resolve) => setReq({ text, resolve }))
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (req.resolve(false), setReq(null))
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req])
  const dialog = req ? (
    <div className="fixed inset-0 z-[150] bg-paper/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => { req.resolve(false); setReq(null) }}>
      <div className="panel rounded-2xl p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="text-[15px]">{req.text}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => { req.resolve(false); setReq(null) }} className="rounded-lg border border-line px-3 py-1.5 text-sm">{T('Cancelar', 'Cancel')}</button>
          <button onClick={() => { req.resolve(true); setReq(null) }} className="rounded-lg bg-danger text-white px-3 py-1.5 text-sm font-semibold">{T('Confirmar', 'Confirm')}</button>
        </div>
      </div>
    </div>
  ) : null
  return { confirm, dialog }
}

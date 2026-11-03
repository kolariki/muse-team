import { api, type FdeRequest, type StripeStatus } from './api'
import { tr } from './i18n'
import { downloadBlob } from './recorder'

const DONE = ['paid', 'delivered', 'closed']

export const fdeStatus = (): Record<string, string> => ({
  pending_payment: tr('falta pagar', 'payment pending'),
  new: tr('recibido', 'received'),
  paid: tr('pagado', 'paid'),
  scheduled: tr('agendado', 'scheduled'),
  in_progress: tr('en curso', 'in progress'),
  delivered: tr('entregado', 'delivered'),
  closed: tr('cerrado', 'closed'),
  cancelled: tr('cancelado', 'cancelled'),
})

/** What a package's price is per; the fixed-price ones have no unit. */
export const fdeUnit = (pkg: string) => (pkg === 'hours' ? '/h' : pkg === 'service_setup' ? tr('/servicio', '/service') : '')

export const fdeAwaitsPayment = (status: string) => status === 'pending_payment' || status === 'new'

export const fdeStatusIsDone = (status: string) => DONE.includes(status)

export const fdeStatusTone = (status: string) => (DONE.includes(status) ? 'border-ok/30 bg-ok/10 text-ok' : status === 'cancelled' ? 'border-line bg-surface-2 text-ink-3' : 'border-gold/40 bg-gold/10 text-gold')

export const downloadFdeTicket = async (id: string) => downloadBlob(new Blob([await api.fdeTicket(id)], { type: 'text/markdown' }), `pedido-${id}.md`)

/** The Stripe Payment Link of a request; with a Stripe key on the server it pays on Checkout instead, so there is none. */
export const fdeLink = (stripe: StripeStatus | null, r: FdeRequest, packageLink?: string | null) => (stripe?.enabled ? null : r.checkout_url ?? packageLink ?? null)

/** Sends the user to Stripe for one request. */
export const payFde = async (r: FdeRequest, link: string | null, hours?: number) => {
  if (link) {
    window.location.href = `${link}?client_reference_id=${encodeURIComponent(r.id)}`
    return
  }
  const o = await api.checkout({ kind: 'fde', ref: r.id, hours: r.package === 'hours' ? hours : undefined })
  window.location.href = o.url
}

// Advertising measurement. Nothing of Meta's loads until the person accepts, and only on Tably's own site.
const CONSENT = 'arena.adCookies'
const META_PIXEL = '1706292027687059'

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[][]; loaded?: boolean; version?: string; push?: unknown }
declare global {
  interface Window { fbq?: Fbq; _fbq?: Fbq }
}

export type AdConsent = 'yes' | 'no' | null

export function adConsent(): AdConsent {
  try {
    const v = localStorage.getItem(CONSENT)
    return v === 'yes' || v === 'no' ? v : null
  } catch {
    return null
  }
}

export const onOurSite = () => /(^|\.)tablyteam\.com$/.test(location.hostname)

function loadMeta() {
  if (window.fbq || !onOurSite()) return
  const fbq: Fbq = (...args) => { if (fbq.callMethod) fbq.callMethod(...args); else fbq.queue!.push(args) }
  fbq.push = fbq
  fbq.loaded = true
  fbq.version = '2.0'
  fbq.queue = []
  window.fbq = window._fbq = fbq
  const s = document.createElement('script')
  s.async = true
  s.src = 'https://connect.facebook.net/en_US/fbevents.js'
  document.head.appendChild(s)
  fbq('init', META_PIXEL)
  fbq('track', 'PageView')
}

export const startTracking = () => { if (adConsent() === 'yes') loadMeta() }

/** Rejecting after accepting has to stop it here and now: only a reload unloads what is already running. */
export function setAdConsent(value: 'yes' | 'no') {
  const had = !!window.fbq
  try {
    localStorage.setItem(CONSENT, value)
  } catch {
    // private mode: the choice lasts this page only
  }
  window.dispatchEvent(new Event('tably-consent'))
  if (value === 'yes') loadMeta()
  else if (had) location.reload()
}

/** Only the name of what happened: no email, name or anything else about the person goes with it. */
export const trackEvent = (name: 'CompleteRegistration' | 'Lead') => { if (adConsent() === 'yes') window.fbq?.('track', name) }

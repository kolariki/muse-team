/**
 * Motion for the public pages (landing, login): GSAP 3.15 with the plugins that became free in 3.13 — SplitText for
 * the hero title, ScrollTrigger for the cards, DrawSVG for the handoff lines. Framer Motion stays for the small
 * in-app transitions; GSAP drives the "first impression" choreography because it sequences hundreds of targets
 * on one timeline with easings a CSS transition cannot do.
 */
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin, MotionPathPlugin)

export { gsap, useGSAP, ScrollTrigger, SplitText }

const splits = new WeakMap<HTMLElement, SplitText>()

export const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Hero choreography: the title arrives word by word, then the paragraph, the buttons, the logos; the demo frame
 * swings in from a slight 3D angle. Returns the timeline so the caller can scope-kill it. */
export function heroIntro(root: HTMLElement) {
  if (reduced()) return null
  const title = root.querySelector<HTMLElement>('[data-hero-title]')
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  let wordChars: Element[] = []
  if (title) {
    // React StrictMode mounts twice in dev: undo a previous split before splitting again, or the chars nest
    splits.get(title)?.revert()
    const split = SplitText.create(title, { type: 'words,chars', charsClass: 'hero-char' })
    splits.set(title, split)
    gsap.set(title, { opacity: 1 })
    const word = title.querySelector('[data-hero-word]')
    wordChars = word ? Array.from(word.querySelectorAll('.hero-char')) : []
    const rest = split.chars.filter((c) => !wordChars.includes(c))
    tl.from(rest, { yPercent: 110, opacity: 0, rotateX: -40, filter: 'blur(8px)', duration: 0.9, stagger: { each: 0.018, from: 'start' } }, 0.1)
  }
  tl.from(root.querySelectorAll('[data-hero-kicker]'), { y: 10, opacity: 0, duration: 0.6 }, 0)
    .from(root.querySelectorAll('[data-hero-copy]'), { y: 18, opacity: 0, filter: 'blur(6px)', duration: 0.8 }, 0.7)
    // explicit end values: these buttons have a CSS transition, and a plain .from() can read a half-way opacity as its target and leave them invisible
    .fromTo(root.querySelectorAll('[data-hero-cta]'), { y: 16, opacity: 0, scale: 0.96, transition: 'none' }, { y: 0, opacity: 1, scale: 1, duration: 0.6, stagger: 0.08, clearProps: 'all' }, 1.0)
    .from(root.querySelectorAll('[data-hero-row]'), { y: 12, opacity: 0, duration: 0.6 }, 1.2)
    // the demo frame rises into place (no rotation, no blur: transform + opacity only, so it never stutters)
    .from(root.querySelectorAll('[data-hero-demo]'), { opacity: 0, y: 36, scale: 0.97, duration: 1.0, ease: 'power3.out', force3D: true, clearProps: 'transform' }, 0.4)

  // the signature: the companies' logos pop up around the title, fly to where "Tably" goes, fuse into one glowing
  // orb, and the orb bursts into the letters; a spark then flies up to the header and lights the TT icon
  const layer = root.querySelector<HTMLElement>('[data-fuse-layer]')
  const word = root.querySelector<HTMLElement>('[data-hero-word]')
  const logos = layer ? Array.from(layer.querySelectorAll<HTMLElement>('[data-fuse-logo]')) : []
  const orb = layer?.querySelector<HTMLElement>('[data-fuse-orb]')
  const spark = layer?.querySelector<HTMLElement>('[data-fuse-spark]')
  if (layer && word && logos.length && orb && wordChars.length) {
    const L = layer.getBoundingClientRect()
    const W = word.getBoundingClientRect()
    const cx = W.left - L.left + W.width / 2
    const cy = W.top - L.top + W.height / 2
    gsap.set(wordChars, { opacity: 0, scale: 0.2, transformOrigin: '50% 70%' })
    gsap.set(orb, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 0, opacity: 0 })
    logos.forEach((el, i) => {
      const a = (i / logos.length) * Math.PI * 2 - Math.PI / 2 + 0.35
      const r = 170 + (i % 3) * 55
      gsap.set(el, { x: cx + Math.cos(a) * r * 1.45, y: cy + Math.sin(a) * r * 0.85, xPercent: -50, yPercent: -50, scale: 0, opacity: 0, rotate: (i % 2 ? 1 : -1) * 18 })
    })
    tl.to(logos, { scale: 1, opacity: 1, rotate: 0, duration: 0.55, ease: 'back.out(2.2)', stagger: 0.07 }, 0.15)
      .to(logos, { y: '+=6', duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 1, stagger: { each: 0.05 } }, 0.7)
      .to(logos, { x: cx, y: cy, scale: 0.3, opacity: 0.95, rotate: 360, duration: 0.85, ease: 'power3.in', stagger: 0.04, overwrite: 'auto' }, 1.35)
      .to(orb, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(3)' }, 2.05)
      // the last logo lands at 1.35 + 6 × 0.04 + 0.85 ≈ 2.45: only then do they all vanish, or the last one lingers
      .to(logos, { opacity: 0, scale: 0, duration: 0.2, overwrite: true }, 2.47)
      .to(orb, { scale: 1.25, duration: 0.35, ease: 'sine.inOut', yoyo: true, repeat: 1 }, 2.5)
      .to(orb, { scale: 3.2, opacity: 0, duration: 0.7, ease: 'power2.out' }, 3.05)
      .to(wordChars, { opacity: 1, scale: 1, duration: 0.75, ease: 'back.out(2.4)', stagger: 0.07 }, 3.08)
      .fromTo(wordChars, { textShadow: '0 0 34px rgba(47,107,93,0.95)' }, { textShadow: '0 0 0px rgba(47,107,93,0)', duration: 1.3, ease: 'power2.out' }, 3.3)
    const icon = root.querySelector<HTMLElement>('[data-brand-icon]')
    const brandText = root.querySelectorAll('[data-brand-text]')
    if (icon && spark) {
      const I = icon.getBoundingClientRect()
      const ix = I.left - L.left + I.width / 2
      const iy = I.top - L.top + I.height / 2
      gsap.set(spark, { x: cx, y: cy, xPercent: -50, yPercent: -50, opacity: 0, scale: 0.6 })
      tl.to(spark, { opacity: 1, duration: 0.15 }, 3.35)
        .to(spark, { x: ix, y: iy, scale: 1, duration: 0.75, ease: 'power2.inOut' }, 3.4)
        .to(spark, { opacity: 0, scale: 0.2, duration: 0.2 }, 4.1)
        .fromTo(icon, { scale: 0.5, rotate: -25 }, { scale: 1, rotate: 0, duration: 0.7, ease: 'back.out(3)' }, 4.1)
        .fromTo(icon, { boxShadow: '0 0 0px 0px rgba(47,107,93,0)' }, { boxShadow: '0 0 24px 6px rgba(47,107,93,0.55)', duration: 0.25, yoyo: true, repeat: 1 }, 4.15)
        .from(brandText, { opacity: 0, x: -10, duration: 0.45, stagger: 0.08 }, 4.25)
    }
  }
  return tl
}

/** Cards and sections below the fold reveal as they scroll into view. */
export function scrollReveal(root: HTMLElement) {
  if (reduced()) return
  const els = gsap.utils.toArray<HTMLElement>(root.querySelectorAll('[data-scroll-reveal]'))
  gsap.set(els, { y: 36, opacity: 0, filter: 'blur(6px)' })
  // an observer on the page's own scroller: it does not depend on measured positions, so content that loads later cannot leave a card hidden
  const seen = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return
    seen.unobserve(e.target)
    gsap.to(e.target, { y: 0, opacity: 1, filter: 'blur(0px)', duration: 0.9, ease: 'power3.out', clearProps: 'all' })
  }), { root, rootMargin: '0px 0px -8% 0px' })
  els.forEach((el) => seen.observe(el))
  return () => seen.disconnect()
}

/** One demo scene just mounted: its marked pieces cascade in, and any marked SVG path draws itself. */
export function sceneIn(root: HTMLElement) {
  if (reduced()) return
  const items = root.querySelectorAll('[data-r]')
  if (items.length) gsap.from(items, { y: 14, opacity: 0, filter: 'blur(5px)', duration: 0.55, ease: 'power3.out', stagger: 0.06, delay: 0.15, clearProps: 'filter' })
  const paths = root.querySelectorAll('[data-draw]')
  if (paths.length) gsap.from(paths, { drawSVG: '0%', duration: 1.1, ease: 'power2.inOut', stagger: 0.1, delay: 0.3 })
}

/** A number that counts up (used for the readiness gauge and the stat tiles). */
export function countTo(el: HTMLElement, to: number, suffix = '', duration = 1.1) {
  if (reduced()) { el.textContent = `${to}${suffix}`; return }
  const o = { v: 0 }
  gsap.to(o, { v: to, duration, ease: 'power2.out', onUpdate: () => { el.textContent = `${Math.round(o.v)}${suffix}` } })
}

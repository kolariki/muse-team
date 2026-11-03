/**
 * Product flags for the Meta Global AI Developer Hackathon edition (Oct 27 – Nov 4, 2026).
 * MUSE_FIRST: the UI shows Meta · Muse as the engine (loaders, chips, settings) and keeps the other providers one click away,
 * without removing them from the product. Flip to false to go back to the multi-provider presentation.
 */
export const MUSE_FIRST = true
export const HACKATHON_MODE = true
/** MUSE_ONLY: the other AI providers and the desktop builders disappear from every picker; only Meta · Muse (and the simulated provider) stay. */
export const MUSE_ONLY = true

/** The providers a picker may show. */
export const visibleProviders = <T extends { id: string; source?: string }>(ps: T[]): T[] => (MUSE_ONLY ? ps.filter((p) => p.id === 'meta' || p.id === 'mock' || (p.id === 'baseten' && p.source === 'trial')) : ps)
/** The desktop coding agents a picker may show: only Muse Code in Muse-only mode. */
export const visibleEngines = <T extends { id: string }>(es: T[]): T[] => (MUSE_ONLY ? es.filter((e) => e.id === 'muse-code') : es)

/** Tickets (Notion → the team resolves them and opens the PR) is built but hidden for now: the product focuses on creating
 *  apps, the points scheme and the marketplace. Flip to true to bring it back (nothing was removed). */
export const TICKETS_ENABLED = false

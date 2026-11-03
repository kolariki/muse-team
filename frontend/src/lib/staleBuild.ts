import { useArena } from '../store'

// After a deploy the open tab still asks for the previous build's files, which no longer exist: a reload picks up the new ones.
const STALE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i
const RELOADED_AT = 'arena.staleReloadAt'
const RESUME_VIEW = 'arena.resumeView'
const RESUMABLE = ['audit', 'agents', 'market', 'tickets', 'team', 'analytics', 'studio', 'adtier', 'metaads', 'settings', 'backoffice', 'profile']

export const isStaleBuildError = (error: unknown) => STALE.test(String((error as Error)?.message ?? error))

/** Reloads, coming back to the same screen. Once in a while only: if the files really are missing, the error has to show. */
export function reloadForNewBuild(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT) ?? 0) < 30_000) return false
    sessionStorage.setItem(RELOADED_AT, String(Date.now()))
    sessionStorage.setItem(RESUME_VIEW, useArena.getState().view)
  } catch {
    return false
  }
  location.reload()
  return true
}

export function takeResumeView(): ReturnType<typeof useArena.getState>['view'] | null {
  try {
    const view = sessionStorage.getItem(RESUME_VIEW)
    sessionStorage.removeItem(RESUME_VIEW)
    return view && RESUMABLE.includes(view) ? (view as ReturnType<typeof useArena.getState>['view']) : null
  } catch {
    return null
  }
}

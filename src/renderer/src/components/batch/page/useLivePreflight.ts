/**
 * The page's side of the live plan. The actions already re-plan the pending jobs 400 ms after a plan input changes;
 * this hook adds the two moments the store cannot see: the window regaining focus, when sources may have changed
 * on disk, and the first snapshot, when a restored queue's waiting jobs have never been planned in this window.
 */
import { useEffect, useRef } from 'react'
import type { StoreApi } from 'zustand'
import type { BatchActions } from '../../../stores/batchActions'
import { useJobsStore, type JobsState } from '../../../stores/jobs'

/** What the hook binds. */
export interface LivePreflightOptions
{
  /** The window's jobs store by default. */
  jobs?: StoreApi<JobsState>
  /** The window by default. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

/** Whether a store change is the first snapshot this window applied. */
export function firstHydration(previous: Pick<JobsState, 'hydrations'>, next: Pick<JobsState, 'hydrations' | 'status'>): boolean
{
  return previous.hydrations === 0 && next.hydrations > 0 && next.status === 'hydrated'
}

/** Plans the pending jobs on window focus and once after the first snapshot. */
export function useLivePreflight(actions: Pick<BatchActions, 'windowFocused' | 'notePlanInputChange'>, options: LivePreflightOptions = {}): void
{
  const { jobs = useJobsStore, target = typeof window === 'undefined' ? null : window } = options
  const actionsRef = useRef(actions)

  useEffect(() =>
  {
    actionsRef.current = actions
  }, [actions])

  useEffect(() =>
  {
    if (target === null)
    {
      return undefined
    }
    const onFocus = (): void => actionsRef.current.windowFocused()
    target.addEventListener('focus', onFocus)
    return () => target.removeEventListener('focus', onFocus)
  }, [target])

  useEffect(() =>
  {
    if (jobs.getState().hydrations > 0 && jobs.getState().status === 'hydrated')
    {
      actionsRef.current.notePlanInputChange()
    }
    return jobs.subscribe((next, previous) =>
    {
      if (firstHydration(previous, next))
      {
        actionsRef.current.notePlanInputChange()
      }
    })
  }, [jobs])
}

/**
 * Subscribes this window to the job engine for as long as the calling component is mounted. Mount it once, from a
 * component only the main shell renders, so the popout player never subscribes and never receives batch events.
 */
import { useEffect } from 'react'
import { startJobsSync, useJobsStore, type JobsSyncApi } from '../stores/jobs'

/** The preload's jobs surface; null while the preload does not expose one. */
export function windowJobsApi(): JobsSyncApi | null
{
  const api = (window as unknown as { api?: { jobs?: JobsSyncApi } }).api
  return api?.jobs ?? null
}

/**
 * Keeps the jobs store in step with the engine: listens to jobs:event first, then subscribes and hydrates from the
 * snapshot. Each effect run uses a fresh client id and ignores a reply that arrives after its cleanup, so React's
 * double effect in development is safe. Pass a stable api, none to use the preload's, or null to stay unsubscribed
 * even when the preload exposes one.
 */
export function useJobs(api?: JobsSyncApi | null): void
{
  useEffect(() =>
  {
    const jobsApi = api === undefined ? windowJobsApi() : api
    if (jobsApi === null)
    {
      return undefined
    }
    return startJobsSync({ api: jobsApi, store: useJobsStore })
  }, [api])
}

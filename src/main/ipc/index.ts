/**
 * @module main/ipc
 * @description Barrel module - composes all IPC handler groups into a
 * single {@link registerIPC} entry point called from the app bootstrap.
 */

import { registerConfigIPC } from './config'
import { registerFilesIPC } from './files'
import { registerEditorIPC } from './editor'
import { registerMediaIPC } from './media'
import { registerSystemIPC } from './system'
import { registerJobsIPC } from './jobs'
import { hostPlatform } from './jobs-host'
import type { CommandTarget } from '../jobs/command-gate'
import type { JobsHost } from '../jobs/deps'

export { registerJobsIPC } from './jobs'
export { checkFfmpeg, createEngineRuntime, type EngineRuntime } from './jobs-host'

/** The engine and its host, once the engine has initialized; job channels are registered only with them. */
export interface JobsIPC {
  engine: CommandTarget
  host: Pick<JobsHost, 'rendererLocation' | 'logUnexpected'>
}

/**
 * Register every IPC handler for renderer ↔ main communication.
 * Called once during app initialization, after the engine's `init` when
 * `jobs` is given; batch processing runs only through the job channels.
 */
export function registerIPC(jobs?: JobsIPC): void {
  registerConfigIPC()
  registerFilesIPC()
  registerEditorIPC()
  registerMediaIPC()
  registerSystemIPC()
  if (jobs) registerJobsIPC(jobs.engine, jobs.host, hostPlatform())
}

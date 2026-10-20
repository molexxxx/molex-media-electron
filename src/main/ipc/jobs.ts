/**
 * The job command registration loop: one `ipcMain.handle` per `JOB_CHANNELS` entry, each answered by the command
 * gate with the sending frame's URL, its main-frame flag, and the sender's webContents id.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { JOB_CHANNELS, type JobCommandName } from '../../shared/jobs/contract'
import { createRequestValidators } from '../../shared/jobs/validate'
import type { Platform } from '../../shared/text/platform'
import { createCommandGate, type CommandTarget, type SenderInfo } from '../jobs/command-gate'
import type { JobsHost } from '../jobs/deps'

/** Every command name, in channel order. */
export const JOB_COMMAND_NAMES = Object.keys(JOB_CHANNELS) as JobCommandName[]

/** The sending frame of one invoke; a missing frame is never a main frame, so the gate refuses it. */
export function senderInfo(event: Pick<IpcMainInvokeEvent, 'senderFrame' | 'sender'>): SenderInfo
{
  const frame = event.senderFrame
  return {
    frameUrl: frame?.url ?? null,
    isMainFrame: frame !== null && frame !== undefined && frame.parent === null,
    senderId: event.sender.id
  }
}

/**
 * Registers every job command channel. Nothing here starts the engine; commands sent before `init` resolves are
 * answered by the engine's own refusal.
 * @returns A function that removes every handler this call registered.
 */
export function registerJobsIPC(engine: CommandTarget, host: Pick<JobsHost, 'rendererLocation' | 'logUnexpected'>, platform: Platform): () => void
{
  const gate = createCommandGate({
    engine,
    expected: host.rendererLocation(),
    validators: createRequestValidators(platform),
    logUnexpected: (name, err) => host.logUnexpected(name, err)
  })
  for (const name of JOB_COMMAND_NAMES)
  {
    ipcMain.handle(JOB_CHANNELS[name], (event, raw: unknown) => gate(name, raw, senderInfo(event)))
  }
  return () =>
  {
    for (const name of JOB_COMMAND_NAMES)
    {
      ipcMain.removeHandler(JOB_CHANNELS[name])
    }
  }
}

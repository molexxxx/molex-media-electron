/**
 * The one path every job command takes from IPC to the engine: the sender check, then the shared request
 * validator, then the engine, with every failure answered as a `CommandResult` instead of a rejected invoke.
 */

import type {
  CommandError, CommandErrorCode, CommandIssue, CommandResult, JobCommandName, JobCommandRequest, JobCommandResponse
} from '../../shared/jobs/contract'
import type { RequestValidators } from '../../shared/jobs/validate'
import { isTrustedSender, type RendererLocation } from './trust'

/** The sending frame of one invoke, as the IPC layer reads it from the event. */
export interface SenderInfo
{
  frameUrl: string | null
  isMainFrame: boolean
  senderId: number
}

/** What the engine learns about a command's sender. */
export interface CommandContext
{
  senderId: number
}

/** What the gate forwards validated commands to; the engine implements it. */
export interface CommandTarget
{
  command<K extends JobCommandName>(name: K, req: JobCommandRequest<K>, ctx: CommandContext): Promise<CommandResult<JobCommandResponse<K>>>
}

export interface CommandGateDeps
{
  engine: CommandTarget
  expected: RendererLocation
  /** Built once in main with `createRequestValidators(process.platform)`, so paths are checked for the host platform. */
  validators: RequestValidators
  logUnexpected(name: JobCommandName, err: unknown): void
}

/** Answers one invoke; never rejects. */
export type CommandGate = <K extends JobCommandName>(name: K, raw: unknown, sender: SenderInfo) => Promise<CommandResult<JobCommandResponse<K>>>

const MESSAGES: Readonly<Partial<Record<CommandErrorCode, string>>> =
{
  'untrusted-sender': 'Commands are accepted only from the molexMedia window.',
  'invalid-payload': 'The request was not valid.',
  'internal': 'molexMedia hit an unexpected error. It was written to the log.'
}

/** A refused command with no details. */
export function commandRefusal(code: CommandErrorCode, message?: string, issues: CommandIssue[] = []): { ok: false; error: CommandError }
{
  return { ok: false, error: { code, message: message ?? MESSAGES[code] ?? code, issues, details: null } }
}

/** Builds the gate the IPC registration loop calls for every command channel; a failing `logUnexpected` is ignored. */
export function createCommandGate(deps: CommandGateDeps): CommandGate
{
  const logUnexpected = (name: JobCommandName, err: unknown): void =>
  {
    try
    {
      deps.logUnexpected(name, err)
    }
    catch
    {
      return
    }
  }

  return async <K extends JobCommandName>(name: K, raw: unknown, sender: SenderInfo): Promise<CommandResult<JobCommandResponse<K>>> =>
  {
    if (!isTrustedSender(sender.frameUrl, sender.isMainFrame, deps.expected))
    {
      return commandRefusal('untrusted-sender')
    }
    try
    {
      const parsed = deps.validators[name](raw)
      if (!parsed.ok)
      {
        return commandRefusal('invalid-payload', undefined, parsed.issues)
      }
      return await deps.engine.command(name, parsed.value, { senderId: sender.senderId })
    }
    catch (err)
    {
      logUnexpected(name, err)
      return commandRefusal('internal')
    }
  }
}

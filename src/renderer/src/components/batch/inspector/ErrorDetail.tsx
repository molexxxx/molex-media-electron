import React from 'react'
import { formatTimeOfDay, PART_SEPARATOR } from '../../../copy/batch'
import type { JobDetail, JobError, StageId } from '../../../../../shared/jobs/types'
import { CapsText, cx } from '../../../ui'
import { CommandBlock } from './CommandBlock'
import { OutputTail } from './OutputTail'

/** The label of the executed command's block. */
export const COMMAND_LABEL = 'Command'

/** Each stage's name where a failure is placed. */
export const STAGE_NAMES: Readonly<Record<StageId, string>> =
{
  'probe': 'Probe',
  'measure': 'Measure',
  'measure-dynamics': 'Measure after dynamics',
  'measure-album': 'Measure album',
  'encode': 'Encode',
  'verify': 'Verify',
  'place': 'Save',
  'trash': 'Move to the Recycle Bin',
  'wait-lock': 'Wait for file access'
}

/** The POSIX names of the negative codes FFmpeg exits with, for builds whose exit name main could not read. */
export const ERRNO_NAMES: Readonly<Record<number, string>> =
{
  [-1]: 'EPERM',
  [-2]: 'ENOENT',
  [-5]: 'EIO',
  [-11]: 'EAGAIN',
  [-12]: 'ENOMEM',
  [-13]: 'EACCES',
  [-16]: 'EBUSY',
  [-17]: 'EEXIST',
  [-22]: 'EINVAL',
  [-28]: 'ENOSPC',
  [-32]: 'EPIPE'
}

/**
 * The exit as the detail prints it: "Exit code -22 (EINVAL)", "Exit code 1", "Stopped by SIGKILL"; null when no
 * process exited. The code keeps the ASCII minus the logs use, so a search of the log finds it.
 */
export function exitText(error: Pick<JobError, 'exitCode' | 'exitName' | 'signal'>): string | null
{
  if (error.exitCode !== null)
  {
    const name = error.exitName ?? (error.exitCode < 0 ? ERRNO_NAMES[error.exitCode] ?? null : null)
    return name === null ? `Exit code ${error.exitCode}` : `Exit code ${error.exitCode} (${name})`
  }
  if (error.signal !== null)
  {
    return `Stopped by ${error.signal}`
  }
  return null
}

/** The failed stage with its pass: "Encode, pass 1 of 2"; the label main gave the stage wins over the plain name. */
export function failedStageText(error: Pick<JobError, 'stage' | 'encodePass'>, stages: JobDetail['stages'] = []): string
{
  const failed = stages.find((stage) => stage.id === error.stage && stage.outcome === 'failed')
    ?? stages.find((stage) => stage.id === error.stage)
  const name = STAGE_NAMES[error.stage]
  if (error.encodePass === null)
  {
    return name
  }
  const passes = failed?.passes ?? 0
  return passes > 1 ? `${name}, pass ${error.encodePass} of ${passes}` : name
}

/** Where and when the attempt failed: "Failed during Encode, pass 1 of 2, at 14:02." */
export function failureWhenText(error: JobError, stages: JobDetail['stages'] = []): string
{
  return `Failed during ${failedStageText(error, stages)}, at ${formatTimeOfDay(error.at)}.`
}

/** The attempt and how its process ended: "Attempt 1 · Exit code -22 (EINVAL)". */
export function attemptExitText(error: JobError): string
{
  const parts = [`Attempt ${error.attempt}`]
  const exit = exitText(error)
  if (exit !== null)
  {
    parts.push(exit)
  }
  if (error.fsError !== null)
  {
    parts.push(`${error.fsError.code} on ${error.fsError.syscall}`)
  }
  return parts.join(PART_SEPARATOR)
}

/** The command line that failed: the error's own, else the attempt's last command for the failed stage. */
export function failedCommand(error: JobError, commands: JobDetail['commands'] = []): string | null
{
  if (error.command !== null)
  {
    return error.command.display
  }
  const matching = commands.filter((command) => command.stage === error.stage && (error.encodePass === null || command.encodePass === error.encodePass))
  return matching.length > 0 ? matching[matching.length - 1].display : null
}

/** The FFmpeg output to show: the attempt log's tail when main kept one, else the failing process's own. */
export function failureOutput(error: JobError, stderrTail: string | null): string
{
  return stderrTail !== null && stderrTail.trim() !== '' ? stderrTail : error.stderrTail
}

/** What "Copy error" puts on the clipboard: the sentence, the reason, and the command. */
export function copyErrorText(error: JobError, command: string | null): string
{
  const lines = [error.message, `Reason: ${error.short}`]
  const exit = exitText(error)
  if (exit !== null)
  {
    lines.push(exit)
  }
  if (command !== null)
  {
    lines.push(`Command: ${command}`)
  }
  return lines.join('\n')
}

/** Props for {@link ErrorDetail}. */
export interface ErrorDetailProps
{
  error: JobError
  detail: Pick<JobDetail, 'stages' | 'commands' | 'stderrTail'>
  /** Opens the attempt's complete FFmpeg log in Logs. */
  onFullOutput?: () => void
  /** Writes text to the clipboard; the system clipboard by default. */
  onCopy?: (text: string) => void | Promise<void>
  /** Runs after a copy of the output or the command, for the page's toast. */
  onCopied?: (kind: 'output' | 'command', text: string) => void
  className?: string
}

/**
 * A failed attempt in full: main's sentence (cause first), where and when it failed, the attempt and exit code, the
 * last 40 lines of FFmpeg's output, and the exact command.
 */
export function ErrorDetail({ error, detail, onFullOutput, onCopy, onCopied, className }: ErrorDetailProps): React.JSX.Element
{
  const command = failedCommand(error, detail.commands)
  const output = failureOutput(error, detail.stderrTail)
  return (
    <div className={cx('flex flex-col gap-3', className)} data-part='error-detail'>
      <div className='flex flex-col gap-1 select-text'>
        <p className='text-body text-ink'>{error.message}</p>
        {error.hint !== null && <p className='text-label text-ink-2'>{error.hint}</p>}
        <p className='text-label text-ink-2'>{failureWhenText(error, detail.stages)}</p>
        <p className='text-label tabular-nums text-ink-2'>{attemptExitText(error)}</p>
      </div>
      {(output !== '' || error.exitCode !== null || error.signal !== null) && (
        <OutputTail
          text={output}
          onCopy={onCopy}
          onCopied={(text) => onCopied?.('output', text)}
          onFullOutput={onFullOutput}
        />
      )}
      {command !== null && (
        <div className='flex flex-col gap-2'>
          <h4 className='type-legend text-brass'>
            <CapsText>{COMMAND_LABEL}</CapsText>
          </h4>
          <CommandBlock
            display={command}
            state='executed'
            label={COMMAND_LABEL}
            onCopy={onCopy}
            onCopied={(text) => onCopied?.('command', text)}
          />
        </div>
      )}
    </div>
  )
}

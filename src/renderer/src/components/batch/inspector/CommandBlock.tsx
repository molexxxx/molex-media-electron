import React from 'react'
import type { Platform } from '../../../../../shared/text/platform'
import { Button, cx, usePlatform } from '../../../ui'

const WINDOWS_PLAIN = /^[^\s"&|<>^()!]+$/
const POSIX_PLAIN = /^[\p{L}\p{N}\p{M}_@%+=:,./-]+$/u

/** The label of the copy button every command block carries. */
export const COPY_COMMAND_LABEL = 'Copy command'

function quoteWindows(arg: string): string
{
  if (WINDOWS_PLAIN.test(arg))
  {
    return arg
  }
  let quoted = '"'
  let backslashes = 0
  for (const ch of arg)
  {
    if (ch === '\\')
    {
      backslashes += 1
      continue
    }
    quoted += ch === '"' ? '\\'.repeat(backslashes * 2 + 1) : '\\'.repeat(backslashes)
    quoted += ch
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

function quotePosix(arg: string): string
{
  if (POSIX_PLAIN.test(arg))
  {
    return arg
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * One argument quoted so the platform's parser reads it back unchanged: the Windows argument rules on win32,
 * a POSIX shell elsewhere. The same rules main uses for the command lines it logs.
 */
export function quoteArgument(arg: string, platform: Platform): string
{
  return platform === 'win32' ? quoteWindows(arg) : quotePosix(arg)
}

/** An argument list, program first, as one command line for the platform's shell. */
export function quoteCommand(argv: readonly string[], platform: Platform): string
{
  return argv.map((arg) => quoteArgument(arg, platform)).join(' ')
}

/** A run of command text, marked when it is a placeholder for a value known only after measuring. */
export interface CommandPart
{
  text: string
  placeholder: boolean
}

function escapeRegExp(text: string): string
{
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Splits command text around its placeholders, longest placeholder first so one never hides inside another. */
export function splitPlaceholders(text: string, placeholders: readonly string[]): CommandPart[]
{
  const tokens = [...new Set(placeholders.filter((token) => token !== ''))].sort((a, b) => b.length - a.length)
  if (tokens.length === 0)
  {
    return text === '' ? [] : [{ text, placeholder: false }]
  }
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`)
  return text
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, placeholder: tokens.includes(part) }))
}

export interface CommandBlockProps
{
  /** The exact argument list, program first; quoted here for the platform's shell. */
  argv?: readonly string[]
  /** A command line already quoted for display, as executed commands carry it; used when argv is absent. */
  display?: string
  /** Values the command learns only after measuring, written as tokens such as {gain-a0}. */
  placeholders?: readonly string[]
  /** Planned commands may hold placeholders; executed ones are the exact line that ran. */
  state?: 'planned' | 'executed'
  /** Names the command for assistive technology, such as "Planned FFmpeg command". */
  label: string
  platform?: Platform
  /** Writes the text to the clipboard; the system clipboard by default. */
  onCopy?: (text: string) => void | Promise<void>
  /** Runs after a successful copy, for the page's "Copied" toast. */
  onCopied?: (text: string) => void
  id?: string
  className?: string
}

async function writeClipboard(text: string): Promise<void>
{
  await navigator.clipboard.writeText(text)
}

/** A command line in mono that wraps at spaces, stays selectable, and copies exactly as shown. */
export function CommandBlock({
  argv,
  display = '',
  placeholders = [],
  state = 'executed',
  label,
  platform,
  onCopy = writeClipboard,
  onCopied,
  id,
  className
}: CommandBlockProps): React.JSX.Element
{
  const contextPlatform = usePlatform()
  const text = argv === undefined ? display : quoteCommand(argv, platform ?? contextPlatform)
  const parts = splitPlaceholders(text, placeholders)
  const copy = async (): Promise<void> =>
  {
    try
    {
      await onCopy(text)
    }
    catch
    {
      return
    }
    onCopied?.(text)
  }
  return (
    <div id={id} role='group' aria-label={label} data-state={state} className={cx('flex flex-col items-start gap-2', className)}>
      <pre
        className='w-full select-text whitespace-pre-wrap wrap-break-word rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-xs tabular-nums text-ink-2'
      >
        <code>
          {parts.map((part, index) => part.placeholder
            ? (
                <span key={index} data-part='placeholder' className='text-ink underline decoration-ink-3 decoration-dotted underline-offset-2'>
                  {part.text}
                </span>
              )
            : <React.Fragment key={index}>{part.text}</React.Fragment>)}
        </code>
      </pre>
      <Button variant='secondary' size='sm' icon='action.copy' disabled={text === ''} onClick={() => { void copy() }}>
        {COPY_COMMAND_LABEL}
      </Button>
    </div>
  )
}

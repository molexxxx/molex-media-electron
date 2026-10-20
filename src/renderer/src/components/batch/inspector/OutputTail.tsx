import React, { useId } from 'react'
import { Button, CapsText, cx } from '../../../ui'

/** How many lines of FFmpeg's output the tail shows. */
export const OUTPUT_TAIL_LINES = 40

/** The words of the output tail. */
export const OUTPUT_TAIL_WORDS =
{
  caption: `FFmpeg output, last ${OUTPUT_TAIL_LINES} lines`,
  copy: 'Copy output',
  full: 'Full output',
  empty: 'FFmpeg printed nothing for this attempt.'
} as const

/**
 * The last lines of a process's output as a terminal shows them: a carriage return overwrites its line (FFmpeg's
 * progress), and trailing blank lines are dropped.
 */
export function lastLines(text: string, count: number = OUTPUT_TAIL_LINES): string
{
  const lines = text.split('\n').map((line) =>
  {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    const overwritten = trimmed.lastIndexOf('\r')
    return overwritten === -1 ? trimmed : trimmed.slice(overwritten + 1)
  })
  while (lines.length > 0 && lines[lines.length - 1].trim() === '')
  {
    lines.pop()
  }
  return count > 0 ? lines.slice(-count).join('\n') : ''
}

/** Props for {@link OutputTail}. */
export interface OutputTailProps
{
  /** The failing process's output; only its last lines show. */
  text: string
  /** Writes the text to the clipboard; the system clipboard by default. */
  onCopy?: (text: string) => void | Promise<void>
  /** Runs after a successful copy, for the page's "Copied output." toast. */
  onCopied?: (text: string) => void
  /** Opens the attempt's complete FFmpeg log in Logs; the button shows only when given. */
  onFullOutput?: () => void
  className?: string
}

async function writeClipboard(text: string): Promise<void>
{
  await navigator.clipboard.writeText(text)
}

/** The last 40 lines of FFmpeg's output in a focusable, labeled, scrollable, selectable region. */
export function OutputTail({ text, onCopy = writeClipboard, onCopied, onFullOutput, className }: OutputTailProps): React.JSX.Element
{
  const captionId = `${useId()}-caption`
  const tail = lastLines(text)
  const copy = async (): Promise<void> =>
  {
    try
    {
      await onCopy(tail)
    }
    catch
    {
      return
    }
    onCopied?.(tail)
  }
  return (
    <div className={cx('flex flex-col items-start gap-2', className)}>
      <h4 id={captionId} className='type-legend text-brass'>
        <CapsText>{OUTPUT_TAIL_WORDS.caption}</CapsText>
      </h4>
      <div
        role='region'
        aria-labelledby={captionId}
        tabIndex={0}
        data-part='output-tail'
        className='max-h-72 w-full overflow-auto rounded-sm border border-line bg-sunken'
      >
        <pre className='w-max min-w-full select-text px-2.5 py-2 font-mono text-xs leading-normal text-ink-2'>
          {tail === '' ? <span className='text-ink-3'>{OUTPUT_TAIL_WORDS.empty}</span> : tail}
        </pre>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button variant='secondary' size='sm' icon='action.copy' disabled={tail === ''} onClick={() => { void copy() }}>
          {OUTPUT_TAIL_WORDS.copy}
        </Button>
        {onFullOutput !== undefined && (
          <Button variant='ghost' size='sm' icon='action.showLog' onClick={onFullOutput}>
            {OUTPUT_TAIL_WORDS.full}
          </Button>
        )}
      </div>
    </div>
  )
}

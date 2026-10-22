/**
 * @module components/logs/LogDetails
 * @description The details pane under the log lines: the selected line in full, its command wrapped in mono with
 * copy, its details, and where it came from; several selected lines read as the text Copy would write.
 */

import React, { type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Button, IconButton, cx } from '../../ui'
import type { LogEntry } from '../../stores/types'
import { countOf, PART_SEPARATOR } from '../../copy/batch'
import { formatRunLabel, type RunId } from '../../../../shared/jobs/ids'
import { CommandBlock } from '../batch/inspector/CommandBlock'
import { STAGE_NAMES } from '../batch/inspector/ErrorDetail'
import { commandText, formatLogLines, fullStamp, isRawText, LOG_WORDS, logSource, shownMessage, SOURCE_LABELS } from './logModel'
import { LevelLabel } from './LogTable'

/** Props for {@link LogDetails}. */
export interface LogDetailsProps
{
  /** The selected lines in display order. */
  entries: readonly LogEntry[]
  onClose: () => void
  onCopy: (entries: LogEntry[]) => void
  onCopied: (what: string) => void
  onShowJob: (entry: LogEntry) => void
  /** The Pane height menu, beside Close. */
  heightMenu?: ReactNode
  id?: string
  className?: string
  style?: React.CSSProperties
}

/** Where a line came from: its source, job, batch, attempt, and stage. */
export function originParts(entry: LogEntry): string[]
{
  const parts = [SOURCE_LABELS[logSource(entry)]]
  if (entry.jobId !== undefined)
  {
    parts.push(entry.jobId)
  }
  if (entry.runId !== undefined)
  {
    parts.push(formatRunLabel(entry.runId as RunId))
  }
  if (entry.attempt !== undefined)
  {
    parts.push(`attempt ${entry.attempt}`)
  }
  if (entry.stage !== undefined)
  {
    parts.push(STAGE_NAMES[entry.stage] ?? entry.stage)
  }
  return parts
}

function OneLine({ entry, onCopy, onCopied, onShowJob, onClose, heightMenu }: Omit<LogDetailsProps, 'entries' | 'id' | 'className' | 'style'> & { entry: LogEntry }): ReactElement
{
  const command = commandText(entry)
  const mono = command === null && isRawText(entry)
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-5.5 pb-2">
        <LevelLabel entry={entry} className="font-semibold" />
        <span className="min-w-0 text-label text-ink-2">{originParts(entry).join(PART_SEPARATOR)}</span>
        <span className="text-label tabular-nums text-ink-3">{fullStamp(entry)}</span>
        <span className="ms-auto flex items-center gap-1">
          <Button variant="secondary" size="sm" icon="action.copy" onClick={() => onCopy([entry])}>{LOG_WORDS.copyLine}</Button>
          {entry.jobId !== undefined && (
            <Button variant="ghost" size="sm" icon="nav.batch" onClick={() => onShowJob(entry)}>{`${LOG_WORDS.showJob} ${entry.jobId}`}</Button>
          )}
          {heightMenu}
          <IconButton icon="action.close" label={LOG_WORDS.hideDetails} size="sm" tooltip onClick={onClose} />
        </span>
      </div>
      <div data-part="details-body" tabIndex={0} aria-label={LOG_WORDS.detailsLabel} className="ui-overlay-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3" data-focus="inset">
        {command !== null
          ? <CommandBlock display={command} label={LOG_WORDS.command} onCopied={() => onCopied(LOG_WORDS.command)} className="w-full" />
          : (
            <p className={cx('select-text whitespace-pre-wrap wrap-break-word', mono ? 'font-mono text-label text-ink-2' : 'text-body text-ink')}>
              {shownMessage(entry)}
            </p>
            )}
        {entry.details !== undefined && entry.details !== '' && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-label font-semibold text-ink-2">{LOG_WORDS.details}</h3>
            <pre className="select-text whitespace-pre-wrap wrap-break-word rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-label text-ink-2 shadow-well">
              {entry.details}
            </pre>
          </div>
        )}
      </div>
    </>
  )
}

/** The details pane; Escape inside it closes it. */
export function LogDetails({ entries, onClose, onCopy, onCopied, onShowJob, heightMenu, id, className, style }: LogDetailsProps): ReactElement
{
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void =>
  {
    if (event.key === 'Escape' && !event.defaultPrevented)
    {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <section
      id={id}
      aria-label={LOG_WORDS.detailsLabel}
      data-part="log-details"
      className={cx('flex min-h-0 shrink-0 flex-col bg-panel', className)}
      style={style}
      onKeyDown={onKeyDown}
    >
      {entries.length === 1
        ? <OneLine entry={entries[0]} onClose={onClose} onCopy={onCopy} onCopied={onCopied} onShowJob={onShowJob} heightMenu={heightMenu} />
        : (
          <>
            <div className="flex shrink-0 items-center gap-3 px-4 pt-5.5 pb-2">
              <span className="text-label text-ink-2">
                {entries.length === 0 ? LOG_WORDS.detailsEmpty : `${countOf(entries.length, 'line')} selected`}
              </span>
              <span className="ms-auto flex items-center gap-1">
                {entries.length > 0 && (
                  <Button variant="secondary" size="sm" icon="action.copy" onClick={() => onCopy([...entries])}>
                    {`Copy ${countOf(entries.length, 'line')}`}
                  </Button>
                )}
                {heightMenu}
                <IconButton icon="action.close" label={LOG_WORDS.hideDetails} size="sm" tooltip onClick={onClose} />
              </span>
            </div>
            {entries.length > 0 && (
              <div data-part="details-body" tabIndex={0} aria-label={LOG_WORDS.detailsLabel} className="ui-overlay-scroll min-h-0 flex-1 overflow-auto px-4 pb-3" data-focus="inset">
                <pre className="w-max min-w-full select-text font-mono text-label text-ink-2">{formatLogLines(entries)}</pre>
              </div>
            )}
          </>
          )}
    </section>
  )
}

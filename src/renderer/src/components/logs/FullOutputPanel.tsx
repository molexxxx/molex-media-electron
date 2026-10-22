/**
 * @module components/logs/FullOutputPanel
 * @description A job's complete FFmpeg output from `jobs:log`, read when the panel first opens, with copy and the
 * attempt log's folder.
 */

import React, { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../../ui'
import type { JobId } from '../../../../shared/jobs/ids'
import type { CommandResult } from '../../../../shared/jobs/contract'
import { writeClipboard, type JobLogResult, type LogViewerApi } from './logApi'
import { LOG_FILTER_WORDS } from './logModel'

type FullOutputState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready', text: string, truncated: boolean, file: string | null }
  | { status: 'error', message: string }

/** Props for {@link FullOutputPanel}. */
export interface FullOutputPanelProps
{
  jobId: JobId
  api: LogViewerApi
}

/** The Show output toggle and, once opened, the job's whole FFmpeg output in a scrolling well. */
export function FullOutputPanel({ jobId, api }: FullOutputPanelProps): React.JSX.Element
{
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<FullOutputState>({ status: 'idle' })
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const headingId = `${useId()}-heading`
  const bodyId = `${headingId}-body`

  useEffect(() =>
  {
    alive.current = true
    return () =>
    {
      alive.current = false
    }
  }, [])

  const load = async (): Promise<void> =>
  {
    if (!api.jobLog)
    {
      setState({ status: 'error', message: LOG_FILTER_WORDS.unavailable })
      return
    }
    setState({ status: 'loading' })
    let result: CommandResult<JobLogResult>
    try
    {
      result = await api.jobLog({ jobId, attempt: null })
    }
    catch
    {
      result = { ok: false, error: { code: 'internal', message: LOG_FILTER_WORDS.failed, issues: [], details: null } }
    }
    if (!alive.current)
    {
      return
    }
    if (result.ok)
    {
      setState({ status: 'ready', text: result.value.lines.join('\n'), truncated: result.value.truncated, file: result.value.file })
    }
    else
    {
      setState({ status: 'error', message: result.error.message || LOG_FILTER_WORDS.failed })
    }
  }

  const toggle = (): void =>
  {
    const next = !open
    setOpen(next)
    if (next && (state.status === 'idle' || state.status === 'error'))
    {
      void load()
    }
  }

  const copy = async (text: string): Promise<void> =>
  {
    if (!(await writeClipboard(text)))
    {
      return
    }
    setCopied(true)
    setTimeout(() =>
    {
      if (alive.current)
      {
        setCopied(false)
      }
    }, 1500)
  }

  return (
    <div data-part="full-output" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 id={headingId} className="text-label font-semibold text-ink-2">{LOG_FILTER_WORDS.fullOutput}</h2>
        <Button
          variant="ghost"
          size="sm"
          icon={open ? 'action.collapse' : 'action.expand'}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {open ? LOG_FILTER_WORDS.hideOutput : LOG_FILTER_WORDS.showOutput}
        </Button>
      </div>
      {open && (
        <div id={bodyId} className="flex w-full flex-col items-start gap-2">
          {state.status === 'loading' && (
            <p role="status" className="text-label text-ink-3">{LOG_FILTER_WORDS.reading}</p>
          )}
          {state.status === 'error' && (
            <>
              <p role="alert" className="text-label text-error">{state.message}</p>
              <Button variant="secondary" size="sm" icon="action.retry" onClick={() => { void load() }}>
                {LOG_FILTER_WORDS.tryAgain}
              </Button>
            </>
          )}
          {state.status === 'ready' && (
            <>
              <div
                role="region"
                aria-labelledby={headingId}
                tabIndex={0}
                data-part="full-output-text"
                className="ui-overlay-scroll max-h-64 w-full overflow-auto rounded-sm border border-line bg-sunken shadow-well"
              >
                <pre className="w-max min-w-full select-text px-2.5 py-2 font-mono text-label text-ink-2">
                  {state.text === '' ? <span className="text-ink-3">{LOG_FILTER_WORDS.emptyOutput}</span> : state.text}
                </pre>
              </div>
              {state.truncated && <p className="text-label text-ink-3">{LOG_FILTER_WORDS.truncated}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="action.copy"
                  disabled={state.text === ''}
                  onClick={() => { void copy(state.text) }}
                >
                  {copied ? LOG_FILTER_WORDS.copied : LOG_FILTER_WORDS.copy}
                </Button>
                {state.file !== null && (
                  <Button variant="ghost" size="sm" icon="action.reveal" onClick={() => { void api.showInFolder(state.file as string) }}>
                    {LOG_FILTER_WORDS.showFile}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

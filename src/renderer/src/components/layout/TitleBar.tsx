/**
 * @module components/layout/TitleBar
 * @description The title bar: the molexMedia wordmark, the version, the job engine's run
 * state as a word, and the window's caption buttons.
 */

import React, { useEffect, useState } from 'react'
import { useJobsStore } from '../../stores/jobs'
import { selectRunStatus } from '../../stores/jobsSelectors'
import type { RunStatus } from '../../../../shared/jobs/types'
import { cx } from '../../ui/cx'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import type { IconName } from '../../ui/icons'

interface RunStateLook
{
  word: string
  icon: IconName
  ink: string
}

/** The words and still glyphs for each open run state; an idle engine shows nothing. */
export const RUN_STATE_LOOKS: Readonly<Record<Exclude<RunStatus, 'idle'>, RunStateLook>> = {
  running: { word: 'Batch running', icon: 'action.start', ink: 'text-running' },
  pausing: { word: 'Batch pausing', icon: 'status.paused', ink: 'text-ink-2' },
  paused: { word: 'Batch paused', icon: 'status.paused', ink: 'text-ink-2' },
  canceling: { word: 'Batch stopping', icon: 'action.stop', ink: 'text-ink-2' }
}

/** The run state's look, or null while the engine is idle. */
export function runStateLook(status: RunStatus): RunStateLook | null
{
  return status === 'idle' ? null : RUN_STATE_LOOKS[status]
}

/**
 * Whether the window fills its screen's work area, which is how a maximized frameless window
 * reports itself to the page.
 */
export function readMaximized(win: Pick<Window, 'outerWidth' | 'outerHeight' | 'screen'> = window): boolean
{
  const { availWidth, availHeight } = win.screen
  return availWidth > 0 && availHeight > 0 && win.outerWidth >= availWidth && win.outerHeight >= availHeight
}

/** Follows the window's maximized state across resizes. */
export function useWindowMaximized(): boolean
{
  const [maximized, setMaximized] = useState(() => readMaximized())
  useEffect(() =>
  {
    const update = (): void => setMaximized(readMaximized())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return maximized
}

/** The engine's run state as a still glyph and a word in its ink. */
function RunStateLabel({ status }: { status: RunStatus }): React.JSX.Element | null
{
  const look = runStateLook(status)
  if (!look)
  {
    return null
  }
  return (
    <span data-run-status={status} className={cx('flex min-w-0 items-center gap-1 text-label', look.ink)}>
      <Icon name={look.icon} size="sm" />
      <span className="truncate">{look.word}</span>
    </span>
  )
}

/** The drag-region header above the views; the caption buttons sit flush with the window's edge. */
export default function TitleBar(): React.JSX.Element
{
  const status = useJobsStore(selectRunStatus)
  const maximized = useWindowMaximized()

  return (
    <header className="drag-region flex h-(--size-titlebar) shrink-0 items-center justify-between border-b border-rail-edge bg-rail ps-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-display text-section font-semibold whitespace-nowrap text-ink">
          molex<span className="text-accent-ink">Media</span>
        </span>
        <span className="text-label whitespace-nowrap text-ink-3 tabular-nums">{__APP_VERSION__}</span>
        <RunStateLabel status={status} />
      </div>

      <div className="no-drag flex self-stretch">
        <IconButton
          size="caption"
          label="Minimize"
          icon="window.minimize"
          onClick={() => window.api.windowMinimize?.()}
        />
        <IconButton
          size="caption"
          label={maximized ? 'Restore' : 'Maximize'}
          icon={maximized ? 'window.restore' : 'window.maximize'}
          onClick={() => window.api.windowMaximize?.()}
        />
        <IconButton
          size="caption"
          variant="danger"
          label="Close"
          icon="window.close"
          onClick={() => window.api.windowClose?.()}
        />
      </div>
    </header>
  )
}

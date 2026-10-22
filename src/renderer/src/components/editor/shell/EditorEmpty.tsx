/**
 * @module editor/shell/EditorEmpty
 * The editor with nothing open, as a full-width landing: one header row with the mode's title, its one line, and
 * Open file with its shortcut at the right end, then the recent files spanning the pane, or a short note on
 * dropping files while there are none.
 */
import type { ReactElement } from 'react'
import { Button } from '../../../ui/Button'
import { Kbd } from '../../../ui/Kbd'
import { modeInfo } from '../modes'
import type { EditorMode } from '../types'
import { RecentFiles, useRecentFiles } from './RecentFiles'

/** Props of {@link EditorEmpty}. */
export interface EditorEmptyProps
{
  mode: EditorMode
  /** A file is being probed. */
  loading: boolean
  onOpenDialog: () => void
  onOpenPath: (filePath: string, mode: EditorMode) => void
}

/** The landing for the current mode. */
export function EditorEmpty({ mode, loading, onOpenDialog, onOpenPath }: EditorEmptyProps): ReactElement
{
  const info = modeInfo(mode)
  const many = mode === 'edit'
  const hasRecents = useRecentFiles().length > 0
  return (
    <div className="flex h-full min-h-0 flex-col" data-empty-state="editor">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3 pb-3">
        <div className="min-w-0">
          <h1 className="text-title text-ink">{info.emptyHeading}</h1>
          <p className="mt-0.5 text-body text-ink-2">{info.landingLine}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <Button variant="primary" icon="action.browse" loading={loading} loadingLabel="Opening" onClick={onOpenDialog}>
            {many ? 'Open files' : 'Open file'}
          </Button>
          <Kbd keys={['Mod', 'O']} />
        </div>
      </header>
      {hasRecents
        ? <RecentFiles mode={mode} onOpen={onOpenPath} />
        : (
            <div data-part="recent-empty" className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-6 pt-6 pb-[min(22vh,11rem)] text-center">
              <h2 className="text-section text-ink">No recent files</h2>
              <p className="text-body text-ink-2">
                Drop {many ? 'files' : 'a file'} anywhere on this page, or choose {many ? 'Open files' : 'Open file'}
              </p>
              <Kbd keys={['Mod', 'O']} />
            </div>
          )}
    </div>
  )
}

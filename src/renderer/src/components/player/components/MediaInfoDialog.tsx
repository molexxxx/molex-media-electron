/**
 * Media information, like a codec information window: how the file is being played first, then the file and each
 * stream as a plain line, with the technical values folded under each.
 */

import type { ReactElement } from 'react'
import type { PlayerMedia } from '../../../../../shared/player/media'
import { Button } from '../../../ui/Button'
import { Dialog } from '../../../ui/Dialog'
import { Icon } from '../../../ui/Icon'
import { PLAYER_COPY } from '../copy'
import { mediaInfo, type InfoRow } from '../engine/describe'

function Rows({ rows }: { rows: readonly InfoRow[] }): ReactElement
{
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 pt-2">
      {rows.map((row) => (
        <div key={row.term} className="contents">
          <dt className="text-label text-ink-3">{row.term}</dt>
          <dd className="min-w-0 font-mono text-label break-words text-ink-2">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Fold({ label, rows }: { label: string, rows: readonly InfoRow[] }): ReactElement | null
{
  if (rows.length === 0)
  {
    return null
  }
  return (
    <details className="group">
      <summary className="flex w-fit cursor-default list-none items-center gap-1 rounded-sm text-label text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex transition-transform duration-move group-open:rotate-90"><Icon name="action.expand" size="sm" /></span>
        {label}
      </summary>
      <Rows rows={rows} />
    </details>
  )
}

/** Props of {@link MediaInfoDialog}. */
export interface MediaInfoDialogProps
{
  open: boolean
  onClose: () => void
  /** The track's name, for the title. */
  name: string
  media: PlayerMedia | null
  /** The audio track in use. */
  audioIndex: number
  /** True while the stage shows the picture. */
  pictureShown: boolean
  /** The encoder FFmpeg hands a decoded picture over with. */
  encoder: string | null
  /** True while the file is being read. */
  reading: boolean
}

/** The Media information dialog for one track. */
export function MediaInfoDialog({ open, onClose, name, media, audioIndex, pictureShown, encoder, reading }: MediaInfoDialogProps): ReactElement
{
  const info = media === null ? null : mediaInfo(media, audioIndex, pictureShown, encoder)
  const actions = <Button onClick={onClose}>{PLAYER_COPY.close}</Button>
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={PLAYER_COPY.mediaInfo}
      description={name}
      size="md"
      closedBy="any"
      actions={actions}
    >
      {info === null
        ? <p className="text-body text-ink-2">{reading ? 'Reading the file…' : 'Media information is available for local files once they have been read.'}</p>
        : (
          <div className="flex flex-col gap-4" data-part="media-info">
            <section aria-labelledby="media-info-playing" className="flex flex-col gap-1.5 rounded-sm bg-sunken px-4 py-3 shadow-well">
              <h3 id="media-info-playing" className="text-body font-semibold text-ink">How it plays</h3>
              {info.playing.map((line) => <p key={line} className="max-w-[65ch] text-body text-ink-2">{line}</p>)}
              <Fold label="Paths and encoders" rows={info.routes} />
            </section>
            {info.sections.map((section) => (
              <section key={section.id} aria-labelledby={`media-info-${section.id}`} className="flex flex-col gap-1 border-t border-line pt-3">
                <h3 id={`media-info-${section.id}`} className="text-body font-semibold text-ink">{section.title}</h3>
                <p className="text-body text-ink-2">{section.summary}</p>
                <Fold label="Technical values" rows={section.rows} />
              </section>
            ))}
          </div>
        )}
    </Dialog>
  )
}

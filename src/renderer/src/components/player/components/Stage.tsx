/**
 * The stage: the visualization, or the picture when the source has one and Video is chosen, with subtitles over
 * either, and the page's quiet states over it: empty, loading, a problem, the drop target, and popped out.
 */

import { useEffect, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { Banner } from '../../../ui/Banner'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { Icon } from '../../../ui/Icon'
import { Kbd } from '../../../ui/Kbd'
import { PLAYER_COPY } from '../copy'
import type { PlayerEngine } from '../hooks/usePlayer'

/** Whole seconds since `since`, ticking once a second; 0 when nothing is timed. */
export function useElapsed(since: number | null): number
{
  const [now, setNow] = useState(() => Date.now())
  useEffect(() =>
  {
    if (since === null)
    {
      return undefined
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000))
}

/** How long a route note stays on the stage; Media information keeps the reason afterward. */
export const NOTE_MS = 6000

/** The note while it is fresh: each new note shows for {@link NOTE_MS}, then gives way to the picture. */
export function useFreshNote(note: string | null): string | null
{
  const [fresh, setFresh] = useState(note)
  useEffect(() =>
  {
    setFresh(note)
    if (note === null)
    {
      return undefined
    }
    const timer = setTimeout(() => setFresh(null), NOTE_MS)
    return () => clearTimeout(timer)
  }, [note])
  return fresh
}

/** A loading label with its elapsed time once it has taken a while: "Getting the sound stream through yt-dlp… (12 s)". */
export function timedLabel(label: string, elapsed: number): string
{
  return elapsed >= 3 ? `${label} (${elapsed} s)` : label
}

/** True when the stage shows the picture rather than the visualization. */
export function showsPicture(player: Pick<PlayerEngine, 'view' | 'picture' | 'poppedOut'>): boolean
{
  return player.view === 'video' && player.picture === 'showing' && !player.poppedOut
}

/** The empty playlist's first step: what to do, the two ways to add, and the keys. */
export function EmptyStage({ onAddFiles, onAddLink, compact = false }: { onAddFiles: () => void, onAddLink?: () => void, compact?: boolean }): ReactElement
{
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 pt-6 pb-[min(22vh,11rem)]" data-empty-state="player">
      <div className="flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <h2 className="text-section text-ink">{PLAYER_COPY.emptyHeading}</h2>
        {!compact && <p className="max-w-[65ch] text-body text-ink-2">{PLAYER_COPY.emptyLine}</p>}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="primary" icon="action.addFiles" onClick={onAddFiles}>{PLAYER_COPY.addFiles}</Button>
          {onAddLink !== undefined && <Button icon="player.addLink" onClick={onAddLink}>{PLAYER_COPY.addLink}</Button>}
          {!compact && (
            <span className="flex items-center gap-2 text-label text-ink-3">
              <Kbd keys={['Mod', 'O']} />
              <span aria-hidden="true">·</span>
              <Kbd keys={['Mod', 'U']} />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function Problem({ player }: { player: PlayerEngine }): ReactElement | null
{
  const [open, setOpen] = useState(false)
  const problem = player.problem
  if (problem === null)
  {
    return null
  }
  return (
    <div className="absolute inset-x-3 bottom-3 flex justify-center">
      <Banner tone="error" title={problem.message} onDismiss={player.dismissProblem} className="w-full max-w-[40rem]">
        {problem.detail !== null && (
          <div className="flex flex-col items-start gap-1">
            <button type="button" className="text-label text-ink-2 underline-offset-2 hover:text-ink hover:underline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {PLAYER_COPY.details}
            </button>
            {open && <code className="font-mono text-label break-all whitespace-pre-wrap text-ink-3">{problem.detail}</code>}
          </div>
        )}
      </Banner>
    </div>
  )
}

/** Props of {@link Stage}. */
export interface StageProps
{
  player: PlayerEngine
  canvasRef: RefObject<HTMLCanvasElement | null>
  dragging: boolean
  onAddFiles: () => void
  onAddLink?: () => void
  onBringBack?: () => void
  /** A double click on the stage, which toggles full screen. */
  onDoubleClick?: () => void
  compact?: boolean
  children?: ReactNode
}

/** The stage region. */
export function Stage({ player, canvasRef, dragging, onAddFiles, onAddLink, onBringBack, onDoubleClick, compact = false }: StageProps): ReactElement
{
  const picture = showsPicture(player)
  const empty = player.tracks.length === 0 && !player.poppedOut
  const loading = player.status === 'loading' || (player.view === 'video' && player.picture === 'loading')
  const elapsed = useElapsed(loading ? player.loadingSince : null)
  const soundNote = useFreshNote(player.soundNote)
  const pictureNote = useFreshNote(player.view === 'video' ? player.pictureNote : null)
  return (
    <section
      aria-label={PLAYER_COPY.stage}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-sunken"
      data-region="stage"
      data-view={picture ? 'video' : 'visualization'}
      onDoubleClick={(event) =>
      {
        if (onDoubleClick !== undefined && !(event.target as Element).closest('button, a, input, [role="dialog"]'))
        {
          onDoubleClick()
        }
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" className={cx('absolute inset-0 size-full', picture && 'invisible')} />
      <video ref={player.videoRef} aria-hidden="true" muted playsInline preload="auto" className={cx('absolute inset-0 size-full bg-sunken object-contain', !picture && 'invisible')} />
      <audio ref={player.audioRef} preload="auto" className="hidden" />
      {player.subtitleText !== '' && !player.poppedOut && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-6" data-part="subtitles">
          <p className="max-w-[48rem] rounded-sm bg-scrim px-3 py-1 text-center text-section font-normal whitespace-pre-line text-ink">{player.subtitleText}</p>
        </div>
      )}
      {empty && <EmptyStage onAddFiles={onAddFiles} onAddLink={onAddLink} compact={compact} />}
      {loading && !empty && (
        <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-sm bg-scrim px-3 py-1.5 text-label text-ink-2" role="status">
          <Icon name="status.active" size="sm" spin />
          <span>{timedLabel(player.loadingLabel ?? player.pictureProgress ?? 'Preparing the picture…', elapsed)}</span>
        </div>
      )}
      {(soundNote !== null || pictureNote !== null) && !loading && (
        <div className="pointer-events-none absolute top-3 left-3 flex max-w-[32rem] flex-col gap-0.5 rounded-sm bg-scrim px-3 py-1.5 text-label text-ink-2" role="status">
          {soundNote !== null && <span>{soundNote}</span>}
          {pictureNote !== null && <span>{pictureNote}</span>}
        </div>
      )}
      <Problem player={player} />
      {dragging && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-md bg-ground/92 px-6 text-center inset-ring inset-ring-accent-ink" data-drop-overlay="">
          <span className="flex text-accent-ink"><Icon name="action.addFiles" size="lg" /></span>
          <p className="text-section text-ink">{PLAYER_COPY.dropLine}</p>
          <p className="text-label text-ink-3">{PLAYER_COPY.dropHint}</p>
        </div>
      )}
      {player.poppedOut && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-sunken px-6 py-6" data-popped-out="">
          <div className="flex w-full max-w-2xl flex-col gap-3">
            <h2 className="text-section text-ink">{PLAYER_COPY.poppedOutHeading}</h2>
            <p className="max-w-[65ch] text-body text-ink-2">{PLAYER_COPY.poppedOutLine}</p>
            {onBringBack !== undefined && <Button icon="player.returnToApp" onClick={onBringBack}>{PLAYER_COPY.bringBack}</Button>}
          </div>
        </div>
      )}
    </section>
  )
}

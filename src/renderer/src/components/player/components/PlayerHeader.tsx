/**
 * The Player's toolbar: Add files (with Add folder), Add link, the Video or Visualization choice, the visualization
 * by name, the playlist toggle, Pop out, and the overflow menu with Media information, the link qualities, and the
 * keyboard shortcuts. Labels fold into icons with tooltips when the view is narrow.
 */

import { useLayoutEffect, useState, type ReactElement, type Ref, type RefObject } from 'react'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry, type MenuRadioItem } from '../../../ui/Menu'
import { SegmentedControl } from '../../../ui/SegmentedControl'
import { Select } from '../../../ui/Select'
import { SplitButton } from '../../../ui/SplitButton'
import type { VisMode } from '../../../visualizations/types'
import { PICTURE_QUALITY_NAMES, PLAYER_COPY, SOUND_QUALITY_NAMES, VIS_NAMES } from '../copy'
import type { PictureQuality, SoundQuality } from '../engine/links'
import type { StageView } from '../engine/snapshot'
import { VIS_ORDER, type PlayerEngine } from '../hooks/usePlayer'
import { AddLinkPopover } from './AddLinkPopover'

/** Widths of the header, in px, below which its labels fold away. */
export const HEADER_WIDTHS = Object.freeze({ labels: 900, caption: 1080 })

/** The width of an element, followed as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>): number | null
{
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() =>
  {
    const element = ref.current
    if (element === null)
    {
      return undefined
    }
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined')
    {
      return undefined
    }
    const observer = new ResizeObserver((entries) => setWidth(entries[entries.length - 1].contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** What the header calls on the page. */
export interface PlayerHeaderActions
{
  onAddFiles: () => void
  onAddFolder: () => void
  onShowInfo: () => void
  onShortcuts: () => void
  onTogglePlaylist: () => void
}

/** Props of {@link PlayerHeader}. */
export interface PlayerHeaderProps extends PlayerHeaderActions
{
  player: PlayerEngine
  width: number | null
  playlistShown: boolean
  linkTriggerRef: Ref<HTMLButtonElement>
  className?: string
}

/** The overflow menu's entries. */
export function moreEntries(player: Pick<PlayerEngine, 'current' | 'pictureQuality' | 'soundQuality' | 'setPictureQuality' | 'setSoundQuality'>, actions: Pick<PlayerHeaderActions, 'onShowInfo' | 'onShortcuts'>): MenuEntry[]
{
  const pictures = (Object.keys(PICTURE_QUALITY_NAMES) as PictureQuality[]).map((quality): MenuRadioItem => ({
    kind: 'radio',
    group: 'picture-quality',
    id: `picture-${quality}`,
    label: PICTURE_QUALITY_NAMES[quality],
    checked: player.pictureQuality === quality,
    onSelect: () => player.setPictureQuality(quality)
  }))
  const sounds = (Object.keys(SOUND_QUALITY_NAMES) as SoundQuality[]).map((quality): MenuRadioItem => ({
    kind: 'radio',
    group: 'sound-quality',
    id: `sound-${quality}`,
    label: SOUND_QUALITY_NAMES[quality],
    checked: player.soundQuality === quality,
    onSelect: () => player.setSoundQuality(quality)
  }))
  const local = player.current?.filePath !== undefined
  return [
    {
      id: 'info',
      label: PLAYER_COPY.mediaInfo,
      icon: 'player.mediaInfo',
      shortcut: 'Mod+I',
      disabled: !local,
      disabledReason: player.current === null ? 'Play a file first.' : 'Media information is for local files.',
      onSelect: actions.onShowInfo
    },
    'separator',
    { kind: 'submenu', id: 'picture-quality', label: PLAYER_COPY.pictureQuality, items: pictures },
    { kind: 'submenu', id: 'sound-quality', label: PLAYER_COPY.soundQuality, items: sounds },
    'separator',
    { id: 'shortcuts', label: PLAYER_COPY.shortcuts, icon: 'action.shortcuts', shortcut: 'F1', onSelect: actions.onShortcuts }
  ]
}

/** The Player's toolbar. */
export function PlayerHeader({ player, width, playlistShown, linkTriggerRef, className, onAddFiles, onAddFolder, onShowInfo, onShortcuts, onTogglePlaylist }: PlayerHeaderProps): ReactElement
{
  const labels = width === null || width >= HEADER_WIDTHS.labels
  const caption = width === null || width >= HEADER_WIDTHS.caption
  const empty = player.tracks.length === 0
  return (
    <header className={cx('flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-4', className)} data-region="player-toolbar">
      <h1 className="sr-only">{PLAYER_COPY.page}</h1>
      <SplitButton
        icon="action.addFiles"
        actionName={PLAYER_COPY.addFilesMore}
        items={[{ id: 'folder', label: PLAYER_COPY.addFolder, icon: 'action.addFolder', shortcut: 'Mod+Shift+O', onSelect: onAddFolder }]}
        onClick={onAddFiles}
        aria-keyshortcuts="Control+O"
      >
        {PLAYER_COPY.addFiles}
      </SplitButton>
      <AddLinkPopover onAdd={player.addLink} triggerRef={linkTriggerRef} iconOnly={!labels} />
      <div className="min-w-2 flex-1" />
      <div className="flex items-center gap-2">
        {caption && <span className="text-label text-ink-3" aria-hidden="true">{PLAYER_COPY.view}</span>}
        <SegmentedControl<StageView>
          label={PLAYER_COPY.view}
          value={player.canShowPicture ? player.view : 'visualization'}
          disabled={!player.canShowPicture}
          onChange={(value) => player.setView(value)}
          options={[
            { value: 'video', label: PLAYER_COPY.video, icon: 'player.video', description: 'Shows the picture when the track has one.' },
            { value: 'visualization', label: PLAYER_COPY.visualization, icon: 'player.visualization' }
          ]}
        />
      </div>
      <Select
        label={PLAYER_COPY.visualization}
        value={player.visMode}
        onChange={(value) => player.setVisMode(value as VisMode)}
        options={VIS_ORDER.map((mode) => ({ value: mode, label: VIS_NAMES[mode] }))}
        className="w-36 shrink-0"
      />
      <IconButton
        label={playlistShown ? PLAYER_COPY.hidePlaylist : PLAYER_COPY.showPlaylist}
        icon="player.playlist"
        pressed={playlistShown}
        disabled={empty}
        onClick={onTogglePlaylist}
      />
      {labels
        ? <Button icon="player.popout" onClick={player.popOut}>{PLAYER_COPY.popOut}</Button>
        : <IconButton label={PLAYER_COPY.popOut} icon="player.popout" onClick={player.popOut} />}
      <Menu
        label={PLAYER_COPY.more}
        items={moreEntries(player, { onShowInfo, onShortcuts })}
        align="end"
        trigger={<IconButton label={PLAYER_COPY.more} icon="action.more" />}
      />
    </header>
  )
}

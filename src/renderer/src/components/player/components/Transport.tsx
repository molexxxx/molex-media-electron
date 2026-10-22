/**
 * The transport: the position as lit readouts around a seek bar, previous, play or pause, and next with play as the
 * one primary, shuffle and repeat as pressed toggles, volume with mute, and the audio track and subtitle choices.
 * The compact form is the pop-out's: the title, the seek bar, and the buttons, nothing else.
 */

import { useState, type ReactElement } from 'react'
import { audioTracks, mediaWithSubtitles, shownSubtitles } from '../../../../../shared/player/media'
import { cx } from '../../../ui/cx'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { Slider } from '../../../ui/Slider'
import { PLAYER_COPY, REPEAT_NAMES, volumeText } from '../copy'
import { audioTrackName, decodeNote, subtitleTrackName, trackFacts } from '../engine/describe'
import type { PlayerEngine } from '../hooks/usePlayer'
import { formatTime } from '../types'

/** The seek bar's arrow and page steps, in seconds. */
export const SEEK_STEPS = Object.freeze({ arrow: 5, page: 30 })

/** The volume slider's arrow step, in percent. */
export const VOLUME_STEP = 5

/** "1:23 of 4:56", the seek bar's spoken value. */
export function positionText(time: number, duration: number): string
{
  return duration > 0 ? `${formatTime(time)} of ${formatTime(duration)}` : formatTime(time)
}

function Readout({ value, lit, align }: { value: string, lit: boolean, align: 'start' | 'end' }): ReactElement
{
  return (
    <span
      className={cx(
        'w-[4.5rem] shrink-0 font-display text-label font-semibold tabular-nums',
        align === 'end' ? 'text-end' : 'text-start',
        lit ? 'type-readout' : 'text-ink-disabled'
      )}
    >
      {value}
    </span>
  )
}

/**
 * The seek bar between the two lit readouts; dragging previews the position and the release seeks. A live stream
 * reads Live in place of its length and its bar stays disabled, since nothing past the live edge exists to move to.
 */
export function SeekBar({ player }: { player: PlayerEngine }): ReactElement
{
  const [scrub, setScrub] = useState<number | null>(null)
  const live = player.live && player.current !== null
  const loaded = player.current !== null && player.duration > 0 && !live
  const shown = scrub ?? player.time
  return (
    <div className="flex min-w-0 items-center gap-3" data-part="seek" data-live={live || undefined}>
      <Readout value={formatTime(shown)} lit={player.current !== null} align="end" />
      <Slider
        className="min-w-0 flex-1"
        label={live ? PLAYER_COPY.liveSeek : PLAYER_COPY.seek}
        value={live ? 1 : Math.min(shown, player.duration || 0)}
        min={0}
        max={!live && player.duration > 0 ? player.duration : 1}
        step={0.1}
        keyStep={SEEK_STEPS.arrow}
        bigStep={SEEK_STEPS.page}
        disabled={!loaded}
        valueText={(value) => live ? `${PLAYER_COPY.live}, ${formatTime(shown)} since joining` : positionText(value, player.duration)}
        onInput={(value) => setScrub(value)}
        onChange={(value) =>
        {
          setScrub(null)
          player.seek(value)
        }}
      />
      <Readout value={live ? PLAYER_COPY.live : formatTime(player.duration)} lit={player.current !== null && (live || player.duration > 0)} align="start" />
    </div>
  )
}

function volumeIcon(player: PlayerEngine): 'player.muted' | 'player.volumeLow' | 'player.volume'
{
  if (player.muted || player.volume === 0)
  {
    return 'player.muted'
  }
  return player.volume < 0.5 ? 'player.volumeLow' : 'player.volume'
}

/** Mute and the volume slider. */
export function VolumeControl({ player, compact = false }: { player: PlayerEngine, compact?: boolean }): ReactElement
{
  const silent = player.muted || player.volume === 0
  return (
    <div className="flex shrink-0 items-center gap-1" data-part="volume">
      <IconButton
        label={silent ? PLAYER_COPY.unmute : PLAYER_COPY.mute}
        icon={volumeIcon(player)}
        pressed={player.muted}
        shortcut="M"
        onClick={player.toggleMute}
      />
      <Slider
        className={compact ? 'w-16' : 'w-24'}
        label={PLAYER_COPY.volume}
        value={Math.round(player.volume * 100)}
        min={0}
        max={100}
        step={1}
        keyStep={VOLUME_STEP}
        bigStep={20}
        valueText={(value) => volumeText(value / 100)}
        onInput={(value) => player.setVolume(value / 100)}
        onChange={(value) => player.setVolume(value / 100)}
      />
    </div>
  )
}

/** The audio track and subtitle menus, shown only when the file offers a choice. */
export function TrackMenus({ player }: { player: PlayerEngine }): ReactElement | null
{
  const media = player.current?.media ?? null
  if (media === null)
  {
    return null
  }
  const sounds = audioTracks(media.streams)
  const subtitles = shownSubtitles(media.streams)
  const audioIndex = Math.min(player.current?.audioIndex ?? 0, Math.max(0, sounds.length - 1))
  const soundItems: MenuEntry[] = sounds.map((stream, i) => ({
    kind: 'radio',
    group: 'audio',
    id: `audio-${stream.index}`,
    label: audioTrackName(stream, i),
    checked: i === audioIndex,
    onSelect: () => player.selectAudio(i)
  }))
  const subtitleItems: MenuEntry[] = [
    { kind: 'radio', group: 'subtitles', id: 'subtitles-off', label: PLAYER_COPY.subtitlesOff, checked: player.subtitleIndex === null, onSelect: () => player.selectSubtitles(null) },
    ...subtitles.map((stream, i): MenuEntry => ({
      kind: 'radio',
      group: 'subtitles',
      id: `subtitles-${stream.index}`,
      label: subtitleTrackName(stream, i),
      checked: player.subtitleIndex === stream.index,
      onSelect: () => player.selectSubtitles(stream.index)
    }))
  ]
  return (
    <>
      {sounds.length > 1 && (
        <Menu
          label={PLAYER_COPY.audioTrack}
          items={soundItems}
          align="end"
          trigger={<IconButton label={`${PLAYER_COPY.audioTrack}: ${audioTrackName(sounds[audioIndex], audioIndex)}`} icon="player.audioTrack" />}
        />
      )}
      {subtitles.length > 0 && (
        <Menu
          label={PLAYER_COPY.subtitles}
          items={subtitleItems}
          align="end"
          trigger={<IconButton label={PLAYER_COPY.subtitles} icon="player.subtitles" pressed={player.subtitleIndex !== null} />}
        />
      )}
    </>
  )
}

/** Previous, play or pause, next, and the shuffle and repeat toggles. */
export function TransportButtons({ player, compact = false }: { player: PlayerEngine, compact?: boolean }): ReactElement
{
  const empty = player.tracks.length === 0
  const playing = player.status === 'playing' || player.status === 'loading'
  return (
    <div className={cx('flex items-center', compact ? 'gap-0.5' : 'gap-1')} data-part="buttons">
      <IconButton label={PLAYER_COPY.shuffle} icon="player.shuffle" pressed={player.shuffle} shortcut="S" onClick={player.toggleShuffle} />
      <IconButton label={PLAYER_COPY.previous} icon="player.previous" shortcut="P" disabled={empty} onClick={player.previous} />
      <IconButton
        label={playing ? PLAYER_COPY.pause : PLAYER_COPY.play}
        icon={playing ? 'player.pause' : 'player.play'}
        variant="primary"
        size={compact ? 'md' : 'lg'}
        shortcut="Space"
        disabled={empty}
        onClick={player.togglePlay}
      />
      <IconButton label={PLAYER_COPY.next} icon="player.next" shortcut="N" disabled={empty} onClick={player.next} />
      <IconButton
        label={REPEAT_NAMES[player.repeat]}
        icon={player.repeat === 'one' ? 'player.repeatOne' : 'player.repeat'}
        pressed={player.repeat !== 'off'}
        shortcut="R"
        onClick={player.cycleRepeat}
      />
    </div>
  )
}

/** The title and the short facts under it, with a note while something is converted for playback. */
export function NowPlaying({ player, compact = false }: { player: PlayerEngine, compact?: boolean }): ReactElement
{
  const current = player.current
  const facts = current === null ? null : trackFacts(current)
  const media = current?.media ? mediaWithSubtitles(current.media, player.subtitleIndex) : current?.media
  const note = current === null ? null : decodeNote(media, current.audioIndex ?? 0, player.picture === 'showing')
  return (
    <div className="flex min-w-0 flex-col" data-part="now-playing">
      <span className={cx('truncate font-semibold', compact ? 'text-label' : 'text-body', current === null ? 'text-ink-3' : 'text-ink')} title={current?.name}>
        {current?.name ?? PLAYER_COPY.nothingPlaying}
      </span>
      {!compact && (
        <span className="truncate text-label text-ink-3">
          {player.loadingLabel ?? [facts, note].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  )
}

/** What the transport needs for full screen. */
export interface TransportFullScreen
{
  on: boolean
  toggle: () => void
}

/** The main window's transport bar. */
export function Transport({ player, fullScreen, className }: { player: PlayerEngine, fullScreen: TransportFullScreen, className?: string }): ReactElement
{
  return (
    <section aria-label={PLAYER_COPY.transport} className={cx('flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel px-4 pt-2 pb-3', className)} data-region="transport">
      <SeekBar player={player} />
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4">
        <NowPlaying player={player} />
        <TransportButtons player={player} />
        <div className="flex min-w-0 items-center justify-end gap-1">
          <TrackMenus player={player} />
          <VolumeControl player={player} />
          <IconButton
            label={fullScreen.on ? PLAYER_COPY.exitFullScreen : PLAYER_COPY.fullScreen}
            icon={fullScreen.on ? 'player.exitFullScreen' : 'player.fullScreen'}
            pressed={fullScreen.on}
            shortcut="F11"
            onClick={fullScreen.toggle}
          />
        </div>
      </div>
    </section>
  )
}

/** The pop-out's transport: the title, the seek bar, then the buttons and volume. */
export function CompactTransport({ player, className }: { player: PlayerEngine, className?: string }): ReactElement
{
  return (
    <section aria-label={PLAYER_COPY.transport} className={cx('flex shrink-0 flex-col gap-1 border-t border-line bg-panel px-3 pt-2 pb-2', className)} data-region="transport">
      <NowPlaying player={player} compact />
      <SeekBar player={player} />
      <div className="flex items-center justify-between gap-2">
        <TransportButtons player={player} compact />
        <VolumeControl player={player} compact />
      </div>
    </section>
  )
}

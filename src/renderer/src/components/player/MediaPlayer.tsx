/**
 * @module components/player/MediaPlayer
 * @description The Player view and the pop-out's player. The view meets the window edges: the toolbar, the stage with
 * the playlist beside it, and the transport. The pop-out shows the stage, the title, and the transport only.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { useF6Region } from '../../hooks/useF6Region'
import { Splitter } from '../../ui/Splitter'
import { toast } from '../../ui/Toast'
import { ShortcutsPopover } from '../batch/page/ShortcutsPopover'
import { MediaInfoDialog } from './components/MediaInfoDialog'
import { PlayerHeader, useWidth } from './components/PlayerHeader'
import { PlaylistPanel, type PlaylistActions } from './components/PlaylistPanel'
import { showsPicture, Stage } from './components/Stage'
import { CompactTransport, Transport } from './components/Transport'
import { PLAYER_COPY } from './copy'
import { checkLink } from './engine/links'
import { useFullScreen } from './hooks/useFullScreen'
import { usePlayer, type PlayerEngine } from './hooks/usePlayer'
import { usePlayerDrop } from './hooks/usePlayerDrop'
import { PLAYER_SHORTCUTS, usePlayerKeys, type PlayerKeyHandlers } from './hooks/usePlayerKeys'
import { useVisualizer } from './hooks/useVisualizer'
import { isMediaPath } from './types'
import { cx } from '../../ui/cx'

/** The playlist panel's widths, in px. */
export const PLAYLIST_WIDTH = Object.freeze({ min: 240, default: 340, max: 640 })

/** The media files of a picked or dropped folder, in name order; the folder itself when it is a media file. */
export async function expandPaths(paths: readonly string[]): Promise<string[]>
{
  const out: string[] = []
  for (const path of paths)
  {
    if (isMediaPath(path))
    {
      out.push(path)
      continue
    }
    try
    {
      const listing = await window.api.browseDirectory(path)
      if (listing.success)
      {
        out.push(...listing.entries
          .filter((entry) => !entry.isDirectory && isMediaPath(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
          .map((entry) => entry.path))
      }
    }
    catch
    {
      continue
    }
  }
  return out
}

/**
 * The classes of the toolbar or transport in full screen: laid over the stage at the window's top or bottom edge,
 * on a translucent panel, fading out while the pointer rests; nothing in normal view.
 */
export function overlayClass(fullScreen: boolean, idle: boolean, edge: 'top' | 'bottom'): string | undefined
{
  if (!fullScreen)
  {
    return undefined
  }
  return cx(
    'absolute inset-x-0 z-10 bg-panel/92 transition-opacity duration-base',
    edge === 'top' ? 'top-0 border-b-0' : 'bottom-0 border-t-0',
    idle && 'invisible opacity-0'
  )
}

/** The keys' handlers for an engine and the page's own actions. */
function keyHandlers(player: PlayerEngine, page: { addFiles: () => void, addFolder: () => void, addLink: () => void, showInfo: () => void, shortcuts: () => void, fullScreen: () => void, escape: () => boolean }): PlayerKeyHandlers
{
  return {
    'full-screen': page.fullScreen,
    escape: page.escape,
    'toggle-play': () => player.togglePlay(),
    seek: (command) => command.kind === 'seek' && player.seekBy(command.by),
    volume: (command) => command.kind === 'volume' && player.setVolume(player.volume + command.by),
    mute: () => player.toggleMute(),
    next: () => player.next(),
    previous: () => player.previous(),
    shuffle: () => player.toggleShuffle(),
    repeat: () => player.cycleRepeat(),
    visualization: (command) => command.kind === 'visualization' && player.cycleVisMode(command.direction),
    view: () => player.canShowPicture && player.setView(player.view === 'video' ? 'visualization' : 'video'),
    'add-files': page.addFiles,
    'add-folder': page.addFolder,
    'add-link': page.addLink,
    'media-info': page.showInfo,
    shortcuts: page.shortcuts
  }
}

function useAdders(player: PlayerEngine): { addFiles: () => void, addFolder: () => void }
{
  const busy = useRef(false)
  const pick = useCallback(async (picker: () => Promise<string[]>): Promise<void> =>
  {
    if (busy.current)
    {
      return
    }
    busy.current = true
    try
    {
      const paths = await expandPaths(await picker())
      player.addPaths(paths)
    }
    finally
    {
      busy.current = false
    }
  }, [player])
  const addFiles = useCallback((): void =>
  {
    void pick(() => window.api.openFiles())
  }, [pick])
  const addFolder = useCallback((): void =>
  {
    void pick(async () =>
    {
      const folder = await window.api.openDirectory()
      return folder === null ? [] : [folder]
    })
  }, [pick])
  return { addFiles, addFolder }
}

function useDropInto(player: PlayerEngine, root: React.RefObject<HTMLElement | null>): boolean
{
  return usePlayerDrop(root, {
    onPaths: (paths) =>
    {
      void expandPaths(paths).then((media) => player.addPaths(media))
    },
    onLink: (text) =>
    {
      const checked = checkLink(text)
      if (checked.ok)
      {
        void player.addLink(checked.url, checked.kind)
      }
    }
  })
}

/** The pop-out's player: the stage, the title, and the transport. */
function PopoutPlayer({ player }: { player: PlayerEngine }): ReactElement
{
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(true)
  activeRef.current = !showsPicture(player)
  useVisualizer(canvasRef, player.analyserRef, player.visMode, activeRef)
  const { addFiles, addFolder } = useAdders(player)
  const dragging = useDropInto(player, rootRef)
  const fullScreen = useFullScreen(rootRef)
  usePlayerKeys(rootRef, keyHandlers(player, {
    addFiles,
    addFolder,
    addLink: () => undefined,
    showInfo: () => undefined,
    shortcuts: () => undefined,
    fullScreen: fullScreen.toggle,
    escape: () =>
    {
      if (!fullScreen.on)
      {
        return false
      }
      fullScreen.exit()
      return true
    }
  }), { anywhere: () => fullScreen.on })
  return (
    <div ref={rootRef} className={cx('relative flex h-full min-h-0 flex-col bg-ground', fullScreen.on && fullScreen.idle && 'cursor-none')} data-view="player-popout" data-full-screen={fullScreen.on || undefined}>
      <Stage player={player} canvasRef={canvasRef} dragging={dragging} onAddFiles={addFiles} onDoubleClick={fullScreen.toggle} compact />
      <CompactTransport player={player} className={overlayClass(fullScreen.on, fullScreen.idle, 'bottom')} />
    </div>
  )
}

/** The main window's Player view. */
function PlayerView({ player }: { player: PlayerEngine }): ReactElement
{
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const linkTriggerRef = useRef<HTMLButtonElement>(null)
  const regionRefs = {
    toolbar: useRef<HTMLElement | null>(null),
    stage: useRef<HTMLElement | null>(null),
    playlist: useRef<HTMLElement | null>(null),
    transport: useRef<HTMLElement | null>(null)
  }
  const activeRef = useRef(true)
  const [playlistShown, setPlaylistShown] = useState(true)
  const [playlistWidth, setPlaylistWidth] = useState<number>(PLAYLIST_WIDTH.default)
  const [infoFor, setInfoFor] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const fullScreen = useFullScreen(rootRef)
  const width = useWidth(rootRef)
  activeRef.current = !showsPicture(player)
  useVisualizer(canvasRef, player.analyserRef, player.visMode, activeRef)
  const { addFiles, addFolder } = useAdders(player)
  const dragging = useDropInto(player, rootRef)
  const openLink = useCallback((): void => linkTriggerRef.current?.click(), [])
  const showInfo = useCallback((id?: string): void =>
  {
    const target = id ?? player.current?.id ?? null
    const track = player.tracks.find((candidate) => candidate.id === target)
    if (!track || track.filePath === undefined)
    {
      return
    }
    setInfoFor(track.id)
    void player.inspect(track.id)
  }, [player])

  usePlayerKeys(rootRef, keyHandlers(player, {
    addFiles,
    addFolder,
    addLink: openLink,
    showInfo: () => showInfo(),
    shortcuts: () => setShortcutsOpen(true),
    fullScreen: fullScreen.toggle,
    escape: () =>
    {
      if (!fullScreen.on)
      {
        return false
      }
      fullScreen.exit()
      return true
    }
  }), { anywhere: () => fullScreen.on })

  useLayoutEffect(() =>
  {
    const root = rootRef.current
    regionRefs.toolbar.current = root?.querySelector('[data-region="player-toolbar"]') ?? null
    regionRefs.stage.current = root?.querySelector('[data-region="stage"]') ?? null
    regionRefs.playlist.current = root?.querySelector('[data-region="playlist"]') ?? null
    regionRefs.transport.current = root?.querySelector('[data-region="transport"]') ?? null
  })
  useF6Region('player', [
    { name: 'Toolbar', ref: regionRefs.toolbar },
    { name: PLAYER_COPY.stage, ref: regionRefs.stage },
    { name: PLAYER_COPY.playlist, ref: regionRefs.playlist },
    { name: PLAYER_COPY.transport, ref: regionRefs.transport }
  ])

  const actions: PlaylistActions = {
    onShowInfo: (id) => showInfo(id),
    onShowInFolder: (path) => void window.api.showInFolder(path),
    onCopyLink: (url) =>
    {
      void navigator.clipboard.writeText(url).then(() => toast.show({ tone: 'success', title: PLAYER_COPY.copied }))
    }
  }

  const infoTrack = infoFor === null ? null : player.tracks.find((track) => track.id === infoFor) ?? null
  const infoIsCurrent = infoTrack !== null && infoTrack.id === player.current?.id
  const panelShown = playlistShown && player.tracks.length > 0 && !player.poppedOut && !fullScreen.on
  const hidden = fullScreen.on && fullScreen.idle
  const maxPanel = Math.max(PLAYLIST_WIDTH.min, Math.min(PLAYLIST_WIDTH.max, (width ?? 1200) - 360))

  return (
    <div
      ref={rootRef}
      id="player-view"
      className={cx('relative flex h-full min-h-0 min-w-0 flex-col bg-ground', hidden && 'cursor-none')}
      data-view="player"
      data-full-screen={fullScreen.on || undefined}
    >
      <PlayerHeader
        className={overlayClass(fullScreen.on, hidden, 'top')}
        player={player}
        width={width}
        playlistShown={panelShown}
        linkTriggerRef={linkTriggerRef}
        onAddFiles={addFiles}
        onAddFolder={addFolder}
        onShowInfo={() => showInfo()}
        onShortcuts={() => setShortcutsOpen(true)}
        onTogglePlaylist={() => setPlaylistShown((shown) => !shown)}
      />
      <div className="flex min-h-0 flex-1">
        <Stage
          player={player}
          canvasRef={canvasRef}
          dragging={dragging}
          onAddFiles={addFiles}
          onAddLink={openLink}
          onBringBack={() => void window.api.returnPlayerToApp()}
          onDoubleClick={fullScreen.toggle}
        />
        {panelShown && (
          <>
            <Splitter
              label="Playlist width"
              value={Math.min(playlistWidth, maxPanel)}
              min={PLAYLIST_WIDTH.min}
              max={maxPanel}
              pane="after"
              defaultValue={PLAYLIST_WIDTH.default}
              onChange={setPlaylistWidth}
            />
            <PlaylistPanel player={player} actions={actions} className="shrink-0 border-s border-line" style={{ width: Math.min(playlistWidth, maxPanel) }} />
          </>
        )}
      </div>
      <Transport player={player} fullScreen={fullScreen} className={overlayClass(fullScreen.on, hidden, 'bottom')} />
      <MediaInfoDialog
        open={infoTrack !== null}
        onClose={() => setInfoFor(null)}
        name={infoTrack?.name ?? ''}
        media={infoTrack?.media ?? null}
        audioIndex={infoTrack?.audioIndex ?? 0}
        pictureShown={infoIsCurrent && showsPicture(player)}
        encoder={infoIsCurrent ? player.pictureEncoder : null}
        reading={infoTrack !== null && infoTrack.media === undefined}
      />
      <ShortcutsPopover open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} groups={PLAYER_SHORTCUTS} />
    </div>
  )
}

/** The Player: the main window's view, or the pop-out's compact player. */
export default function MediaPlayer({ popout = false }: { popout?: boolean }): ReactElement
{
  const player = usePlayer({ popout })
  return popout ? <PopoutPlayer player={player} /> : <PlayerView player={player} />
}

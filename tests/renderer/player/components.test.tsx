/**
 * The Player's pieces as rendered: the empty state, the toolbar's named controls, the transport's readouts and
 * toggles, the playlist grid with the playing mark, the Media information dialog, and the pop-out's caption.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { PlayerMedia } from '../../../src/shared/player/media'
import MediaPlayer from '@renderer/components/player/MediaPlayer'
import { PLAYLIST_COLUMNS, PlaylistPanel, targetIds } from '@renderer/components/player/components/PlaylistPanel'
import { CompactTransport, positionText, Transport } from '@renderer/components/player/components/Transport'
import { MediaInfoDialog } from '@renderer/components/player/components/MediaInfoDialog'
import { moreEntries } from '@renderer/components/player/components/PlayerHeader'
import { EmptyStage, showsPicture } from '@renderer/components/player/components/Stage'
import { PopoutShell, presetFor, sizeEntries } from '@renderer/components/layout/components/PopoutShell'
import type { PlayerEngine } from '@renderer/components/player/hooks/usePlayer'
import { dropKind, droppedLink } from '@renderer/components/player/hooks/usePlayerDrop'
import { useFullScreen, HIDE_AFTER_MS } from '@renderer/components/player/hooks/useFullScreen'
import { useAppStore } from '@renderer/stores/appStore'

const api = vi.hoisted(() => ({
  isPopout: vi.fn(async () => false),
  onReceivePlayerState: vi.fn(() => () => undefined),
  onPopoutClosed: vi.fn(() => () => undefined),
  getPlayerState: vi.fn(async () => null),
  isFullScreen: vi.fn(async () => false),
  onFullScreenChanged: vi.fn(() => () => undefined),
  onLinkProgress: vi.fn(() => () => undefined),
  setFullScreen: vi.fn(async (on: boolean) => on),
  isPinned: vi.fn(async () => true),
  togglePin: vi.fn(async () => false),
  getPopoutSize: vi.fn(async () => ({ width: 420, height: 560 })),
  resizePopout: vi.fn(async () => undefined),
  returnPlayerToApp: vi.fn(async () => undefined),
  windowMinimize: vi.fn(),
  windowClose: vi.fn(),
  getUrlHistory: vi.fn(async () => []),
  removeUrlHistory: vi.fn(async () => []),
  openFiles: vi.fn(async () => []),
  openDirectory: vi.fn(async () => null),
  showInFolder: vi.fn(async () => undefined),
  getFilePath: vi.fn(() => '')
}))

const media: PlayerMedia = {
  path: 'C:/clips/a.mkv',
  container: 'matroska,webm',
  containerName: 'Matroska / WebM',
  duration: 30,
  startTime: 0,
  bitRate: 4_000_000,
  size: 15_000_000,
  streams: [
    { index: 0, kind: 'video', codec: 'mpeg2video', profile: 'Main', level: 8, language: null, title: null, isDefault: true, bitRate: null, sampleRate: null, channels: null, layout: null, bitDepth: null, width: 720, height: 576, frameRate: 25, pixelFormat: 'yuv420p', colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null },
    { index: 1, kind: 'audio', codec: 'mp2', profile: null, level: null, language: 'eng', title: null, isDefault: true, bitRate: 192_000, sampleRate: 48000, channels: 2, layout: 'stereo', bitDepth: null, width: null, height: null, frameRate: null, pixelFormat: null, colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null },
    { index: 2, kind: 'audio', codec: 'ac3', profile: null, level: null, language: 'ger', title: 'Deutsch', isDefault: false, bitRate: 384_000, sampleRate: 48000, channels: 6, layout: '5.1(side)', bitDepth: null, width: null, height: null, frameRate: null, pixelFormat: null, colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null },
    { index: 3, kind: 'subtitle', codec: 'subrip', profile: null, level: null, language: 'eng', title: null, isDefault: false, bitRate: null, sampleRate: null, channels: null, layout: null, bitDepth: null, width: null, height: null, frameRate: null, pixelFormat: null, colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null }
  ],
  picture: { route: 'convert', streamIndex: 0, reason: 'codec' },
  sound: [
    { route: 'convert', audioIndex: 0, streamIndex: 1, target: 'opus', remappedTo: null },
    { route: 'convert', audioIndex: 1, streamIndex: 2, target: 'opus', remappedTo: '5.1' }
  ]
}

function fakeEngine(over: Partial<PlayerEngine> = {}): PlayerEngine
{
  const tracks = [
    { id: 'a', name: 'Opening theme.flac', src: '', isBlob: false, filePath: 'C:/m/Opening theme.flac', duration: 212 },
    { id: 'b', name: 'a.mkv', src: '', isBlob: false, filePath: media.path, duration: 30, media, audioIndex: 1 },
    { id: 'c', name: 'Live set', src: '', isBlob: false, videoUrl: 'https://youtu.be/x' }
  ]
  return {
    audioRef: { current: null },
    videoRef: { current: null },
    analyserRef: { current: null },
    tracks,
    current: tracks[1],
    status: 'playing',
    loadingLabel: null,
    problem: null,
    time: 65,
    duration: 30,
    volume: 0.3,
    muted: false,
    shuffle: true,
    repeat: 'one',
    visMode: 'bars',
    view: 'video',
    picture: 'showing',
    pictureNote: null,
    soundNote: null,
    pictureProgress: null,
    loadingSince: null,
    pictureEncoder: 'h264_nvenc',
    soundQuality: 'best',
    pictureQuality: 'auto',
    subtitleIndex: null,
    subtitleText: '',
    poppedOut: false,
    canShowPicture: true,
    addPaths: vi.fn(() => 0),
    addLink: vi.fn(async () => ({ ok: true as const, count: 1 })),
    playId: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    seek: vi.fn(),
    seekBy: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    setVisMode: vi.fn(),
    cycleVisMode: vi.fn(),
    setView: vi.fn(),
    setSoundQuality: vi.fn(),
    setPictureQuality: vi.fn(),
    selectAudio: vi.fn(),
    selectSubtitles: vi.fn(),
    removeIds: vi.fn(),
    moveIds: vi.fn(),
    dropIds: vi.fn(),
    clear: vi.fn(),
    dismissProblem: vi.fn(),
    inspect: vi.fn(async () => null),
    snapshot: vi.fn(),
    popOut: vi.fn(),
    ...over
  }
}

describe('Player components', () =>
{
  beforeEach(() =>
  {
    Object.assign(window, { api })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() =>
  {
    vi.restoreAllMocks()
    useAppStore.setState({ fullscreen: false })
  })

  it('renders the empty Player with its named controls and one centered column', () =>
  {
    render(<MediaPlayer />)
    expect(screen.getByRole('heading', { name: 'Add files or a link to start listening' })).toBeInTheDocument()
    const empty = document.querySelector('[data-empty-state="player"] > div') as HTMLElement
    expect(empty.className).toContain('max-w-2xl')
    expect(empty.className).not.toContain('items-start')
    expect(screen.getAllByRole('button', { name: 'Add files' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Add link' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Pop out' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More player options' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Visualization' })).toHaveValue('dmt')
    expect(screen.getByRole('radiogroup', { name: 'Show' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument()
    expect(screen.queryByRole('grid')).toBeNull()
    for (const button of screen.getAllByRole('button').filter((candidate) => !candidate.classList.contains('ui-select-button')))
    {
      expect(button).toHaveAccessibleName()
      expect(button).not.toHaveAttribute('title')
    }
  })

  it('draws the transport with lit readouts, the one primary, pressed toggles, and track menus', () =>
  {
    const player = fakeEngine()
    render(<Transport player={player} fullScreen={{ on: false, toggle: vi.fn() }} />)
    expect(screen.getByText('1:05').className).toContain('type-readout')
    expect(screen.getByText('0:30').className).toContain('type-readout')
    expect(screen.getByRole('slider', { name: 'Position' })).toHaveAttribute('aria-valuetext', '0:30 of 0:30')
    expect(positionText(5, 0)).toBe('0:05')
    const pause = screen.getByRole('button', { name: 'Pause' })
    expect(pause).toHaveAttribute('data-variant', 'primary')
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Repeat: this track' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveAttribute('aria-valuetext', '30 percent')
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    expect(player.toggleMute).toHaveBeenCalled()
    fireEvent.click(pause)
    expect(player.togglePlay).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Audio track: Deutsch/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Subtitles' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('a.mkv')).toBeInTheDocument()
    expect(screen.getByText(/Picture and sound decoded by FFmpeg/)).toBeInTheDocument()
  })

  it('draws the compact transport with the title and no facts, and the muted state', () =>
  {
    render(<CompactTransport player={fakeEngine({ muted: true, status: 'paused' })} />)
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.queryByText(/decoded by FFmpeg/)).toBeNull()
  })

  it('lists the playlist on the grid with the playing mark, lengths, and a row menu', () =>
  {
    const player = fakeEngine()
    const actions = { onShowInfo: vi.fn(), onShowInFolder: vi.fn(), onCopyLink: vi.fn() }
    render(<PlaylistPanel player={player} actions={actions} />)
    expect(PLAYLIST_COLUMNS.map((column) => column.id)).toEqual(['position', 'title', 'length', 'actions'])
    expect(screen.getByRole('heading', { name: 'Playlist' })).toBeInTheDocument()
    expect(screen.getByText('3 tracks · 4:02+')).toBeInTheDocument()
    const grid = screen.getByRole('grid', { name: 'Playlist' })
    const rows = within(grid).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(within(rows[1]).getByText('Playing')).toBeInTheDocument()
    expect(within(rows[1]).getByText('a.mkv').className).toContain('text-accent-ink')
    expect(within(rows[0]).getByText('3:32')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('button', { name: 'More actions for Opening theme.flac' })).toBeInTheDocument()
    fireEvent.keyDown(rows[0], { key: 'Enter' })
    expect(player.playId).toHaveBeenCalledWith('a')
    fireEvent.keyDown(rows[0], { key: 'Delete' })
    expect(player.removeIds).toHaveBeenCalledWith(['a'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear playlist' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(player.clear).toHaveBeenCalled()
    expect(targetIds('b', new Set(['a', 'b']), ['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(targetIds('c', new Set(['a', 'b']), ['a', 'b', 'c'])).toEqual(['c'])
  })

  it('shows Media information with how it plays first and the values folded under each stream', () =>
  {
    render(<MediaInfoDialog open onClose={vi.fn()} name="a.mkv" media={media} audioIndex={1} pictureShown encoder="h264_nvenc" reading={false} />)
    const dialog = screen.getByRole('dialog', { name: 'Media information' })
    expect(within(dialog).getByText(/Picture: decoded by FFmpeg, because Chromium has no decoder for MPEG-2 video/)).toBeInTheDocument()
    expect(within(dialog).getByText(/NVIDIA hardware encoder \(h264_nvenc\)/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Sound: decoded by FFmpeg from Dolby Digital/)).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: 'Audio 2' })).toBeInTheDocument()
    expect(within(dialog).getByText('Dolby Digital (AC-3) · 5.1 · 48 kHz · German')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Decoded by FFmpeg')).toHaveLength(2)
    expect(within(dialog).getAllByText('Technical values')).toHaveLength(5)
    render(<MediaInfoDialog open onClose={vi.fn()} name="x" media={null} audioIndex={0} pictureShown={false} encoder={null} reading />)
    expect(screen.getByText('Reading the file…')).toBeInTheDocument()
  })

  it('offers Media information, the link qualities, and the shortcuts from the overflow menu', () =>
  {
    const player = fakeEngine()
    const entries = moreEntries(player, { onShowInfo: vi.fn(), onShortcuts: vi.fn() })
    expect(entries.map((entry) => typeof entry === 'string' ? entry : entry.id)).toEqual(['info', 'separator', 'picture-quality', 'sound-quality', 'separator', 'shortcuts'])
    const noFile = moreEntries(fakeEngine({ current: null }), { onShowInfo: vi.fn(), onShortcuts: vi.fn() })[0]
    expect(noFile).toMatchObject({ disabled: true, disabledReason: 'Play a file first.' })
    const picture = entries[2] as { kind: 'submenu', items: Array<{ checked?: boolean, onSelect: () => void }> }
    expect(picture.items[0].checked).toBe(true)
    picture.items[2].onSelect()
    expect(player.setPictureQuality).toHaveBeenCalledWith('720p')
  })

  it('decides when the stage shows the picture and reads drops', () =>
  {
    expect(showsPicture({ view: 'video', picture: 'showing', poppedOut: false })).toBe(true)
    expect(showsPicture({ view: 'visualization', picture: 'showing', poppedOut: false })).toBe(false)
    expect(showsPicture({ view: 'video', picture: 'loading', poppedOut: false })).toBe(false)
    expect(showsPicture({ view: 'video', picture: 'showing', poppedOut: true })).toBe(false)
    render(<EmptyStage onAddFiles={vi.fn()} compact />)
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull()
    expect(dropKind({ types: ['Files'] })).toBe('files')
    expect(dropKind({ types: ['text/uri-list'] })).toBe('link')
    expect(dropKind({ types: ['text/html'] })).toBeNull()
    expect(dropKind(null)).toBeNull()
    expect(droppedLink('# comment\nhttps://youtu.be/x\nhttps://other')).toBe('https://youtu.be/x')
    expect(droppedLink('hello')).toBeNull()
  })

  it('names the pop-out\'s size presets and caption controls', async () =>
  {
    expect(presetFor(420, 560)).toBe('medium')
    expect(presetFor(400, 400)).toBeNull()
    const apply = vi.fn()
    const remember = vi.fn()
    const entries = sizeEntries('small', apply, remember)
    expect(entries.map((entry) => typeof entry === 'string' ? entry : entry.label)).toEqual(['Small', 'Medium', 'Large', 'separator', 'Remember this size'])
    render(<PopoutShell />)
    expect(await screen.findByRole('button', { name: 'Stop keeping on top' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Window size' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the app' }))
    expect(api.returnPlayerToApp).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('data-variant', 'danger')
    expect(screen.getByText('Player')).toBeInTheDocument()
  })

  it('tracks full screen and hides the controls after the pointer rests', async () =>
  {
    vi.useFakeTimers()
    let state: ReturnType<typeof useFullScreen> | null = null
    function Probe(): React.JSX.Element
    {
      const ref = React.useRef<HTMLDivElement>(null)
      state = useFullScreen(ref, HIDE_AFTER_MS)
      return <div ref={ref} data-testid="root" />
    }
    render(<Probe />)
    await vi.advanceTimersByTimeAsync(0)
    expect(state!.on).toBe(false)
    React.act(() => state!.toggle())
    await vi.advanceTimersByTimeAsync(0)
    expect(api.setFullScreen).toHaveBeenCalledWith(true)
    expect(state!.on).toBe(true)
    expect(useAppStore.getState().fullscreen).toBe(true)
    useAppStore.getState().setView('batch')
    expect(useAppStore.getState().currentView).not.toBe('batch')
    expect(state!.idle).toBe(false)
    await vi.advanceTimersByTimeAsync(HIDE_AFTER_MS + 10)
    expect(state!.idle).toBe(true)
    React.act(() => { fireEvent.pointerMove(screen.getByTestId('root')) })
    expect(state!.idle).toBe(false)
    React.act(() => state!.exit())
    await vi.advanceTimersByTimeAsync(0)
    expect(state!.on).toBe(false)
    vi.useRealTimers()
  })
})

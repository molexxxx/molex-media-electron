import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JOB_CHANNELS } from '../../src/shared/jobs/contract'
import { MEDIA_EXTENSIONS } from '../../src/shared/jobs/extensions'

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  windows: [] as unknown[],
  fromId: new Map<number, unknown>(),
  showMessageBox: (..._a: unknown[]): Promise<{ response: number }> => Promise.resolve({ response: 0 }),
  messageBoxes: [] as unknown[][],
  notifications: [] as Array<{ options: unknown; handlers: Map<string, () => void>; shown: boolean }>,
  notificationsSupported: true,
  blockerStarted: [] as string[],
  blockerStopped: [] as number[],
  trashed: [] as string[],
  revealed: [] as string[],
  clipboard: { formats: [] as string[], text: '', buffers: new Map<string, Buffer>(), reads: new Map<string, string>() },
  inspect: (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  inspectCalls: [] as unknown[][],
  download: (..._a: unknown[]): Promise<unknown> => Promise.resolve({ ffmpeg: '', ffprobe: '' }),
  config: {} as Record<string, unknown>,
  savedFfmpeg: [] as unknown[],
  savedJobs: [] as unknown[],
  dirs: { root: '', legacy: '' },
  remembered: [] as unknown[],
  gpu: (..._a: unknown[]): Promise<unknown> => Promise.resolve({ vendor: null, name: null, encoders: [] }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

vi.mock('electron', () =>
{
  class FakeNotification
  {
    static isSupported(): boolean
    {
      return m.notificationsSupported
    }

    handlers = new Map<string, () => void>()
    record: { options: unknown; handlers: Map<string, () => void>; shown: boolean }

    constructor(options: unknown)
    {
      this.record = { options, handlers: this.handlers, shown: false }
      m.notifications.push(this.record)
    }

    on(event: string, fn: () => void): this
    {
      this.handlers.set(event, fn)
      return this
    }

    show(): void
    {
      this.record.shown = true
    }
  }
  return {
    app: {
      getPath: vi.fn(() => '/tmp/test-app'),
      getName: vi.fn(() => 'molex-media'),
      getVersion: vi.fn(() => '3.0.0'),
      quit: vi.fn(),
      isPackaged: true
    },
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => m.handlers.set(channel, fn)),
      removeHandler: vi.fn((channel: string) => m.handlers.delete(channel)),
      on: vi.fn()
    },
    BrowserWindow: {
      getAllWindows: () => m.windows,
      fromWebContents: (contents: { window?: unknown }) => contents.window ?? null
    },
    webContents: { fromId: (id: number) => m.fromId.get(id) },
    dialog: {
      showMessageBox: (...a: unknown[]) =>
      {
        m.messageBoxes.push(a)
        return m.showMessageBox(...a)
      },
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },
    clipboard: {
      availableFormats: () => m.clipboard.formats,
      read: (format: string) => m.clipboard.reads.get(format) ?? '',
      readBuffer: (format: string) => m.clipboard.buffers.get(format) ?? Buffer.alloc(0),
      readText: () => m.clipboard.text
    },
    nativeImage: { createFromPath: vi.fn(() => ({ icon: true })) },
    Notification: FakeNotification,
    powerSaveBlocker: {
      start: (type: string) =>
      {
        m.blockerStarted.push(type)
        return 11
      },
      stop: (id: number) => m.blockerStopped.push(id),
      isStarted: () => true
    },
    shell: {
      trashItem: async (file: string) =>
      {
        m.trashed.push(file)
      },
      showItemInFolder: (file: string) => m.revealed.push(file)
    }
  }
})

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('../../src/main/logger', () => ({
  logger: { ...m.log, child: () => ({ ...m.log, child: () => m.log }) }
}))

vi.mock('../../src/main/config', () => ({
  getConfig: async () => m.config,
  getFFmpegRoot: () => m.dirs.root,
  getFFmpegBinDir: () => m.dirs.legacy,
  saveFfmpegConfig: async (block: unknown) =>
  {
    m.savedFfmpeg.push(block)
    m.config = { ...m.config, ffmpeg: block }
  },
  saveJobsConfig: async (patch: Record<string, unknown>) =>
  {
    m.savedJobs.push(patch)
    return { ...(m.config['jobs'] as object), ...patch }
  },
  takeJobsAlerts: async () => ['replace-migrated']
}))

vi.mock('../../src/main/ffmpeg/bootstrap', () => ({
  inspectBuild: (...a: unknown[]) =>
  {
    m.inspectCalls.push(a)
    return m.inspect(...a)
  },
  downloadFFmpeg: (...a: unknown[]) => m.download(...a)
}))

vi.mock('../../src/main/ffmpeg/gpu', () => ({
  detectGpuSummary: (...a: unknown[]) => m.gpu(...a),
  resetGpuDetection: vi.fn()
}))

vi.mock('../../src/main/ytdlp/binary', () => ({ initFFmpegDir: vi.fn(async () => undefined) }))
vi.mock('../../src/main/ipc/system', () => ({ rememberBuild: (info: unknown) => m.remembered.push(info) }))

import { JOB_COMMAND_NAMES, registerJobsIPC, senderInfo } from '../../src/main/ipc/jobs'
import * as host from '../../src/main/ipc/jobs-host'
import { SELF_TEST_IDS, SELF_TEST_REV, type BuildCandidate, type FfmpegBuildInfo, type SelfTestId } from '../../src/main/ffmpeg/build'

const DEV = 'http://localhost:5173'

interface FakeFrame
{
  url: string
  parent: FakeFrame | null
}

function frame(url: string, parent: FakeFrame | null = null): FakeFrame
{
  return { url, parent }
}

function event(senderFrame: FakeFrame | null, id = 7): unknown
{
  return { senderFrame, sender: { id } }
}

describe('registerJobsIPC', () =>
{
  const command = vi.fn(async () => ({ ok: true, value: 'answered' }))
  const logUnexpected = vi.fn()
  let dispose: () => void

  beforeEach(() =>
  {
    m.handlers.clear()
    command.mockClear()
    logUnexpected.mockClear()
    dispose = registerJobsIPC({ command } as never, { rendererLocation: () => ({ kind: 'dev', origin: DEV }), logUnexpected }, 'win32')
  })

  afterEach(() =>
  {
    dispose()
  })

  it('registers every command channel once', () =>
  {
    expect([...m.handlers.keys()].sort()).toEqual(Object.values(JOB_CHANNELS).sort())
    expect(JOB_COMMAND_NAMES).toHaveLength(Object.keys(JOB_CHANNELS).length)
  })

  it('passes a trusted main frame and the sender id to the engine', async () =>
  {
    const reply = await m.handlers.get(JOB_CHANNELS.subscribe)!(event(frame(`${DEV}/#popout`), 42), { clientId: 'c1' })
    expect(reply).toEqual({ ok: true, value: 'answered' })
    expect(command).toHaveBeenCalledWith('subscribe', { clientId: 'c1' }, { senderId: 42 })
  })

  it('refuses a missing frame before validation', async () =>
  {
    const reply = await m.handlers.get(JOB_CHANNELS.subscribe)!(event(null), { clientId: 'c1' }) as { ok: boolean; error: { code: string } }
    expect(reply.ok).toBe(false)
    expect(reply.error.code).toBe('untrusted-sender')
    expect(command).not.toHaveBeenCalled()
  })

  it('refuses a subframe of the app and a foreign origin', async () =>
  {
    const sub = await m.handlers.get(JOB_CHANNELS.get)!(event(frame(DEV, frame(DEV))), { jobId: 'MM-0001' }) as { error: { code: string } }
    const foreign = await m.handlers.get(JOB_CHANNELS.get)!(event(frame('https://example.com/')), { jobId: 'MM-0001' }) as { error: { code: string } }
    expect(sub.error.code).toBe('untrusted-sender')
    expect(foreign.error.code).toBe('untrusted-sender')
    expect(command).not.toHaveBeenCalled()
  })

  it('answers an invalid payload without calling the engine', async () =>
  {
    const reply = await m.handlers.get(JOB_CHANNELS.subscribe)!(event(frame(DEV)), { clientId: 5 }) as { ok: boolean; error: { code: string } }
    expect(reply.error.code).toBe('invalid-payload')
    expect(command).not.toHaveBeenCalled()
  })

  it('answers a throwing engine with internal and logs it', async () =>
  {
    command.mockRejectedValueOnce(new Error('boom'))
    const reply = await m.handlers.get(JOB_CHANNELS.subscribe)!(event(frame(DEV)), { clientId: 'c1' }) as { error: { code: string } }
    expect(reply.error.code).toBe('internal')
    expect(logUnexpected).toHaveBeenCalledWith('subscribe', expect.any(Error))
  })

  it('removes every handler it registered', () =>
  {
    dispose()
    expect(m.handlers.size).toBe(0)
    dispose = () => undefined
  })
})

describe('senderInfo', () =>
{
  it('reads the frame url, the main-frame flag, and the sender id', () =>
  {
    expect(senderInfo(event(frame('file:///C:/app/index.html'), 3) as never)).toEqual({ frameUrl: 'file:///C:/app/index.html', isMainFrame: true, senderId: 3 })
    expect(senderInfo(event(frame('x', frame('y')), 3) as never).isMainFrame).toBe(false)
  })

  it('treats a missing frame as no url and no main frame', () =>
  {
    expect(senderInfo(event(null, 9) as never)).toEqual({ frameUrl: null, isMainFrame: false, senderId: 9 })
    expect(senderInfo({ senderFrame: undefined, sender: { id: 1 } } as never).isMainFrame).toBe(false)
  })
})

describe('renderer location and windows', () =>
{
  it('trusts the packaged index.html as a file URL', () =>
  {
    const url = host.rendererIndexUrl(path.join(os.tmpdir(), 'app', 'out', 'main'))
    expect(url.startsWith('file:///')).toBe(true)
    expect(url.endsWith('/app/out/renderer/index.html')).toBe(true)
    expect(host.jobsRendererLocation()).toEqual({ kind: 'file', url: host.rendererIndexUrl() })
  })

  it('tells the popout from the main window', () =>
  {
    expect(host.isPopoutUrl('file:///C:/app/index.html#popout')).toBe(true)
    expect(host.isPopoutUrl(`${DEV}/#popout`)).toBe(true)
    expect(host.isPopoutUrl(`${DEV}/`)).toBe(false)
    expect(host.isPopoutUrl('not a url')).toBe(false)
    const popout = { isDestroyed: () => false, webContents: { getURL: () => `${DEV}/#popout` } }
    const main = { isDestroyed: () => false, webContents: { getURL: () => `${DEV}/` } }
    m.windows = [popout, main]
    expect(host.findMainWindow()).toBe(main)
    m.windows = [popout]
    expect(host.findMainWindow()).toBeNull()
  })

  it('parents to the sending window only while it lives', () =>
  {
    const win = { isDestroyed: () => false }
    expect(host.parentWindowOf({ isDestroyed: () => false, window: win } as never)).toBe(win)
    expect(host.parentWindowOf({ isDestroyed: () => true, window: win } as never)).toBeNull()
    expect(host.parentWindowOf(null)).toBeNull()
    expect(host.parentWindowOf({ isDestroyed: () => false, window: { isDestroyed: () => true } } as never)).toBeNull()
  })
})

describe('dialogs', () =>
{
  it('never opens a second picker while one is open', async () =>
  {
    let release: (value: string[]) => void = () => undefined
    const first = host.exclusiveDialog<string[]>([], () => new Promise((resolve) =>
    {
      release = resolve
    }))
    const second = vi.fn(async () => ['b'])
    expect(await host.exclusiveDialog<string[]>([], second)).toEqual([])
    expect(second).not.toHaveBeenCalled()
    release(['a'])
    expect(await first).toEqual(['a'])
    expect(await host.exclusiveDialog<string[]>([], second)).toEqual(['b'])
  })

  it('frees the picker after a failing dialog', async () =>
  {
    await expect(host.exclusiveDialog(null, async () =>
    {
      throw new Error('gone')
    })).rejects.toThrow('gone')
    expect(await host.exclusiveDialog(null, async () => 'next')).toBe('next')
  })

  it('filters the open dialog by the shared extension list', () =>
  {
    const [media, all] = host.mediaFileFilters()
    expect(media.extensions).toEqual([...MEDIA_EXTENSIONS])
    expect(all.extensions).toEqual(['*'])
  })

  it('opens the folder picker in the most recent folder', () =>
  {
    const recent = [
      { path: 'D:\\Old', name: 'Old', files: 3, addedAt: 10 },
      { path: 'D:\\New', name: 'New', files: 1, addedAt: 30 },
      { path: 'D:\\Mid', name: 'Mid', files: 2, addedAt: 20 }
    ]
    expect(host.mostRecentFolder(recent, null)).toBe('D:\\New')
    expect(host.mostRecentFolder([], 'E:\\Picked')).toBe('E:\\Picked')
    expect(host.mostRecentFolder([], null)).toBeUndefined()
    host.notePickedFolder(null)
    host.notePickedFolder('F:\\Last')
    expect(host.mostRecentFolder([])).toBe('F:\\Last')
  })

  it('offers the report formats with the default path first', () =>
  {
    expect(host.reportFilters('C:\\r.json')[0].extensions).toEqual(['json'])
    expect(host.reportFilters('C:\\r.csv')[0].extensions).toEqual(['csv'])
  })
})

describe('clipboard', () =>
{
  function source(o: Partial<{ formats: string[]; reads: Record<string, string>; buffers: Record<string, Buffer>; text: string; drop: () => Promise<string> }>): host.ClipboardSource
  {
    return {
      formats: () => o.formats ?? [],
      read: (f) => o.reads?.[f] ?? '',
      readBuffer: (f) => o.buffers?.[f] ?? Buffer.alloc(0),
      readText: () => o.text ?? '',
      windowsDropList: o.drop ?? (async () => '')
    }
  }

  it('reads the whole Windows file-drop list', async () =>
  {
    const drop = async (): Promise<string> => 'C:\\a\\one file.txt\r\nC:\\a\\two \u00e9.txt\r\n'
    expect(await host.readClipboardContent('win32', source({ formats: ['text/uri-list'], drop, text: 'x' }))).toEqual({ files: ['C:\\a\\one file.txt', 'C:\\a\\two \u00e9.txt'], text: 'x' })
  })

  it('falls back to the first Windows file when the list query fails', async () =>
  {
    const buffers = { FileNameW: Buffer.from('C:\\a\\one.txt\0', 'utf16le') }
    const drop = async (): Promise<string> =>
    {
      throw new Error('no powershell')
    }
    expect(await host.readClipboardContent('win32', source({ formats: ['text/uri-list'], buffers, drop }))).toEqual({ files: ['C:\\a\\one.txt'], text: '' })
    expect(await host.readClipboardContent('win32', source({ formats: ['text/uri-list'], drop }))).toEqual({ files: [], text: '' })
  })

  it('reads only text when Windows holds no file list', async () =>
  {
    const drop = vi.fn(async () => 'C:\\x')
    expect(await host.readClipboardContent('win32', source({ formats: ['text/plain'], text: '"C:\\a.mp3"', drop }))).toEqual({ files: [], text: '"C:\\a.mp3"' })
    expect(drop).not.toHaveBeenCalled()
  })

  it('reads the Finder list, then a single file URL', async () =>
  {
    const plist = '<?xml version="1.0"?><plist><array><string>/Users/a/A &amp; B.wav</string><string>/Users/a/c.mp3</string></array></plist>'
    expect((await host.readClipboardContent('darwin', source({ reads: { NSFilenamesPboardType: plist } }))).files).toEqual(['/Users/a/A & B.wav', '/Users/a/c.mp3'])
    expect((await host.readClipboardContent('darwin', source({ reads: { 'public.file-url': 'file:///Users/a/d%20e.flac' } }))).files).toEqual(['/Users/a/d e.flac'])
  })

  it('reads text/uri-list on Linux, then the GNOME copied-files list', async () =>
  {
    const uris = '# comment\r\nfile:///home/a/x.mkv\r\nhttps://example.com/y\r\n'
    expect((await host.readClipboardContent('linux', source({ reads: { 'text/uri-list': uris } }))).files).toEqual(['/home/a/x.mkv'])
    const gnome = 'copy\nfile:///home/a/z%20y.wav'
    expect((await host.readClipboardContent('linux', source({ reads: { 'x-special/gnome-copied-files': gnome } }))).files).toEqual(['/home/a/z y.wav'])
  })

  it('decodes the helpers on their own', () =>
  {
    expect(host.fileNameWPath(Buffer.alloc(0))).toBeNull()
    expect(host.dropListPaths('\r\n  C:\\a  \r\n')).toEqual(['C:\\a'])
    expect(host.plistPaths('<plist></plist>')).toEqual([])
    expect(host.uriListPaths('file://bad host/x', 'linux')).toEqual([])
    expect(host.uriListPaths('file:///C:/a/b%20c.wav', 'win32')).toEqual(['C:\\a\\b c.wav'])
    expect(host.windowsPowerShell('D:\\Win')).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('reads through Electron with the PowerShell list query', async () =>
  {
    m.clipboard.formats = ['text/plain']
    m.clipboard.text = 'C:\\x.mp3'
    expect(await host.readClipboardContent('win32', host.electronClipboard())).toEqual({ files: [], text: 'C:\\x.mp3' })
    expect(host.DROP_LIST_SCRIPT).toContain('Get-Clipboard -Format FileDropList')
  })
})

interface FakeWindow
{
  visible: boolean
  focused: boolean
  progress: unknown[][]
  isVisible(): boolean
  isFocused(): boolean
  isDestroyed(): boolean
  show(): void
  focus(): void
  setProgressBar(...a: unknown[]): void
}

function fakeWindow(visible = true): FakeWindow
{
  const win: FakeWindow = {
    visible,
    focused: false,
    progress: [],
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isDestroyed: () => false,
    show: () =>
    {
      win.visible = true
    },
    focus: () =>
    {
      win.focused = true
    },
    setProgressBar: (...a) => win.progress.push(a)
  }
  return win
}

describe('createElectronJobsHost', () =>
{
  beforeEach(() =>
  {
    m.notifications.length = 0
    m.messageBoxes.length = 0
    m.blockerStarted.length = 0
    m.blockerStopped.length = 0
    m.notificationsSupported = true
  })

  it('shows notifications that open the batch view and focus the job', () =>
  {
    const win = fakeWindow()
    const shown: Array<string | undefined> = []
    const h = host.createElectronJobsHost({ mainWindow: () => win as never, showMainWindow: (view) => shown.push(view) })
    const focus = vi.fn()
    h.attach({ focus })
    h.notify({ title: 'Batch 31 finished', body: 'All 2 jobs verified.', focus: { jobId: null, runId: 'B-31' as never } })
    expect(m.notifications).toHaveLength(1)
    expect(m.notifications[0].shown).toBe(true)
    expect(m.notifications[0].options).toMatchObject({ title: 'Batch 31 finished', body: 'All 2 jobs verified.' })
    m.notifications[0].handlers.get('click')!()
    expect(shown).toEqual([host.BATCH_VIEW])
    expect(focus).toHaveBeenCalledWith(null, 'B-31')
    m.notificationsSupported = false
    h.notify({ title: 't', body: 'b', focus: { jobId: null, runId: null } })
    expect(m.notifications).toHaveLength(1)
  })

  it('sets taskbar progress per mode and removes it', () =>
  {
    const win = fakeWindow()
    const h = host.createElectronJobsHost({ mainWindow: () => win as never })
    h.setTaskbarProgress({ fraction: 0.42, mode: 'normal' })
    h.setTaskbarProgress({ fraction: 0.5, mode: 'paused' })
    h.setTaskbarProgress({ fraction: 0, mode: 'error' })
    h.setTaskbarProgress({ fraction: 1.4, mode: 'normal' })
    h.setTaskbarProgress(null)
    expect(win.progress).toEqual([[0.42, { mode: 'normal' }], [0.5, { mode: 'paused' }], [1, { mode: 'error' }], [1, { mode: 'normal' }], [-1]])
    host.createElectronJobsHost({ mainWindow: () => null }).setTaskbarProgress(null)
  })

  it('prevents app suspension while asked and stops once', () =>
  {
    const h = host.createElectronJobsHost({ mainWindow: () => null })
    h.setKeepAwake(true)
    h.setKeepAwake(true)
    h.setKeepAwake(false)
    h.setKeepAwake(false)
    expect(m.blockerStarted).toEqual(['prevent-app-suspension'])
    expect(m.blockerStopped).toEqual([11])
  })

  it('parents the quit dialog to the main window and passes the signal', async () =>
  {
    const win = fakeWindow(false)
    const showMain = vi.fn(() =>
    {
      win.visible = true
    })
    const h = host.createElectronJobsHost({ mainWindow: () => win as never, showMainWindow: showMain })
    m.showMessageBox = async () => ({ response: 2 })
    const signal = new AbortController().signal
    expect(await h.askQuit({ message: 'Batch 31 is still running.', detail: 'd' }, signal)).toBe('quit-now')
    expect(showMain).toHaveBeenCalled()
    const [parent, options] = m.messageBoxes[0] as [unknown, { buttons: string[]; defaultId: number; cancelId: number; signal: AbortSignal }]
    expect(parent).toBe(win)
    expect(options.buttons).toEqual(['Keep running', 'Quit when current jobs finish', 'Quit now'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.signal).toBe(signal)
  })

  it('keeps running when the quit dialog is aborted or has no window', async () =>
  {
    const controller = new AbortController()
    m.showMessageBox = async () =>
    {
      controller.abort()
      return { response: 2 }
    }
    const win = fakeWindow()
    expect(await host.createElectronJobsHost({ mainWindow: () => win as never }).askQuit({ message: 'm', detail: 'd' }, controller.signal)).toBe('keep-running')
    expect(await host.createElectronJobsHost({ mainWindow: () => null, showMainWindow: () => undefined }).askQuit({ message: 'm', detail: 'd' })).toBe('keep-running')
    expect(host.quitChoiceOf(1, false)).toBe('quit-when-idle')
    expect(host.quitChoiceOf(9, false)).toBe('keep-running')
  })

  it('confirms a batch cancel in a parented box', async () =>
  {
    const win = fakeWindow()
    const h = host.createElectronJobsHost({ mainWindow: () => win as never })
    m.showMessageBox = async () => ({ response: 1 })
    expect(await h.confirmCancelBatch({ message: 'Cancel Batch 31?', detail: 'd' })).toBe(true)
    expect((m.messageBoxes[0] as [unknown, { buttons: string[] }])[1].buttons).toEqual([...host.CANCEL_BATCH_BUTTONS])
    m.showMessageBox = async () => ({ response: 0 })
    expect(await h.confirmCancelBatch({ message: 'm', detail: 'd' })).toBe(false)
    expect(await host.createElectronJobsHost({ mainWindow: () => null, showMainWindow: () => undefined }).confirmCancelBatch({ message: 'm', detail: 'd' })).toBe(false)
  })

  it('reports the main window and replays the tray status', () =>
  {
    const win = fakeWindow()
    const h = host.createElectronJobsHost({ mainWindow: () => win as never })
    expect(h.mainWindow()).toEqual({ visible: true, focused: false })
    const status = { tooltip: 'molexMedia', statusLine: null, runControl: null, canCancel: false }
    h.setTrayStatus(status)
    const render = vi.fn()
    h.bindTray(render)
    expect(render).toHaveBeenCalledWith(status)
    expect(h.lastTrayStatus()).toBe(status)
    expect(host.createElectronJobsHost({ mainWindow: () => null }).mainWindow()).toBeNull()
  })

  it('adapts a webContents into an event sender', () =>
  {
    const contents = Object.assign(new EventEmitter(), { id: 5, destroyed: false, sent: [] as unknown[], isDestroyed(): boolean
    {
      return this.destroyed
    }, send(...a: unknown[]): void
    {
      this.sent.push(a)
    } })
    m.fromId.set(5, contents)
    const h = host.createElectronJobsHost({ mainWindow: () => null })
    const sender = h.sender(5)!
    expect(h.sender(6)).toBeNull()
    expect(sender.id).toBe(5)
    const navigations: unknown[] = []
    const stop = sender.onNavigate((n) => navigations.push(n))
    contents.emit('did-frame-navigate', {}, 'u', 200, 'OK', true)
    contents.emit('did-navigate-in-page', {}, 'u#x', true)
    stop()
    contents.emit('did-frame-navigate', {}, 'u', 200, 'OK', false)
    expect(navigations).toEqual([{ isMainFrame: true, isSameDocument: false }, { isMainFrame: true, isSameDocument: true }])
    sender.send('jobs:event', { seq: 1 } as never)
    const ended = vi.fn()
    sender.onDestroyed(ended)
    contents.destroyed = true
    contents.emit('destroyed')
    sender.send('jobs:event', { seq: 2 } as never)
    expect(contents.sent).toEqual([['jobs:event', { seq: 1 }]])
    expect(ended).toHaveBeenCalledOnce()
    expect(sender.isDestroyed()).toBe(true)
    expect(h.sender(5)).toBeNull()
  })

  it('logs an unexpected command failure', () =>
  {
    host.logUnexpected('add', new Error('boom'))
    host.logUnexpected('add', 'text')
    expect(m.log.error).toHaveBeenCalledWith('Job command add failed unexpectedly', expect.stringContaining('boom'))
  })
})

function results(failing: SelfTestId[] = []): Record<SelfTestId, boolean>
{
  return Object.fromEntries(SELF_TEST_IDS.map((id) => [id, !failing.includes(id)])) as Record<SelfTestId, boolean>
}

function buildInfo(candidate: Pick<BuildCandidate, 'source' | 'ffmpegPath' | 'ffprobePath'>, selfTest: Record<SelfTestId, boolean>, meetsMinimum = true): FfmpegBuildInfo
{
  const st = fs.statSync(candidate.ffmpegPath)
  return {
    ffmpegPath: candidate.ffmpegPath,
    ffprobePath: candidate.ffprobePath,
    source: candidate.source,
    versionString: 'n9.0.2-17-g2a571b6068-20260930',
    libs: { avutil: [60, 8, 100], avcodec: [62, 11, 100], avformat: [62, 3, 100], avfilter: [11, 4, 100], swresample: [6, 1, 100] },
    configuration: [],
    encoders: new Set(['aac', 'flac', 'libopus', 'h264_nvenc', 'opus']),
    experimental: new Set(['opus']),
    soxr: selfTest.soxr,
    meetsMinimum,
    selfTest,
    identity: { path: candidate.ffmpegPath, size: st.size, mtimeMs: st.mtimeMs }
  }
}

describe('FFmpeg build state', () =>
{
  let dir: string
  let custom: BuildCandidate
  let savedPath: string | undefined

  beforeAll(() =>
  {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molex-e1-'))
    m.dirs.root = path.join(dir, 'ffmpeg')
    m.dirs.legacy = path.join(dir, 'bin')
    fs.mkdirSync(path.join(dir, 'custom'))
    custom = { source: 'custom', buildId: null, ffmpegPath: path.join(dir, 'custom', 'ffmpeg.exe'), ffprobePath: path.join(dir, 'custom', 'ffprobe.exe') }
    fs.writeFileSync(custom.ffmpegPath, 'ffmpeg')
    fs.writeFileSync(custom.ffprobePath, 'ffprobe')
    savedPath = process.env['PATH']
    process.env['PATH'] = ''
  })

  afterAll(() =>
  {
    process.env['PATH'] = savedPath
    fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() =>
  {
    m.inspectCalls.length = 0
    m.savedFfmpeg.length = 0
    m.remembered.length = 0
    m.config = { ffmpeg: { ...custom, selfTest: null }, jobs: { recentFolders: [] } }
  })

  it('runs the self-test once per binary identity and caches a pass in the ffmpeg block', async () =>
  {
    m.inspect = async (c: unknown, record: unknown) => buildInfo(c as BuildCandidate, record ? (record as { results: Record<SelfTestId, boolean> }).results : results())
    const state = await host.checkFfmpeg()
    expect(state.adopted).toBe(true)
    expect(m.inspectCalls[0][1]).toBeNull()
    expect(state.testedAt).not.toBeNull()
    expect(m.savedFfmpeg).toHaveLength(1)
    expect(m.savedFfmpeg[0]).toMatchObject({ source: 'custom', ffmpegPath: custom.ffmpegPath, selfTest: { rev: SELF_TEST_REV, results: results() } })
    expect(m.remembered).toHaveLength(1)

    m.config = { ffmpeg: { ...custom, selfTest: null }, jobs: { recentFolders: [] } }
    const again = await host.checkFfmpeg()
    expect(m.inspectCalls[1][1]).toMatchObject({ rev: SELF_TEST_REV, results: results() })
    expect(again.testedAt).toBe(state.testedAt)

    const info = host.ffmpegInfo()
    expect(info).toMatchObject({ found: true, usable: true, version: '9.0.2', source: 'custom', libsoxr: true, meetsMinimum: true })
    expect(info.selfTest).toMatchObject({ status: 'passed', failedTest: null })
    expect(info.pin.matches).toBe(false)
    expect(info.pin.offerInstall).toBe(false)
    expect(info.pin.installLabel).toMatch(/^Install FFmpeg \d+\.\d+\.x \(tested with this version\)$/)
  })

  it('re-runs the self-test on request', async () =>
  {
    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results())
    await host.checkFfmpeg()
    const before = m.inspectCalls.length
    const state = await host.rerunSelfTest()
    expect(m.inspectCalls[before][1]).toBeNull()
    expect(state.adopted).toBe(true)
  })

  it('disables the pipeline with the failing test, while soxr alone only switches the meters', async () =>
  {
    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results(['chain-opus-51side', 'soxr']))
    const failed = await host.rerunSelfTest()
    expect(failed.adopted).toBe(false)
    expect(failed.refusal).toContain('chain-opus-51side')
    expect(host.ffmpegInfo().selfTest).toMatchObject({ status: 'failed', failedTest: 'chain-opus-51side' })
    const summary = host.capabilitySummary({ build: failed, gpu: null, rev: 3, cores: 8, platform: 'win32' })
    expect(summary.ffmpeg).toMatchObject({ ready: true, selfTest: 'failed', soxr: false })

    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results(['soxr']))
    const soxr = await host.rerunSelfTest()
    expect(soxr.adopted).toBe(true)
    expect(host.capabilitySummary({ build: soxr, gpu: null, rev: 4, cores: 8, platform: 'win32' }).ffmpeg).toMatchObject({ selfTest: 'passed', soxr: false })
  })

  it('reports no usable build when nothing is found', async () =>
  {
    m.config = { ffmpeg: null, jobs: { recentFolders: [] } }
    const state = await host.checkFfmpeg()
    expect(state).toMatchObject({ info: null, adopted: false, refusal: null })
    expect(host.ffmpegInfo()).toMatchObject({ found: false, usable: false, version: null })
    expect(host.capabilitySummary({ build: state, gpu: null, rev: 1, cores: 4, platform: 'linux' }).ffmpeg).toEqual({
      ready: false, version: null, source: null, meetsMinimum: false, selfTest: null, soxr: false
    })
  })

  it('installs the pinned build through the bootstrap, then adopts it', async () =>
  {
    const progress = vi.fn()
    m.download = async (onProgress: unknown) =>
    {
      (onProgress as (p: unknown) => void)({ stage: 'complete', message: 'FFmpeg is ready!', percent: 100 })
      return { ffmpeg: custom.ffmpegPath, ffprobe: custom.ffprobePath }
    }
    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results())
    const state = await host.installPinnedFfmpeg(progress)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'complete' }))
    expect(state.adopted).toBe(true)
  })

  it('tells listeners about build changes', async () =>
  {
    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results())
    const seen = vi.fn()
    const stop = host.onBuildChange(seen)
    await host.checkFfmpeg()
    stop()
    await host.checkFfmpeg()
    expect(seen).toHaveBeenCalledOnce()
    expect(host.currentBuildState().rev).toBeGreaterThan(0)
  })
})

describe('build information', () =>
{
  const pin = { id: 'p', version: '9.0.2', fetched: '2026-10-15', platforms: { 'win32-x64': { primary: [{ build: 'btbn-a', url: 'https://x', bytes: 1, sha256: 'a', kind: 'zip' as const, contains: ['ffmpeg' as const] }], fallback: [{ build: 'gyan-b', url: 'https://y', bytes: 1, sha256: 'b', kind: 'zip' as const, contains: ['ffmpeg' as const] }] } } }

  it('names the pinned builds and the install offer', () =>
  {
    expect(host.pinnedBuildIds(pin, 'win32', 'x64')).toEqual(['btbn-a', 'gyan-b'])
    expect(host.pinnedBuildIds(pin, 'linux', 'x64')).toEqual([])
    expect(host.installLabel('9.0.2')).toBe('Install FFmpeg 9.0.x (tested with this version)')
    expect(host.installLabel('10')).toBe('Install FFmpeg 10.0.x (tested with this version)')
    expect(host.pinnedBuilds().version).toMatch(/^\d+\.\d+/)
  })

  it('offers the tested build only to a bundled build that differs from the pin', () =>
  {
    const base = { info: null, adopted: false, refusal: null, testedAt: null, testMs: null, rev: 1 }
    const bundled = (buildId: string | null): host.FfmpegBuildState => ({ ...base, candidate: { source: 'bundled', buildId, ffmpegPath: 'f', ffprobePath: 'p' } })
    expect(host.ffmpegInfoOf(bundled('btbn-a'), pin, ['btbn-a']).pin).toMatchObject({ matches: true, offerInstall: false })
    expect(host.ffmpegInfoOf(bundled('btbn-old'), pin, ['btbn-a']).pin).toMatchObject({ matches: false, offerInstall: true })
    expect(host.ffmpegInfoOf(bundled(null), pin, ['btbn-a']).pin.offerInstall).toBe(true)
    const onPath: host.FfmpegBuildState = { ...base, candidate: { source: 'path', buildId: null, ffmpegPath: 'f', ffprobePath: 'p' } }
    expect(host.ffmpegInfoOf(onPath, pin, ['btbn-a']).pin.offerInstall).toBe(false)
  })

  it('summarizes capabilities with GPU detection', () =>
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molex-e1-caps-'))
    const file = path.join(dir, 'ffmpeg')
    fs.writeFileSync(file, 'x')
    const info = buildInfo({ source: 'path', ffmpegPath: file, ffprobePath: file }, results(), true)
    const state: host.FfmpegBuildState = { info, candidate: { source: 'path', buildId: null, ffmpegPath: file, ffprobePath: file }, adopted: true, refusal: null, testedAt: 5, testMs: 9, rev: 2 }
    const detecting = host.capabilitySummary({ build: state, gpu: null, rev: 7, cores: 12, platform: 'win32' })
    expect(detecting).toMatchObject({ rev: 7, cpuCount: 12, platform: 'win32', gpu: { status: 'detecting', vendor: null, name: null, encoders: [] } })
    expect(detecting.encoders).toEqual(['aac', 'flac', 'h264_nvenc', 'libopus'])
    const ready = host.capabilitySummary({ build: state, gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', encoders: ['h264_nvenc'] }, rev: 8, cores: 12, platform: 'win32' })
    expect(ready.gpu).toEqual({ status: 'ready', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', encoders: ['h264_nvenc'] })
    const old = host.capabilitySummary({ build: { ...state, info: { ...info, meetsMinimum: false } }, gpu: null, rev: 9, cores: 1, platform: 'linux' })
    expect(old.ffmpeg).toMatchObject({ meetsMinimum: false, selfTest: 'pending' })
    expect(host.buildCapabilitiesOf(info)).toEqual({ encoders: info.encoders, experimental: info.experimental, soxr: true })
    expect(host.buildCapabilitiesOf(null)).toBe(host.NO_BUILD)
    expect(host.buildIdOf(info)).toBe('path:n9.0.2-17-g2a571b6068-20260930')
    expect(host.buildIdOf(null)).toBe('none')
    expect(host.ffmpegInfoOf(state, pin, []).selfTest).toMatchObject({ status: 'passed', testedAt: 5, durationMs: 9 })
    expect(host.ffmpegInfoOf({ ...state, info: { ...info, meetsMinimum: false } }, pin, []).selfTest.status).toBe('not-run')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('maps settings to detection, priority, and analysis output', () =>
  {
    expect(host.detectionMode('nvenc')).toBe('nvenc')
    expect(host.detectionMode('off')).toBe('auto')
    expect(host.detectionMode(undefined)).toBe('auto')
    expect(host.osPriority('below-normal')).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    expect(host.osPriority('normal')).toBe(os.constants.priority.PRIORITY_NORMAL)
    expect(host.analysisOutput({ plan: null, source: { ext: 'flac' } } as never)).toEqual({ container: 'flac', muxer: 'flac' })
    expect(host.analysisOutput({ plan: { container: 'm4a' }, source: { ext: 'wav' } } as never).container).toBe('m4a')
    expect(host.appIconPath(path.join('app', 'out', 'main'))).toBe(path.join('app', 'resources', 'icon.png'))
  })

  it('reads an album member from its first planned stream', () =>
  {
    const stats = { status: 'measured', integratedLufs: -20 } as never
    const analysis = { source: [{ audioIndex: 0, stats }], afterDynamics: null } as never
    const plan = { streams: [{ audioIndex: 0, ceiling: { dbtp: -1 } }] } as never
    expect(host.albumMemberOf('MM-0001', analysis, plan)).toEqual({ jobId: 'MM-0001', stats, ceiling: { dbtp: -1 }, audioIndex: 0 })
    expect(() => host.albumMemberOf('MM-0001', analysis, { streams: [] } as never)).toThrow('no audio stream')
    expect(() => host.albumMemberOf('MM-0001', { source: [], afterDynamics: null } as never, plan)).toThrow('no measurement')
  })
})

describe('createEngineRuntime', () =>
{
  beforeEach(() =>
  {
    m.trashed.length = 0
    m.savedJobs.length = 0
    m.gpu = async () => ({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', encoders: ['h264_nvenc', 'hevc_nvenc'] })
    m.config = { ffmpeg: null, gpuAcceleration: 'off', jobs: { settings: { verifyVideo: 'sampled' }, policy: {}, defaultRecipe: {}, recentFolders: [], pendingAlerts: [] } }
  })

  it('builds the real engine deps without starting anything', async () =>
  {
    const runtime = await host.createEngineRuntime({ mainWindow: () => null })
    const deps = runtime.deps
    expect(deps.paths.userData).toBe('/tmp/test-app')
    expect(deps.platform).toBe(host.hostPlatform())
    expect(deps.cores).toBe(os.availableParallelism())
    expect(deps.pid).toBe(process.pid)
    expect(deps.appVersion).toBe('3.0.0')
    expect(deps.host).toBe(runtime.host)
    expect(typeof deps.store.appendSync).toBe('function')
    expect(typeof deps.fs.reserve).toBe('function')
    expect(typeof deps.planner.volumeInfo).toBe('function')
    expect(typeof deps.probe.probeSource).toBe('function')
    expect(typeof deps.historyFs.stat).toBe('function')
    expect(typeof deps.log.child).toBe('function')
    expect(deps.ids.token()).toMatch(/^[0-9a-f]{16}$/)
    expect(deps.ids.preflightId()).not.toBe(deps.ids.preflightId())
    const runners = typeof deps.runners === 'function' ? deps.runners({ analyses: { forJob: async () => null, store: () => undefined } as never }) : deps.runners
    expect(Object.keys(runners).sort()).toEqual(['boost', 'compress', 'convert', 'extract', 'normalize'])
    expect(await runtime.takeAlerts()).toEqual(['replace-migrated'])
    runtime.dispose()
  })

  it('runs the current build and nothing while none is found', async () =>
  {
    const savedPath = process.env['PATH']
    process.env['PATH'] = ''
    m.dirs.root = path.join(os.tmpdir(), 'molex-e1-none')
    m.dirs.legacy = m.dirs.root
    try
    {
      await host.checkFfmpeg()
      const runtime = await host.createEngineRuntime({ mainWindow: () => null })
      expect(runtime.deps.ffmpeg.current()).toBeNull()
      expect(runtime.deps.plannerCapabilities()).toEqual({ build: host.NO_BUILD, minimumVersion: host.MINIMUM_FFMPEG_VERSION })
      expect(runtime.deps.capabilities.ffmpeg.ready).toBe(false)
      expect(runtime.deps.capabilities.gpu).toMatchObject({ status: 'ready', vendor: null })
      runtime.dispose()

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molex-e1-run-'))
      const bin = { source: 'custom' as const, buildId: null, ffmpegPath: path.join(dir, 'ffmpeg.exe'), ffprobePath: path.join(dir, 'ffprobe.exe') }
      fs.writeFileSync(bin.ffmpegPath, 'f')
      fs.writeFileSync(bin.ffprobePath, 'p')
      m.config = { ...m.config, ffmpeg: { ...bin, selfTest: null } }
      m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results())
      const withBuild = await host.createEngineRuntime({ mainWindow: () => null })
      const setCapabilities = vi.fn(async () => undefined)
      await withBuild.attach({ setCapabilities, focus: vi.fn(), snapshot: () => ({ jobs: [] }) } as never)
      await host.checkFfmpeg()
      await vi.waitFor(() => expect(setCapabilities).toHaveBeenCalled())
      const tools = withBuild.deps.ffmpeg.current()
      expect(tools?.caps.soxr).toBe(true)
      expect(withBuild.deps.capabilities.ffmpeg).toMatchObject({ ready: true, selfTest: 'passed', version: '9.0.2' })
      expect(withBuild.deps.ffmpeg.current()?.exec).toBe(tools?.exec)
      await vi.waitFor(() => expect((setCapabilities.mock.calls.at(-1) as unknown as [{ gpu: { name: string | null } }])[0].gpu.name).toBe('NVIDIA GeForce RTX 4070 SUPER'))
      withBuild.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
    finally
    {
      process.env['PATH'] = savedPath
    }
  })

  it('trashes with platform separators and never throws from a priority call', async () =>
  {
    const runtime = await host.createEngineRuntime({ mainWindow: () => null })
    await runtime.deps.trash('C:/media/old/song.wav')
    expect(m.trashed).toEqual([path.normalize('C:/media/old/song.wav')])
    expect(() => runtime.deps.setPriority(-424242, 'below-normal')).not.toThrow()
    runtime.deps.shell.showItemInFolder('C:/media/a.wav')
    expect(m.revealed.at(-1)).toBe(path.normalize('C:/media/a.wav'))
    expect(await runtime.deps.shell.readLog(path.join(os.tmpdir(), 'molex-missing-log.txt'))).toBeNull()
    expect(await runtime.deps.shell.exists(os.tmpdir())).toBe(true)
    runtime.dispose()
  })

  it('persists the jobs key and hands capability changes to the engine', async () =>
  {
    const runtime = await host.createEngineRuntime({ mainWindow: () => null })
    await runtime.deps.config.persist({ recentFolders: [] })
    expect(m.savedJobs).toEqual([{ recentFolders: [] }])
    const setCapabilities = vi.fn(async () => undefined)
    await runtime.attach({ setCapabilities, focus: vi.fn(), snapshot: () => ({ jobs: [] }) } as never)
    expect(setCapabilities).toHaveBeenCalledOnce()
    await runtime.refreshCapabilities()
    const revs = (setCapabilities.mock.calls as unknown as Array<[{ rev: number }]>).map(([c]) => c.rev)
    expect(revs[1]).toBeGreaterThan(revs[0])
    await expect(runtime.deps.audio.analyze('MM-0001' as never, { signal: new AbortController().signal, cached: () => null })).rejects.toThrow('not in the queue')
    expect(() => runtime.deps.audio.plan('MM-0001' as never, {} as never)).toThrow('no analysis plan')
    runtime.dispose()
  })

  it('reads the clipboard through the platform reader', async () =>
  {
    m.clipboard.formats = []
    m.clipboard.text = 'D:\\clip.wav'
    const runtime = await host.createEngineRuntime({ mainWindow: () => null })
    const content = await runtime.deps.shell.readClipboard()
    expect(content.text).toBe('D:\\clip.wav')
    runtime.dispose()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { JOB_CHANNELS, JOB_COMMAND_NAMES, JOB_EVENT_CHANNEL } from '../../src/shared/jobs/contract'
import { REQUEST_VALIDATORS, createRequestValidators } from '../../src/shared/jobs/validate'

const electron = vi.hoisted(() =>
{
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    listeners,
    exposed: new Map<string, unknown>(),
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
    ipcRenderer: {
      invoke: vi.fn(async (..._args: unknown[]) => undefined as unknown),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) =>
      {
        if (!listeners.has(channel))
        {
          listeners.set(channel, new Set())
        }
        listeners.get(channel)!.add(listener)
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) =>
      {
        listeners.get(channel)?.delete(listener)
      })
    },
    webFrame: { level: 0, getZoomLevel: vi.fn(), setZoomLevel: vi.fn(), getZoomFactor: vi.fn(), setZoomFactor: vi.fn() },
    webUtils: { getPathForFile: vi.fn(() => 'C:/media/a.wav') }
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app'), getName: vi.fn(() => 'molex-media'), getVersion: vi.fn(() => '3.0.0') },
  ipcMain: electron.ipcMain,
  ipcRenderer: electron.ipcRenderer,
  webFrame: electron.webFrame,
  webUtils: electron.webUtils,
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value) }
}))

const ROOT = path.resolve(__dirname, '../..')

/** Every source file under a folder, relative to the repository root. */
function sourceFiles(dir: string): string[]
{
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }))
  {
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory())
    {
      out.push(...sourceFiles(rel))
    }
    else if (/\.(ts|tsx)$/.test(entry.name))
    {
      out.push(rel)
    }
  }
  return out
}

function read(rel: string): string
{
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** The first string-literal argument of every call matching `callee` across the given files. */
function literalChannels(files: string[], callee: string): Set<string>
{
  const pattern = new RegExp(`${callee}\\(\\s*'([^']+)'`, 'g')
  const out = new Set<string>()
  for (const file of files)
  {
    for (const match of read(file).matchAll(pattern))
    {
      out.add(match[1])
    }
  }
  return out
}

function minus(a: Iterable<string>, b: Set<string>): string[]
{
  return [...a].filter((x) => !b.has(x)).sort()
}

const MAIN_FILES = sourceFiles('src/main')
const PRELOAD_FILES = ['src/preload/index.ts']
const RENDERER_FILES = sourceFiles('src/renderer/src')
const JOB_CHANNEL_VALUES = Object.values(JOB_CHANNELS)

/** Preload wrappers whose channel has no handler. */
const CALLERS_WITHOUT_HANDLER: string[] = []
/** Handlers nothing in the preload calls. */
const HANDLERS_WITHOUT_CALLER: string[] = []
/** Channels main sends that no preload function listens to; the per-entry log forward goes with its last listener. */
const SENT_WITHOUT_LISTENER = ['logs:entry']

describe('job command channels', () =>
{
  it('gives every command a distinct channel outside the other groups', () =>
  {
    expect(new Set(JOB_CHANNEL_VALUES).size).toBe(JOB_CHANNEL_VALUES.length)
    for (const channel of JOB_CHANNEL_VALUES)
    {
      expect(channel).toMatch(/^(jobs|run|runs|presets):[A-Za-z]+$/)
    }
    expect(JOB_CHANNEL_VALUES).not.toContain(JOB_EVENT_CHANNEL)
  })

  it('has a validator for every command and nothing else', () =>
  {
    for (const validators of [REQUEST_VALIDATORS, createRequestValidators('win32'), createRequestValidators(null)])
    {
      expect(Object.keys(validators).sort()).toEqual([...JOB_COMMAND_NAMES].sort())
      for (const name of JOB_COMMAND_NAMES)
      {
        expect(typeof validators[name]).toBe('function')
      }
    }
  })

  it('registers exactly the command channels in ipc/jobs.ts and removes them again', async () =>
  {
    electron.ipcMain.handle.mockClear()
    electron.ipcMain.removeHandler.mockClear()
    const { registerJobsIPC } = await import('../../src/main/ipc/jobs')
    const dispose = registerJobsIPC(
      { command: vi.fn() } as never,
      { rendererLocation: () => ({ kind: 'dev', origin: 'http://localhost:5173' }), logUnexpected: vi.fn() } as never,
      'win32'
    )
    const registered = electron.ipcMain.handle.mock.calls.map((call) => call[0] as string)
    expect(registered.sort()).toEqual([...JOB_CHANNEL_VALUES].sort())
    dispose()
    expect(electron.ipcMain.removeHandler.mock.calls.map((call) => call[0] as string).sort()).toEqual([...JOB_CHANNEL_VALUES].sort())
  })

  it('leaves no literal job channel to a hand-written handler or wrapper', () =>
  {
    const handled = literalChannels(MAIN_FILES, 'ipcMain\\.handle')
    const invoked = literalChannels(PRELOAD_FILES, 'ipcRenderer\\.invoke')
    for (const channel of JOB_CHANNEL_VALUES)
    {
      expect(handled.has(channel)).toBe(false)
      expect(invoked.has(channel)).toBe(false)
    }
  })
})

describe('invoke and handle parity', () =>
{
  const handled = new Set([...literalChannels(MAIN_FILES, 'ipcMain\\.handle'), ...JOB_CHANNEL_VALUES])
  const invoked = new Set([...literalChannels(PRELOAD_FILES, 'ipcRenderer\\.invoke'), ...JOB_CHANNEL_VALUES])

  it('finds the handlers and wrappers it scans for', () =>
  {
    expect(handled.has('config:load')).toBe(true)
    expect(handled.has('editor:cut')).toBe(true)
    expect(invoked.has('logs:getBuffer')).toBe(true)
  })

  it('has a handler for every invoked channel', () =>
  {
    expect(minus(invoked, handled)).toEqual([...CALLERS_WITHOUT_HANDLER].sort())
  })

  it('has a caller for every handler, outside the listed exceptions', () =>
  {
    expect(minus(handled, invoked)).toEqual([...HANDLERS_WITHOUT_CALLER].sort())
  })

  it('has a main listener for every channel the preload sends, and the other way round', () =>
  {
    const sent = literalChannels(PRELOAD_FILES, 'ipcRenderer\\.send')
    const listened = literalChannels(MAIN_FILES, 'ipcMain\\.on')
    expect(sent.size).toBeGreaterThan(0)
    expect(minus(sent, listened)).toEqual([])
    expect(minus(listened, sent)).toEqual([])
  })

  it('has a sender in main for every channel the preload listens to', () =>
  {
    const listened = new Set([...literalChannels(PRELOAD_FILES, 'ipcRenderer\\.on')])
    const sent = new Set([...literalChannels(MAIN_FILES, '(?:sendToAll|\\.send)')])
    expect(minus(listened, sent)).toEqual([])
    expect(minus(sent, listened)).toEqual([...SENT_WITHOUT_LISTENER].sort())
    expect(read('src/main/jobs/bus.ts')).toMatch(/\.send\(JOB_EVENT_CHANNEL,/)
  })

  it('keeps ipcRenderer and electron imports out of the renderer', () =>
  {
    for (const file of RENDERER_FILES)
    {
      const text = read(file)
      expect(text, file).not.toMatch(/\bipcRenderer\b/)
      expect(text, file).not.toMatch(/from 'electron'/)
    }
  })
})

describe('preload surface', () =>
{
  let api: import('../../src/shared/ipc/api').WindowApi

  beforeEach(async () =>
  {
    vi.resetModules()
    electron.exposed.clear()
    electron.listeners.clear()
    electron.ipcRenderer.invoke.mockClear()
    electron.ipcRenderer.on.mockClear()
    electron.ipcRenderer.removeListener.mockClear()
    electron.webFrame.level = 0
    electron.webFrame.getZoomLevel.mockImplementation(() => electron.webFrame.level)
    electron.webFrame.setZoomLevel.mockImplementation((level: number) =>
    {
      electron.webFrame.level = level
    })
    electron.webFrame.getZoomFactor.mockImplementation(() => 1.2 ** electron.webFrame.level)
    electron.webFrame.setZoomFactor.mockImplementation((factor: number) =>
    {
      electron.webFrame.level = Math.log(factor) / Math.log(1.2)
    })
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
    await import('../../src/preload/index')
    api = electron.exposed.get('api') as typeof api
  })

  afterEach(() =>
  {
    delete (process as { contextIsolated?: boolean }).contextIsolated
  })

  it('exposes only window.api, and nothing in the source exposes or reads window.electron', () =>
  {
    expect([...electron.exposed.keys()]).toEqual(['api'])
    const preload = read('src/preload/index.ts')
    expect(preload).not.toContain('@electron-toolkit/preload')
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*'electron'/)
    expect(preload).toMatch(/const api: WindowApi = /)
    for (const file of RENDERER_FILES)
    {
      expect(read(file), file).not.toMatch(/window\.electron\b|electron: any/)
    }
  })

  it('declares Window.api as WindowApi with no untyped redeclaration left', () =>
  {
    expect(read('src/renderer/src/env.d.ts')).toMatch(/interface Window \{\s*api: WindowApi\s*\}/)
    for (const file of RENDERER_FILES)
    {
      expect(read(file), file).not.toMatch(/api\??: any\b/)
    }
  })

  it('generates one jobs wrapper per command plus onEvents', async () =>
  {
    expect(Object.keys(api.jobs).sort()).toEqual([...JOB_COMMAND_NAMES, 'onEvents'].sort())
    for (const name of JOB_COMMAND_NAMES)
    {
      electron.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: name })
      const call = api.jobs[name] as (req: unknown) => Promise<unknown>
      const req = { probe: name }
      await expect(call(req)).resolves.toEqual({ ok: true, value: name })
      expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(JOB_CHANNELS[name], req)
    }
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(JOB_COMMAND_NAMES.length)
  })

  it('delivers jobs:event batches until the subscription is dropped', () =>
  {
    const seen: unknown[] = []
    const stop = api.jobs.onEvents((batch) => seen.push(batch))
    const [listener] = [...electron.listeners.get(JOB_EVENT_CHANNEL)!]
    const batch = { events: [] }
    listener({}, batch)
    expect(seen).toEqual([batch])
    stop()
    expect(electron.listeners.get(JOB_EVENT_CHANNEL)!.size).toBe(0)
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(JOB_EVENT_CHANNEL, listener)
  })

  it('passes the log query to logs:getBuffer and listens to batched logs:entries only', () =>
  {
    void api.getLogBuffer({ afterId: 41, jobId: 'MM-0142' })
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('logs:getBuffer', { afterId: 41, jobId: 'MM-0142' })
    const seen: unknown[] = []
    const stop = api.onLogEntries((entries) => seen.push(entries))
    expect(electron.listeners.has('logs:entry')).toBe(false)
    const [listener] = [...electron.listeners.get('logs:entries')!]
    const entries = [{ id: 1, timestamp: 't', level: 'info', message: 'a' }]
    listener({}, entries)
    expect(seen).toEqual([entries])
    stop()
    expect(electron.listeners.get('logs:entries')!.size).toBe(0)
    expect('onLogEntry' in api).toBe(false)
  })

  it('reaches the FFmpeg build-information channels', () =>
  {
    void api.getFFmpegInfo()
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ffmpeg:info')
    void api.rerunFFmpegSelfTest()
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ffmpeg:selfTest')
    void api.installPinnedFFmpeg()
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ffmpeg:installPinned')
  })

  it('reaches the yt-dlp update channels and listens to its status until unsubscribed', () =>
  {
    void api.getYtDlpStatus()
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ytdlp:status')
    void api.checkYtDlpUpdates({ install: false })
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ytdlp:checkUpdates', { install: false })
    const seen: unknown[] = []
    const stop = api.onYtDlpStatus((status) => seen.push(status))
    const [listener] = [...electron.listeners.get('ytdlp:status-changed')!]
    listener({}, { installed: true })
    expect(seen).toEqual([{ installed: true }])
    stop()
    expect(electron.listeners.get('ytdlp:status-changed')!.size).toBe(0)
  })

  it('steps the page zoom through webFrame in half levels and answers the factor', () =>
  {
    expect(api.zoomIn()).toBeCloseTo(1.2 ** 0.5)
    expect(electron.webFrame.setZoomLevel).toHaveBeenLastCalledWith(0.5)
    expect(api.zoomIn()).toBeCloseTo(1.2)
    expect(api.zoomOut()).toBeCloseTo(1.2 ** 0.5)
    expect(api.zoomOut()).toBeCloseTo(1)
    expect(api.setZoomFactor(1.1)).toBeCloseTo(1.1)
    expect(api.getZoomFactor()).toBeCloseTo(1.1)
    expect(api.setZoomFactor(40)).toBeCloseTo(5)
    expect(api.setZoomFactor(Number.NaN)).toBeCloseTo(1)
  })
})

describe('zoom steps', async () =>
{
  const { ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN, ZOOM_LEVEL_STEP, clampZoomFactor, steppedZoomLevel, zoomLevelOf } = await import('../../src/shared/ipc/api')

  it('steps half a zoom level like the zoom menu roles', () =>
  {
    expect(ZOOM_LEVEL_STEP).toBe(0.5)
    expect(steppedZoomLevel(0, 1)).toBe(0.5)
    expect(steppedZoomLevel(0.5, -1)).toBe(0)
    expect(steppedZoomLevel(Number.NaN, 1)).toBe(0.5)
  })

  it('stays inside the zoom factor limits', () =>
  {
    expect(zoomLevelOf(1)).toBe(0)
    expect(steppedZoomLevel(zoomLevelOf(ZOOM_FACTOR_MAX), 1)).toBeCloseTo(zoomLevelOf(ZOOM_FACTOR_MAX))
    expect(steppedZoomLevel(zoomLevelOf(ZOOM_FACTOR_MIN), -1)).toBeCloseTo(zoomLevelOf(ZOOM_FACTOR_MIN))
    expect(clampZoomFactor(0.1)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(9)).toBe(ZOOM_FACTOR_MAX)
    expect(clampZoomFactor(1.25)).toBe(1.25)
    expect(clampZoomFactor(0)).toBe(1)
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

const appStore = vi.hoisted(() =>
{
  const state = { logs: [] as { id?: number; message: string }[], addLogs: vi.fn() }
  return { state, useAppStore: Object.assign(() => state, { getState: () => state, setState: vi.fn() }) }
})

vi.mock('../../src/renderer/src/stores/appStore', () => ({ useAppStore: appStore.useAppStore }))

type Entry = import('../../src/shared/ipc/api').LogEntry

function entry(id: number): Entry
{
  return { id, timestamp: `t${id}`, level: 'info', message: `line ${id}` }
}

/** A fake preload log surface whose buffer reply the test settles by hand. */
function fakeLogApi()
{
  const order: string[] = []
  let live: ((entries: Entry[]) => void) | null = null
  let settle: { resolve(entries: Entry[]): void; reject(err: unknown): void } | null = null
  const unsubscribe = vi.fn(() =>
  {
    live = null
  })
  const api = {
    onLogEntries: vi.fn((cb: (entries: Entry[]) => void) =>
    {
      order.push('subscribe')
      live = cb
      return unsubscribe
    }),
    getLogBuffer: vi.fn((query?: unknown) =>
    {
      order.push(`fetch ${JSON.stringify(query)}`)
      return new Promise<Entry[]>((resolve, reject) =>
      {
        settle = { resolve, reject }
      })
    })
  }
  return {
    api,
    order,
    unsubscribe,
    push: (entries: Entry[]) => live?.(entries),
    reply: async (entries: Entry[]) =>
    {
      settle!.resolve(entries)
      await Promise.resolve()
      await Promise.resolve()
    },
    fail: async (err: unknown) =>
    {
      settle!.reject(err)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

function memorySink(newest?: number)
{
  const added: number[] = []
  return { added, sink: { newestId: () => newest, add: (entries: Entry[]) => added.push(...entries.map((e) => e.id)) } }
}

describe('log hydration', async () =>
{
  const { startLogSync, appStoreLogSink } = await import('../../src/renderer/src/hooks/useIPC')

  it('subscribes to logs:entries before fetching the buffer', () =>
  {
    const fake = fakeLogApi()
    startLogSync(fake.api, memorySink().sink)
    expect(fake.order).toEqual(['subscribe', 'fetch {}'])
  })

  it('fetches after the newest id already held', () =>
  {
    const fake = fakeLogApi()
    startLogSync(fake.api, memorySink(41).sink)
    expect(fake.order).toEqual(['subscribe', 'fetch {"afterId":41}'])
  })

  it('applies each startup line once when live batches overlap the reply', async () =>
  {
    const fake = fakeLogApi()
    const { added, sink } = memorySink()
    startLogSync(fake.api, sink)
    fake.push([entry(3), entry(4)])
    fake.push([entry(5)])
    expect(added).toEqual([])
    await fake.reply([entry(1), entry(2), entry(3), entry(4)])
    expect(added).toEqual([1, 2, 3, 4, 5])
    fake.push([entry(5), entry(6)])
    fake.push([])
    expect(added).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('drops entries at or below the newest held id', async () =>
  {
    const fake = fakeLogApi()
    const { added, sink } = memorySink(10)
    startLogSync(fake.api, sink)
    await fake.reply([entry(9), entry(11)])
    fake.push([entry(10), entry(12)])
    expect(added).toEqual([11, 12])
  })

  it('keeps live lines flowing when the buffer cannot be read', async () =>
  {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fake = fakeLogApi()
    const { added, sink } = memorySink()
    startLogSync(fake.api, sink)
    fake.push([entry(7)])
    await fake.fail(new Error('gone'))
    fake.push([entry(8)])
    expect(added).toEqual([7, 8])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('ignores a reply or a failure that lands after it stopped', async () =>
  {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const settleLate of ['reply', 'fail'] as const)
    {
      const fake = fakeLogApi()
      const { added, sink } = memorySink()
      const stop = startLogSync(fake.api, sink)
      fake.push([entry(1)])
      stop()
      expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
      if (settleLate === 'reply')
      {
        await fake.reply([entry(1), entry(2)])
      }
      else
      {
        await fake.fail(new Error('late'))
      }
      expect(added).toEqual([])
    }
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('ignores a live batch delivered after it stopped', async () =>
  {
    const fake = fakeLogApi()
    const { added, sink } = memorySink()
    const stop = startLogSync(fake.api, sink)
    const deliver = fake.api.onLogEntries.mock.calls[0][0]
    await fake.reply([entry(1)])
    stop()
    deliver([entry(2)])
    expect(added).toEqual([1])
  })

  it('reads the newest id from the app store and appends a batch in one update', () =>
  {
    const sink = appStoreLogSink()
    appStore.state.logs = []
    expect(sink.newestId()).toBeUndefined()
    appStore.state.logs = [{ id: 4, message: 'a' }, { id: 9, message: 'b' }, { message: 'no id' }]
    expect(sink.newestId()).toBe(9)
    appStore.state.addLogs.mockClear()
    sink.add([entry(10), entry(11)])
    expect(appStore.state.addLogs).toHaveBeenCalledTimes(1)
    expect(appStore.state.addLogs.mock.calls[0][0].map((e: { id?: number }) => e.id)).toEqual([10, 11])
  })

  it('is what useIPC hydrates the store with, and nothing else reads the buffer at startup', () =>
  {
    const text = read('src/renderer/src/hooks/useIPC.ts')
    expect(text).toMatch(/startLogSync\(window\.api, appStoreLogSink\(\)\)/)
    expect(text).not.toMatch(/window\.api\.getLogBuffer|onLogEntry\b/)
  })
})

/**
 * First-run setup's main side: the problem a stopped download stands for, the download facts and folder picker
 * channels, and adopting a chosen folder with the same version check and self-test discovery runs, leaving the build
 * and config untouched when the folder is refused.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  openDialog: (..._a: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => Promise.resolve({ canceled: true, filePaths: [] }),
  dialogCalls: [] as unknown[][],
  inspect: (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  inspectCalls: [] as unknown[][],
  download: (..._a: unknown[]): Promise<unknown> => Promise.resolve({ ffmpeg: '', ffprobe: '' }),
  config: {} as Record<string, unknown>,
  savedFfmpeg: [] as unknown[],
  remembered: [] as unknown[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app'), getName: vi.fn(() => 'molex-media'), getVersion: vi.fn(() => '3.0.0'), quit: vi.fn(), isPackaged: true },
  ipcMain: { handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => m.handlers.set(channel, fn)), removeHandler: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: (contents: { window?: unknown }) => contents.window ?? null },
  webContents: { fromId: () => undefined },
  dialog: {
    showOpenDialog: (...a: unknown[]) =>
    {
      m.dialogCalls.push(a)
      return m.openDialog(...a)
    },
    showMessageBox: vi.fn(),
    showSaveDialog: vi.fn()
  },
  clipboard: { availableFormats: () => [], read: () => '', readBuffer: () => Buffer.alloc(0), readText: () => '' },
  nativeImage: { createFromPath: vi.fn() },
  Notification: class
  {
    static isSupported(): boolean
    {
      return false
    }
  },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: () => false },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('../../src/main/logger', () => ({
  logger: { ...m.log, child: () => ({ ...m.log, child: () => m.log }) }
}))

vi.mock('../../src/main/config', () => ({
  getConfig: async () => m.config,
  getFFmpegRoot: () => '/nonexistent/ffmpeg',
  getFFmpegBinDir: () => '/nonexistent/ffmpeg-bin',
  saveFfmpegConfig: async (block: unknown) =>
  {
    m.savedFfmpeg.push(block)
    m.config = { ...m.config, ffmpeg: block }
  },
  saveJobsConfig: async () => ({}),
  takeJobsAlerts: async () => []
}))

vi.mock('../../src/main/ffmpeg/bootstrap', () => ({
  inspectBuild: (...a: unknown[]) =>
  {
    m.inspectCalls.push(a)
    return m.inspect(...a)
  },
  downloadFFmpeg: (...a: unknown[]) => m.download(...a)
}))

vi.mock('../../src/main/ffmpeg/gpu', () => ({ detectGpuSummary: vi.fn(), resetGpuDetection: vi.fn() }))
vi.mock('../../src/main/ytdlp/binary', () => ({ initFFmpegDir: vi.fn(async () => undefined) }))
vi.mock('../../src/main/ipc/system', () => ({ rememberBuild: (info: unknown) => m.remembered.push(info) }))

import { executableName, SELF_TEST_IDS, type BuildCandidate, type FfmpegBuildInfo, type SelfTestId } from '../../src/main/ffmpeg/build'
import * as host from '../../src/main/ipc/jobs-host'
import { registerSetupIPC, setupProblemOf } from '../../src/main/ipc/setup'

function results(failing: SelfTestId[] = []): Record<SelfTestId, boolean>
{
  return Object.fromEntries(SELF_TEST_IDS.map((id) => [id, !failing.includes(id)])) as Record<SelfTestId, boolean>
}

function buildInfo(candidate: BuildCandidate, selfTest: Record<SelfTestId, boolean>, o: { meetsMinimum?: boolean; versionString?: string } = {}): FfmpegBuildInfo
{
  const st = fs.statSync(candidate.ffmpegPath)
  return {
    ffmpegPath: candidate.ffmpegPath,
    ffprobePath: candidate.ffprobePath,
    source: candidate.source,
    versionString: o.versionString ?? '8.0.1-full_build-www.gyan.dev',
    libs: { avutil: [60, 8, 100], avcodec: [62, 11, 100], avformat: [62, 3, 100], avfilter: [11, 4, 100], swresample: [6, 1, 100] },
    configuration: [],
    encoders: new Set(['aac', 'flac']),
    experimental: new Set(),
    soxr: selfTest.soxr,
    surroundMeter: selfTest['meter-surround'],
    meetsMinimum: o.meetsMinimum ?? true,
    selfTest,
    identity: { path: candidate.ffmpegPath, size: st.size, mtimeMs: st.mtimeMs }
  }
}

function makeTools(dir: string): void
{
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, executableName('ffmpeg', process.platform)), 'ffmpeg')
  fs.writeFileSync(path.join(dir, executableName('ffprobe', process.platform)), 'ffprobe')
}

describe('setup problems', () =>
{
  function coded(message: string, code: string, viaCause = false): Error
  {
    const err = new Error(message)
    if (viaCause)
    {
      (err as Error & { cause: unknown }).cause = { code }
    }
    else
    {
      (err as Error & { code: string }).code = code
    }
    return err
  }

  it('reads the error code first', () =>
  {
    expect(setupProblemOf(coded('ENOSPC: no space left on device, write', 'ENOSPC')).kind).toBe('disk-full')
    expect(setupProblemOf(coded('EEXIST: file already exists, mkdir', 'EEXIST')).kind).toBe('no-access')
    expect(setupProblemOf(coded('EPERM: operation not permitted', 'EPERM')).kind).toBe('no-access')
    expect(setupProblemOf(coded('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND')).kind).toBe('offline')
    expect(setupProblemOf(coded('fetch failed', 'ECONNRESET', true)).kind).toBe('offline')
  })

  it('reads the status and the message when there is no code', () =>
  {
    const gone = Object.assign(new Error('Download failed with status 404'), { status: 404 })
    expect(setupProblemOf(gone)).toEqual({ kind: 'unavailable', status: 404, detail: 'Download failed with status 404' })
    expect(setupProblemOf(new Error('Download failed with status 503'))).toEqual({ kind: 'server', status: 503, detail: 'Download failed with status 503' })
    expect(setupProblemOf(new Error('FFmpeg could not be downloaded for win32-ia32. Install FFmpeg 5.1 or newer and add it to PATH, or update molexMedia.')).kind).toBe('unavailable')
    expect(setupProblemOf(new Error('The download stalled')).kind).toBe('stalled')
    expect(setupProblemOf(new Error('Download did not match the expected checksum')).kind).toBe('checksum')
    expect(setupProblemOf(new Error('socket hang up')).kind).toBe('offline')
    expect(setupProblemOf(new Error('FFmpeg failed the encoders self-test')).kind).toBe('rejected')
    expect(setupProblemOf(new Error('FFmpeg 5.1 or newer is required; found 4.4')).kind).toBe('rejected')
    expect(setupProblemOf(new Error('Could not extract the FFmpeg download: tar exit 2')).kind).toBe('unknown')
    expect(setupProblemOf('plain text')).toEqual({ kind: 'unknown', status: null, detail: 'plain text' })
    expect(setupProblemOf(null).kind).toBe('unknown')
  })
})

describe('setup channels', () =>
{
  let dir: string
  const sender = { isDestroyed: () => false, window: { isDestroyed: () => false } }

  beforeAll(() =>
  {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molex-setup-'))
    registerSetupIPC()
  })

  afterAll(() =>
  {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() =>
  {
    m.inspectCalls.length = 0
    m.savedFfmpeg.length = 0
    m.remembered.length = 0
    m.dialogCalls.length = 0
    m.config = { ffmpeg: null, jobs: { recentFolders: [] } }
  })

  function call(channel: string, ...args: unknown[]): Promise<unknown>
  {
    const handler = m.handlers.get(channel)
    if (!handler)
    {
      throw new Error(`no handler for ${channel}`)
    }
    return Promise.resolve(handler({ sender }, ...args))
  }

  it('registers the download facts, picker, and adopt channels', () =>
  {
    expect([...m.handlers.keys()].sort()).toEqual(['ffmpeg:adoptFolder', 'ffmpeg:chooseFolder', 'ffmpeg:downloadFacts'])
  })

  it('answers the shipped pin\'s download facts for this host', async () =>
  {
    const facts = await call('ffmpeg:downloadFacts') as { bytes: number; publisher: string; host: string } | null
    if (facts !== null)
    {
      expect(facts.bytes).toBeGreaterThan(1_000_000)
      expect(facts.publisher.length).toBeGreaterThan(0)
    }
  })

  it('opens a folder picker on the calling window and answers the folder, or null when canceled', async () =>
  {
    m.openDialog = async () => ({ canceled: false, filePaths: ['D:\\Tools\\ffmpeg'] })
    expect(await call('ffmpeg:chooseFolder')).toBe('D:\\Tools\\ffmpeg')
    expect(m.dialogCalls[0][0]).toBe(sender.window)
    expect(m.dialogCalls[0][1]).toMatchObject({ title: 'Choose the folder that holds FFmpeg', properties: ['openDirectory'] })
    m.openDialog = async () => ({ canceled: true, filePaths: [] })
    expect(await call('ffmpeg:chooseFolder')).toBeNull()
    const orphan = m.handlers.get('ffmpeg:chooseFolder')!
    expect(await orphan({ sender: { isDestroyed: () => true } })).toBeNull()
  })

  it('refuses a folder argument that is not an absolute path', async () =>
  {
    expect(await call('ffmpeg:adoptFolder', 'relative\\ffmpeg')).toMatchObject({ status: 'refused', reason: 'missing' })
    expect(await call('ffmpeg:adoptFolder', 42)).toMatchObject({ status: 'refused', reason: 'missing', folder: '42' })
    expect(await call('ffmpeg:adoptFolder', undefined)).toMatchObject({ status: 'refused', folder: '' })
    expect(m.inspectCalls).toHaveLength(0)
  })

  it('refuses a folder with no FFmpeg in it or its bin folder', async () =>
  {
    const empty = path.join(dir, 'empty')
    fs.mkdirSync(empty)
    expect(await call('ffmpeg:adoptFolder', empty)).toEqual({ status: 'refused', folder: empty, reason: 'missing', version: null, failedTest: null })
    expect(m.inspectCalls).toHaveLength(0)
  })

  it('refuses tools that do not start, a build below 5.1, and a failed self-test, leaving the config alone', async () =>
  {
    const folder = path.join(dir, 'refused')
    makeTools(folder)
    m.inspect = async () => null
    expect(await call('ffmpeg:adoptFolder', folder)).toMatchObject({ status: 'refused', reason: 'not-running' })

    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results(), { meetsMinimum: false, versionString: '4.4.2-0ubuntu0.22.04.1' })
    expect(await call('ffmpeg:adoptFolder', folder)).toEqual({ status: 'refused', folder, reason: 'minimum', version: '4.4.2', failedTest: null })

    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results(['chain-opus-51side', 'soxr']))
    expect(await call('ffmpeg:adoptFolder', folder)).toEqual({ status: 'refused', folder, reason: 'self-test', version: '8.0.1', failedTest: 'chain-opus-51side' })
    expect(m.savedFfmpeg).toHaveLength(0)
    expect(host.currentBuildState().adopted).toBe(false)
  })

  it('adopts the build in the bin folder as a custom build and answers the build information', async () =>
  {
    const folder = path.join(dir, 'unpacked')
    makeTools(path.join(folder, 'bin'))
    m.inspect = async (c: unknown, record: unknown) =>
      buildInfo(c as BuildCandidate, record ? (record as { results: Record<SelfTestId, boolean> }).results : results(['meter-surround']))
    const answer = await call('ffmpeg:adoptFolder', folder) as { status: string; info: { usable: boolean; source: string; version: string; ffmpegPath: string } }
    expect(answer.status).toBe('adopted')
    expect(answer.info).toMatchObject({ usable: true, source: 'custom', version: '8.0.1' })
    expect(answer.info.ffmpegPath).toBe(path.join(folder, 'bin', executableName('ffmpeg', process.platform)))
    expect(m.inspectCalls[0][0]).toMatchObject({ source: 'custom', buildId: null })
    expect(m.savedFfmpeg).toHaveLength(1)
    expect(m.savedFfmpeg[0]).toMatchObject({ source: 'custom', ffmpegPath: answer.info.ffmpegPath })
    expect(m.remembered).toHaveLength(1)
    expect(host.currentBuildState()).toMatchObject({ adopted: true, refusal: null })
  })
})

describe('which build setup and discovery use', () =>
{
  let dir: string
  let pathDir: string
  let bundledDir: string
  let savedPath: string | undefined
  let pathTools: { ffmpeg: string; ffprobe: string }
  let bundledTools: { ffmpeg: string; ffprobe: string }

  function toolsIn(folder: string): { ffmpeg: string; ffprobe: string }
  {
    makeTools(folder)
    return { ffmpeg: path.join(folder, executableName('ffmpeg', process.platform)), ffprobe: path.join(folder, executableName('ffprobe', process.platform)) }
  }

  function passes(): void
  {
    m.inspect = async (c: unknown, record: unknown) =>
      buildInfo(c as BuildCandidate, record ? (record as { results: Record<SelfTestId, boolean> }).results : results(), {
        versionString: (c as BuildCandidate).source === 'bundled' ? 'n9.0.2-17-g2a571b6068' : '2022-10-13-git-9e8a327e68-full_build-www.gyan.dev'
      })
  }

  beforeAll(() =>
  {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molex-choice-'))
    pathDir = path.join(dir, 'path-bin')
    bundledDir = path.join(dir, 'ffmpeg', 'btbn-n9.0.2-17-g2a571b6068')
    pathTools = toolsIn(pathDir)
    bundledTools = toolsIn(bundledDir)
    savedPath = process.env['PATH']
    process.env['PATH'] = pathDir
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
    m.log.warn.mockClear()
    m.config = { ffmpeg: null, jobs: { recentFolders: [] } }
    passes()
  })

  it('offers a passing PATH build on a first run instead of using it, so setup shows', async () =>
  {
    const state = await host.checkFfmpeg()
    expect(state).toMatchObject({ adopted: false, info: null, refusal: null })
    expect(m.savedFfmpeg).toHaveLength(0)
    expect(host.ffmpegInfo()).toMatchObject({ found: false, usable: false, pathBuild: { version: '2022-10-13-git-9e8a327e68-full_build-www.gyan.dev', ffmpegPath: pathTools.ffmpeg } })
    expect(host.capabilitySummary({ build: state, gpu: null, rev: 1, cores: 4, platform: 'win32' }).ffmpeg.ready).toBe(false)
  })

  it('still names a refused PATH build, so setup can say why it is not used', async () =>
  {
    m.inspect = async (c: unknown) => buildInfo(c as BuildCandidate, results(), { meetsMinimum: false, versionString: '4.4.2' })
    const state = await host.checkFfmpeg()
    expect(state).toMatchObject({ adopted: false, refusal: 'FFmpeg 5.1 or newer is required; found 4.4.2' })
    expect(host.ffmpegInfo()).toMatchObject({ found: true, usable: false, pathBuild: null })
  })

  it('keeps using a PATH build the config already records', async () =>
  {
    m.config = { ffmpeg: { source: 'path', buildId: null, ffmpegPath: pathTools.ffmpeg, ffprobePath: pathTools.ffprobe, selfTest: null }, jobs: { recentFolders: [] } }
    const state = await host.checkFfmpeg()
    expect(state).toMatchObject({ adopted: true, candidate: { source: 'path', ffmpegPath: pathTools.ffmpeg } })
    expect(host.ffmpegInfo()).toMatchObject({ source: 'path', pathBuild: null, pin: { offerInstall: true } })
  })

  it('switches from a configured PATH build to the downloaded one, and a restart keeps it', async () =>
  {
    m.config = { ffmpeg: { source: 'path', buildId: null, ffmpegPath: pathTools.ffmpeg, ffprobePath: pathTools.ffprobe, selfTest: null }, jobs: { recentFolders: [] } }
    expect(await host.checkFfmpeg()).toMatchObject({ adopted: true, candidate: { source: 'path' } })
    m.download = async () => bundledTools

    const installed = await host.installPinnedFfmpeg(() => undefined)
    expect(installed).toMatchObject({ adopted: true, candidate: { source: 'bundled', buildId: 'btbn-n9.0.2-17-g2a571b6068', ffmpegPath: bundledTools.ffmpeg } })
    expect(m.savedFfmpeg.at(-1)).toMatchObject({ source: 'bundled', buildId: 'btbn-n9.0.2-17-g2a571b6068', ffmpegPath: bundledTools.ffmpeg })
    expect(host.ffmpegInfo()).toMatchObject({ source: 'bundled', version: '9.0.2', usable: true })

    const restarted = await host.checkFfmpeg()
    expect(restarted).toMatchObject({ adopted: true, candidate: { source: 'bundled', ffmpegPath: bundledTools.ffmpeg } })
  })

  it('falls back to discovery and says why when the installed build is refused', async () =>
  {
    m.config = { ffmpeg: { source: 'path', buildId: null, ffmpegPath: pathTools.ffmpeg, ffprobePath: pathTools.ffprobe, selfTest: null }, jobs: { recentFolders: [] } }
    m.download = async () => bundledTools
    m.inspect = async (c: unknown) => (c as BuildCandidate).source === 'bundled'
      ? buildInfo(c as BuildCandidate, results(['encoders']))
      : buildInfo(c as BuildCandidate, results())
    const state = await host.installPinnedFfmpeg(() => undefined)
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringContaining(`Not using the installed FFmpeg at ${bundledTools.ffmpeg}: FFmpeg failed the encoders self-test`))
    expect(state).toMatchObject({ adopted: true, candidate: { source: 'path' } })

    m.download = async () => ({ ffmpeg: path.join(dir, 'gone', 'ffmpeg.exe'), ffprobe: path.join(dir, 'gone', 'ffprobe.exe') })
    await host.installPinnedFfmpeg(() => undefined)
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringContaining('FFmpeg was not found at'))
  })

  it('adopts the offered PATH build only when setup chooses its folder', async () =>
  {
    await host.checkFfmpeg()
    const offer = host.ffmpegInfo().pathBuild
    expect(offer?.ffmpegPath).toBe(pathTools.ffmpeg)
    const adopted = await host.adoptFfmpegFolder(path.dirname(offer!.ffmpegPath))
    expect(adopted).toEqual({ adopted: true })
    expect(host.ffmpegInfo()).toMatchObject({ usable: true, source: 'custom', ffmpegPath: pathTools.ffmpeg, pathBuild: null })
    expect(m.savedFfmpeg.at(-1)).toMatchObject({ source: 'custom', ffmpegPath: pathTools.ffmpeg })
    expect(await host.checkFfmpeg()).toMatchObject({ adopted: true, candidate: { source: 'custom' } })
  })
})

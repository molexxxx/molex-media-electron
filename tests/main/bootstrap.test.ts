/**
 * The bootstrap's IO around the build policy: a real temporary user data folder, a fake HTTPS server, and a fake
 * ffmpeg that answers with the output recorded from the pinned 9.0.2 build and the 4.4.2 version output
 * (tests/main/fixtures/ffmpeg/build). Parsing and planning are covered by build.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const h = vi.hoisted(() => ({
  root: '',
  legacy: '',
  config: { ffmpeg: null as any, ffmpegPath: '', ffprobePath: '' },
  pin: { id: 'ffmpeg-9.0.2', version: '9.0.2', fetched: '2026-10-17', platforms: {} as Record<string, any> },
  saved: [] as any[],
  requests: [] as string[],
  responses: new Map<string, { status: number; body?: Buffer; location?: string }>(),
  spawns: [] as Array<{ bin: string; args: string[]; options: any }>,
  archiveContent: 'ffmpeg 9.0.2'
}))

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }
}))

vi.mock('../../src/main/config', () => ({
  getConfig: async () => h.config,
  getFFmpegRoot: () => h.root,
  getFFmpegBinDir: () => h.legacy,
  saveFfmpegConfig: async (block: any) => {
    h.saved.push(block)
    h.config = { ...h.config, ffmpeg: block, ffmpegPath: block?.ffmpegPath ?? '', ffprobePath: block?.ffprobePath ?? '' }
    return h.config
  }
}))

const mockInitFFmpegDir = vi.fn(async () => undefined)
vi.mock('../../src/main/ytdlp/binary', () => ({ initFFmpegDir: () => mockInitFFmpegDir() }))

const mockResetGpu = vi.fn()
vi.mock('../../src/main/ffmpeg/gpu', () => ({ resetGpuDetection: () => mockResetGpu() }))

vi.mock('../../src/main/ffmpeg/pinned-builds.json', () => ({ default: h.pin }))

function exe(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

const mockExtractZip = vi.fn(async (_zip: string, dest: string) => {
  const bin = path.join(dest, 'ffmpeg-n9.0.2-17-g2a571b6068-gpl-9.0', 'bin')
  await fs.promises.mkdir(bin, { recursive: true })
  await fs.promises.writeFile(path.join(bin, exe('ffmpeg')), h.archiveContent)
  await fs.promises.writeFile(path.join(bin, exe('ffprobe')), 'ffprobe 9.0.2')
  await fs.promises.writeFile(path.join(bin, exe('ffplay')), 'ffplay 9.0.2')
})
vi.mock('../../src/main/ffmpeg/unzip', () => ({ extractZip: (...a: any[]) => (mockExtractZip as any)(...a) }))

vi.mock('https', () => ({ get: (...a: any[]) => fakeGet(a[0], a[1], a[2]) }))
vi.mock('child_process', () => ({ spawn: (...a: any[]) => fakeSpawn(a[0], a[1], a[2]) }))

import { findSystemFFmpeg, getFFmpegVersion, downloadFFmpeg, type BootstrapProgress } from '../../src/main/ffmpeg/bootstrap'
import { CHECKSUM_MESSAGE, SELF_TESTS, SELF_TEST_IDS, SELF_TEST_REV, alternativesMessage } from '../../src/main/ffmpeg/build'
import { execArgv } from '../../src/main/ffmpeg/exec'
import { logger } from '../../src/main/logger'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ffmpeg', 'build')

interface RecordedRun {
  name: string
  argv: string[]
  code: number | null
  stdout: string | null
  stderr: string | null
}

const RUNS = (JSON.parse(fs.readFileSync(path.join(FIXTURES, 'selftest', '9.0.2', 'runs.json'), 'utf8')) as { runs: RecordedRun[] }).runs

function fixture(...parts: string[]): string {
  return fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8')
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Answers like the build named by the fake binary's file content. */
function answer(bin: string, args: string[]): { code: number; stdout?: string; stderr?: string; error?: Error } {
  if (bin === 'codesign' || bin === 'tar') return { code: 0 }
  if (!fs.existsSync(bin)) return { code: -4058, error: Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }) }
  const content = fs.readFileSync(bin, 'utf8')
  if (content === 'ffmpeg garbage') return { code: 0, stdout: 'hello' }
  const build = content.startsWith('ffmpeg 4.4.2') ? '4.4.2' : '9.0.2'
  if (sameArgs(args, ['-version'])) return { code: 0, stdout: fixture('info', build, 'version.stdout.txt') }
  if (args[args.length - 1] === '-encoders') return { code: 0, stdout: build === '9.0.2' ? fixture('info', '9.0.2', 'encoders.stdout.txt') : '' }
  const run = RUNS.find((r) => sameArgs(r.argv, args))
  if (!run) return { code: 1, stderr: '[error] unexpected arguments' }
  if (content.endsWith('no-opus') && run.name === 'chain-opus-51side') {
    return { code: 4294967274, stderr: "[error] Unknown encoder 'libopus'\n" }
  }
  return {
    code: run.code ?? 0,
    stdout: run.stdout ? fixture('selftest', '9.0.2', run.stdout) : undefined,
    stderr: run.stderr ? fixture('selftest', '9.0.2', run.stderr) : undefined
  }
}

function fakeSpawn(bin: string, args: string[], options: any) {
  h.spawns.push({ bin, args, options })
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  const reply = answer(bin, args)
  setTimeout(() => {
    if (reply.error) {
      proc.emit('error', reply.error)
      proc.emit('close', reply.code, null)
      return
    }
    if (reply.stdout) proc.stdout.emit('data', Buffer.from(reply.stdout))
    if (reply.stderr) proc.stderr.emit('data', Buffer.from(reply.stderr))
    proc.emit('close', reply.code, null)
  }, 0)
  return proc
}

function fakeGet(url: string, _options: unknown, callback: (res: any) => void) {
  h.requests.push(url)
  const req = new EventEmitter() as any
  req.setTimeout = vi.fn()
  req.destroy = vi.fn()
  const reply = h.responses.get(url) ?? { status: 404 }
  setTimeout(() => {
    const res = Readable.from(reply.body ? [reply.body] : []) as any
    res.statusCode = reply.status
    res.headers = reply.location ? { location: reply.location } : {}
    callback(res)
  }, 0)
  return req
}

const ARCHIVE = Buffer.from('pinned archive bytes')
const TAMPERED = Buffer.from('tampered archive byt')
const SHA256 = createHash('sha256').update(ARCHIVE).digest('hex')
const KEY = `${process.platform}-${process.arch}`
const PRIMARY = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-test-gpl-9.0.zip'
const REDIRECTED = 'https://release-assets.githubusercontent.com/github-production-release-asset/ffmpeg-test.zip'
const FALLBACK = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip'
const PRIMARY_ID = 'btbn-n9.0.2-17-g2a571b6068'
const FALLBACK_ID = 'gyan-9.0.2-full'

function asset(build: string, url: string) {
  return { build, url, bytes: ARCHIVE.length, sha256: SHA256, kind: 'zip', contains: ['ffmpeg', 'ffprobe'] }
}

function installed(id: string) {
  return { ffmpeg: path.join(h.root, id, exe('ffmpeg')), ffprobe: path.join(h.root, id, exe('ffprobe')) }
}

async function writeBuild(dir: string, content: string, withProbe = true): Promise<{ ffmpeg: string; ffprobe: string }> {
  await fs.promises.mkdir(dir, { recursive: true })
  const ffmpeg = path.join(dir, exe('ffmpeg'))
  const ffprobe = path.join(dir, exe('ffprobe'))
  await fs.promises.writeFile(ffmpeg, content)
  if (withProbe) await fs.promises.writeFile(ffprobe, 'ffprobe')
  return { ffmpeg, ffprobe }
}

function selfTestSpawns(bin: string): number {
  return h.spawns.filter((s) => s.bin === bin && SELF_TESTS.some((t) => sameArgs(s.args, execArgv(t.args, 'kill')))).length
}

const ALL_PASSED = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, true]))

let tmp = ''
let savedPath: string | undefined

beforeEach(async () => {
  vi.clearAllMocks()
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'molex-bootstrap-test-'))
  h.root = path.join(tmp, 'userData', 'ffmpeg')
  h.legacy = path.join(tmp, 'userData', 'ffmpeg-bin')
  h.config = { ffmpeg: null, ffmpegPath: '', ffprobePath: '' }
  h.pin.platforms = { [KEY]: { primary: [asset(PRIMARY_ID, PRIMARY)], fallback: [asset(FALLBACK_ID, FALLBACK)] } }
  h.saved = []
  h.requests = []
  h.spawns = []
  h.responses.clear()
  h.archiveContent = 'ffmpeg 9.0.2'
  savedPath = process.env.PATH
  process.env.PATH = path.join(tmp, 'path-bin')
})

afterEach(async () => {
  process.env.PATH = savedPath
  await fs.promises.rm(tmp, { recursive: true, force: true })
})

describe('downloadFFmpeg', () => {
  it('streams the pinned primary asset through SHA-256, installs it under its build id, and records it', async () => {
    h.responses.set(PRIMARY, { status: 302, location: REDIRECTED })
    h.responses.set(REDIRECTED, { status: 200, body: ARCHIVE })
    const staged = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('molex-ffmpeg-')))
    const progress: BootstrapProgress[] = []

    const paths = await downloadFFmpeg((p) => progress.push(p))

    expect(paths).toEqual(installed(PRIMARY_ID))
    expect(h.requests).toEqual([PRIMARY, REDIRECTED])
    expect(fs.readFileSync(paths.ffmpeg, 'utf8')).toBe('ffmpeg 9.0.2')
    expect(fs.existsSync(path.join(h.root, PRIMARY_ID, exe('ffplay')))).toBe(false)
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]).toMatchObject({
      source: 'bundled',
      buildId: PRIMARY_ID,
      ffmpegPath: paths.ffmpeg,
      ffprobePath: paths.ffprobe,
      selfTest: { rev: SELF_TEST_REV, results: ALL_PASSED, identity: { path: paths.ffmpeg, size: 'ffmpeg 9.0.2'.length } }
    })
    expect(mockInitFFmpegDir).toHaveBeenCalledTimes(1)
    expect(mockResetGpu).toHaveBeenCalledTimes(1)
    expect(selfTestSpawns(paths.ffmpeg)).toBe(SELF_TESTS.length)
    expect(h.spawns.every((s) => s.options?.windowsHide === true)).toBe(true)
    expect(progress[0].stage).toBe('checking')
    expect(progress.map((p) => p.stage)).toEqual(expect.arrayContaining(['downloading', 'extracting', 'verifying']))
    expect(progress[progress.length - 1]).toEqual({ stage: 'complete', message: 'FFmpeg is ready!', percent: 100 })
    expect(progress.filter((p) => p.stage === 'downloading').map((p) => p.percent)).toEqual([0, 100])
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('molex-ffmpeg-') && !staged.has(n))).toEqual([])
  })

  it('installs a platform held at another release under its build id and names that release, not the pin version', async () => {
    const held = 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1741000090_7.1.1/ffmpeg.zip'
    h.pin.platforms = { [KEY]: { version: '7.1.1', primary: [asset('mriedl-7.1.1', held)], fallback: [] } }
    h.responses.set(held, { status: 200, body: ARCHIVE })
    await fs.promises.mkdir(path.join(h.root, 'mriedl-9.0.2'), { recursive: true })
    const progress: BootstrapProgress[] = []

    const paths = await downloadFFmpeg((p) => progress.push(p))

    expect(paths).toEqual(installed('mriedl-7.1.1'))
    expect(h.saved[0]).toMatchObject({ source: 'bundled', buildId: 'mriedl-7.1.1' })
    expect(fs.readdirSync(h.root)).toEqual(['mriedl-7.1.1'])
    const downloading = progress.filter((p) => p.stage === 'downloading').map((p) => p.message)
    expect(downloading[0]).toBe('Downloading FFmpeg 7.1.1...')
    expect(downloading.every((m) => m.startsWith('Downloading FFmpeg 7.1.1...'))).toBe(true)
    expect(logger.success).toHaveBeenCalledWith(`FFmpeg 7.1.1 installed into ${path.join(h.root, 'mriedl-7.1.1')} and verified`)
  })

  it('removes older pinned builds and interrupted staging folders and keeps everything else', async () => {
    h.responses.set(PRIMARY, { status: 200, body: ARCHIVE })
    for (const name of ['btbn-n8.1.3-9-g1234abcd', 'gyan-8.1.2-full', `${PRIMARY_ID}.part-1a2b3c`, 'custom-tools']) {
      await fs.promises.mkdir(path.join(h.root, name), { recursive: true })
    }

    await downloadFFmpeg(() => undefined)

    expect(fs.readdirSync(h.root).sort()).toEqual(['custom-tools', PRIMARY_ID].sort())
  })

  it('deletes a download whose digest or size does not match the pin and installs nothing', async () => {
    h.responses.set(PRIMARY, { status: 200, body: TAMPERED })
    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow(CHECKSUM_MESSAGE)
    h.responses.set(PRIMARY, { status: 200, body: Buffer.concat([ARCHIVE, Buffer.from('x')]) })
    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow(CHECKSUM_MESSAGE)

    expect(mockExtractZip).not.toHaveBeenCalled()
    expect(h.saved).toEqual([])
    expect(fs.readdirSync(h.root)).toEqual([])
  })

  it('falls back to the pinned fallback build after the primary answers 404', async () => {
    h.responses.set(PRIMARY, { status: 404 })
    h.responses.set(FALLBACK, { status: 200, body: ARCHIVE })

    const paths = await downloadFFmpeg(() => undefined)

    expect(paths).toEqual(installed(FALLBACK_ID))
    expect(h.requests).toEqual([PRIMARY, FALLBACK])
    expect(h.saved[0]).toMatchObject({ source: 'bundled', buildId: FALLBACK_ID })
  })

  it('offers the alternatives when the primary and the fallback answer 410', async () => {
    h.responses.set(PRIMARY, { status: 410 })
    h.responses.set(FALLBACK, { status: 410 })
    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow(alternativesMessage(KEY))
    expect(h.requests).toEqual([PRIMARY, FALLBACK])
  })

  it('reports a server error without trying the fallback', async () => {
    h.responses.set(PRIMARY, { status: 503 })
    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow('Download failed with status 503')
    expect(h.requests).toEqual([PRIMARY])
  })

  it('refuses a redirect away from HTTPS', async () => {
    h.responses.set(PRIMARY, { status: 302, location: 'http://example.com/ffmpeg.zip' })
    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow('Refusing a download over http')
    expect(h.requests).toEqual([PRIMARY])
  })

  it('offers the alternatives for a host the pin does not cover', async () => {
    h.pin.platforms = {}
    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow(alternativesMessage(KEY))
    expect(h.requests).toEqual([])
  })

  it('reuses an installed pinned folder without downloading', async () => {
    const paths = await writeBuild(path.join(h.root, PRIMARY_ID), 'ffmpeg 9.0.2')

    await expect(downloadFFmpeg(() => undefined)).resolves.toEqual(paths)

    expect(h.requests).toEqual([])
    expect(h.saved[0]).toMatchObject({ source: 'bundled', buildId: PRIMARY_ID, ffmpegPath: paths.ffmpeg })
  })

  it('replaces an installed pinned folder that fails the self-test', async () => {
    await writeBuild(path.join(h.root, PRIMARY_ID), 'ffmpeg 9.0.2 no-opus')
    h.responses.set(PRIMARY, { status: 200, body: ARCHIVE })

    const paths = await downloadFFmpeg(() => undefined)

    expect(h.requests).toEqual([PRIMARY])
    expect(fs.readFileSync(paths.ffmpeg, 'utf8')).toBe('ffmpeg 9.0.2')
  })

  it('removes a new install that fails the self-test and names the failing test', async () => {
    h.archiveContent = 'ffmpeg 9.0.2 no-opus'
    h.responses.set(PRIMARY, { status: 200, body: ARCHIVE })

    await expect(downloadFFmpeg(() => undefined)).rejects.toThrow('FFmpeg failed the chain-opus-51side self-test')

    expect(fs.readdirSync(h.root)).toEqual([])
    expect(h.saved).toEqual([])
  })
})

describe('findSystemFFmpeg', () => {
  it('refuses a 4.4.2 build on PATH with the minimum message and runs no self-test', async () => {
    const old = await writeBuild(path.join(tmp, 'path-bin'), 'ffmpeg 4.4.2')

    await expect(findSystemFFmpeg()).resolves.toBeNull()

    expect(vi.mocked(logger.warn).mock.calls.map((c) => c[0])).toContain(`Skipping FFmpeg at ${old.ffmpeg}: FFmpeg 5.1 or newer is required; found 4.4.2`)
    expect(selfTestSpawns(old.ffmpeg)).toBe(0)
    expect(h.saved).toEqual([])
  })

  it('accepts a PATH build at or above 5.1 and records it as a path build', async () => {
    const found = await writeBuild(path.join(tmp, 'path-bin'), 'ffmpeg 9.0.2')

    await expect(findSystemFFmpeg()).resolves.toEqual(found)

    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]).toMatchObject({ source: 'path', buildId: null, ffmpegPath: found.ffmpeg, ffprobePath: found.ffprobe, selfTest: { results: ALL_PASSED } })
    expect(selfTestSpawns(found.ffmpeg)).toBe(SELF_TESTS.length)
  })

  it('reuses the cached self-test while the binary identity is unchanged', async () => {
    const found = await writeBuild(path.join(tmp, 'path-bin'), 'ffmpeg 9.0.2')
    await findSystemFFmpeg()
    h.spawns = []

    await expect(findSystemFFmpeg()).resolves.toEqual(found)

    expect(selfTestSpawns(found.ffmpeg)).toBe(0)
    expect(h.saved).toHaveLength(1)
    expect(mockInitFFmpegDir).toHaveBeenCalledTimes(1)
  })

  it('prefers the configured build over PATH', async () => {
    const custom = await writeBuild(path.join(tmp, 'tools'), 'ffmpeg 9.0.2')
    await writeBuild(path.join(tmp, 'path-bin'), 'ffmpeg 9.0.2')
    h.config = { ffmpeg: { source: 'custom', buildId: null, ffmpegPath: custom.ffmpeg, ffprobePath: custom.ffprobe, selfTest: null }, ffmpegPath: custom.ffmpeg, ffprobePath: custom.ffprobe }

    await expect(findSystemFFmpeg()).resolves.toEqual(custom)
    expect(h.saved[0]).toMatchObject({ source: 'custom', ffmpegPath: custom.ffmpeg })
  })

  it('finds the folder older versions installed into', async () => {
    const legacy = await writeBuild(h.legacy, 'ffmpeg 9.0.2')
    await expect(findSystemFFmpeg()).resolves.toEqual(legacy)
    expect(h.saved[0]).toMatchObject({ source: 'bundled', buildId: null })
  })

  it('returns null when no folder holds both tools', async () => {
    await writeBuild(path.join(tmp, 'path-bin'), 'ffmpeg 9.0.2', false)
    await expect(findSystemFFmpeg()).resolves.toBeNull()
    expect(h.spawns).toEqual([])
  })
})

describe('getFFmpegVersion', () => {
  it('returns the version token of the pinned build', async () => {
    const build = await writeBuild(path.join(tmp, 'v'), 'ffmpeg 9.0.2')
    await expect(getFFmpegVersion(build.ffmpeg)).resolves.toBe('n9.0.2-17-g2a571b6068-20260930')
  })

  it('returns "unknown" when the output has no version line', async () => {
    const build = await writeBuild(path.join(tmp, 'v'), 'ffmpeg garbage')
    await expect(getFFmpegVersion(build.ffmpeg)).resolves.toBe('unknown')
  })

  it('returns "error" when the binary cannot be spawned', async () => {
    await expect(getFFmpegVersion(path.join(tmp, 'missing', exe('ffmpeg')))).resolves.toBe('error')
  })
})

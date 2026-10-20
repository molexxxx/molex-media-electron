import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CACHE_LIMIT,
  IDLE_CONCURRENCY,
  ProbeFailure,
  RUN_CONCURRENCY,
  createProbeQueue,
  probeFailure,
  toMediaSummary,
  toProbedSource,
  uncShareRoot,
  type ProbeQueueDeps
} from '../../../src/main/jobs/probe-queue'
import { createProbe, parseProbeJson, type Probe, type ProbeJson, type ProbeStream } from '../../../src/main/ffmpeg/probe'
import type { Platform } from '../../../src/shared/text/platform'
import { createManualTimers } from '../helpers/manual-timers'

const FIXTURES = join(__dirname, '..', 'fixtures', 'ffmpeg', 'probe', '9.0.2')

function recorded(name: string): ProbeJson
{
  return parseProbeJson(readFileSync(join(FIXTURES, `${name}.stdout.txt`), 'utf8'))
}

const MKV = recorded('video-multi.mkv')

interface Call
{
  path: string
  signal: AbortSignal
  resolve(json: ProbeJson): void
  reject(err: unknown): void
}

interface Rig
{
  queue: ReturnType<typeof createProbeQueue>
  calls: Call[]
  files: Map<string, { size: number; mtimeMs: number; dir?: boolean }>
  timers: ReturnType<typeof createManualTimers>
}

function rig(over: Partial<ProbeQueueDeps> = {}, platform: Platform = 'win32'): Rig
{
  const calls: Call[] = []
  const files = new Map<string, { size: number; mtimeMs: number; dir?: boolean }>()
  const timers = createManualTimers()
  const probe: Probe = (path, signal) => new Promise((resolve, reject) =>
  {
    calls.push({ path, signal: signal as AbortSignal, resolve, reject })
  })
  const queue = createProbeQueue({
    probe,
    timers,
    platform,
    stat: async (path) =>
    {
      const file = files.get(path) ?? { size: 100, mtimeMs: 1 }
      return { size: file.size, mtimeMs: file.mtimeMs, isFile: () => file.dir !== true }
    },
    ...over
  })
  return { queue, calls, files, timers }
}

function turn(): Promise<void>
{
  return new Promise((resolve) => setImmediate(resolve))
}

function failure(err: unknown): ProbeFailure
{
  expect(err).toBeInstanceOf(ProbeFailure)
  return err as ProbeFailure
}

function errno(code: string): NodeJS.ErrnoException
{
  const err = new Error(`${code}: injected`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('createProbeQueue concurrency', () =>
{
  it('runs four probes at once while idle', async () =>
  {
    const r = rig()
    const results = Array.from({ length: 6 }, (_, i) => r.queue.probeSource(`C:\\m\\${i}.mkv`))
    await turn()
    expect(r.calls.map((c) => c.path)).toEqual(['C:\\m\\0.mkv', 'C:\\m\\1.mkv', 'C:\\m\\2.mkv', 'C:\\m\\3.mkv'])
    expect(r.queue.stats()).toEqual({ waiting: 2, running: 4, cached: 0, limit: IDLE_CONCURRENCY })
    r.calls[0].resolve(MKV)
    await turn()
    expect(r.calls).toHaveLength(5)
    for (const call of r.calls.slice(1)) call.resolve(MKV)
    await turn()
    r.calls[5].resolve(MKV)
    const sources = await Promise.all(results)
    expect(sources.map((s) => s.path)).toEqual(Array.from({ length: 6 }, (_, i) => `C:\\m\\${i}.mkv`))
    expect(r.queue.stats()).toMatchObject({ waiting: 0, running: 0, cached: 6 })
  })

  it('runs two at once during a run and four again after it', async () =>
  {
    const r = rig()
    const results = Array.from({ length: 7 }, (_, i) => r.queue.probeSource(`C:\\m\\${i}.mkv`))
    await turn()
    r.queue.setRunning(true)
    expect(r.queue.stats().limit).toBe(RUN_CONCURRENCY)
    r.calls[0].resolve(MKV)
    r.calls[1].resolve(MKV)
    await turn()
    expect(r.calls).toHaveLength(4)
    r.calls[2].resolve(MKV)
    await turn()
    expect(r.calls).toHaveLength(5)
    expect(r.queue.stats().running).toBe(2)
    r.queue.setRunning(false)
    expect(r.calls).toHaveLength(7)
    for (const call of r.calls.slice(3)) call.resolve(MKV)
    await Promise.all(results)
  })

  it('runs one probe at a time per network share root', async () =>
  {
    const r = rig()
    const paths = ['\\\\NAS\\Media\\a.mkv', '\\\\nas\\media\\b.mkv', '\\\\nas\\other\\c.mkv', 'D:\\local\\d.mkv', '//nas/media/e.mkv']
    const results = paths.map((p) => r.queue.probeSource(p))
    await turn()
    expect(r.calls.map((c) => c.path)).toEqual(['\\\\NAS\\Media\\a.mkv', '\\\\nas\\other\\c.mkv', 'D:\\local\\d.mkv'])
    r.calls[0].resolve(MKV)
    await turn()
    expect(r.calls.map((c) => c.path).slice(3)).toEqual(['\\\\nas\\media\\b.mkv'])
    r.calls[3].resolve(MKV)
    await turn()
    expect(r.calls[4].path).toBe('//nas/media/e.mkv')
    for (const call of r.calls.slice(1)) call.resolve(MKV)
    await Promise.all(results)
  })

  it('serializes a share named by the injected share root and none on POSIX by default', async () =>
  {
    const mapped = rig({ shareRoot: (p) => (p.startsWith('Z:') ? 'z:' : null) })
    void mapped.queue.probeSource('Z:\\a.mkv')
    void mapped.queue.probeSource('Z:\\b.mkv')
    await turn()
    expect(mapped.calls).toHaveLength(1)
    const posix = rig({}, 'linux')
    void posix.queue.probeSource('//nas/media/a.mkv')
    void posix.queue.probeSource('//nas/media/b.mkv')
    await turn()
    expect(posix.calls).toHaveLength(2)
  })
})

describe('createProbeQueue identity and cache', () =>
{
  it('keeps one probe in flight per source identity', async () =>
  {
    const r = rig()
    const first = r.queue.probeSource('C:\\m\\a.mkv')
    const second = r.queue.probeSource('c:\\M\\A.mkv')
    await turn()
    expect(r.calls).toHaveLength(1)
    r.calls[0].resolve(MKV)
    const [a, b] = await Promise.all([first, second])
    expect(b).toBe(a)
  })

  it('probes a changed source again and caches by path, size, and modification time', async () =>
  {
    const r = rig()
    const path = 'C:\\m\\a.mkv'
    r.files.set(path, { size: 100, mtimeMs: 5 })
    const first = r.queue.probeSource(path)
    await turn()
    r.calls[0].resolve(MKV)
    const a = await first
    expect(a).toMatchObject({ path, size: 100, mtimeMs: 5 })
    expect(await r.queue.probeSource(path)).toBe(a)
    expect(r.calls).toHaveLength(1)
    r.files.set(path, { size: 100, mtimeMs: 6 })
    const touched = r.queue.probeSource(path)
    await turn()
    expect(r.calls).toHaveLength(2)
    r.calls[1].resolve(MKV)
    expect((await touched).mtimeMs).toBe(6)
    r.files.set(path, { size: 101, mtimeMs: 6 })
    const grown = r.queue.probeSource(path)
    await turn()
    expect(r.calls).toHaveLength(3)
    r.calls[2].resolve(MKV)
    await grown
    expect(r.queue.stats().cached).toBe(3)
    r.queue.invalidate('C:\\M\\a.mkv')
    expect(r.queue.stats().cached).toBe(0)
    r.queue.invalidate(path)
    const again = r.queue.probeSource(path)
    await turn()
    expect(r.calls).toHaveLength(4)
    r.calls[3].resolve(MKV)
    await again
  })

  it('evicts the least recently used probe past the cache limit', async () =>
  {
    const r = rig({ cacheLimit: 2 })
    const probeNow = async (path: string): Promise<void> =>
    {
      const pending = r.queue.probeSource(path)
      await turn()
      r.calls.at(-1)?.resolve(MKV)
      await pending
    }
    await probeNow('C:\\a.mkv')
    await probeNow('C:\\b.mkv')
    await r.queue.probeSource('C:\\a.mkv')
    await probeNow('C:\\c.mkv')
    expect(r.calls).toHaveLength(3)
    await r.queue.probeSource('C:\\a.mkv')
    expect(r.calls).toHaveLength(3)
    const b = r.queue.probeSource('C:\\b.mkv')
    await turn()
    expect(r.calls).toHaveLength(4)
    r.calls[3].resolve(MKV)
    await b
    expect(CACHE_LIMIT).toBe(20_000)
  })

  it('does not cache failures', async () =>
  {
    const r = rig()
    const first = r.queue.probeSource('C:\\a.mkv')
    await turn()
    r.calls[0].reject(new Error('ffprobe exited with 1: C:\\a.mkv: Invalid data found when processing input'))
    expect(failure(await first.catch((e) => e)).code).toBe('not-media')
    const second = r.queue.probeSource('C:\\a.mkv')
    await turn()
    expect(r.calls).toHaveLength(2)
    r.calls[1].resolve(MKV)
    await second
  })

  it('returns the facts through the engine seam', async () =>
  {
    const r = rig()
    const facts = r.queue.probe('C:\\m\\a.mkv')
    await turn()
    r.calls[0].resolve(MKV)
    expect(await facts).toMatchObject({ path: 'C:\\m\\a.mkv', container: 'mkv', chapters: 2 })
  })
})

describe('createProbeQueue timeout and abort', () =>
{
  it('aborts a probe that runs past the time limit and reports it', async () =>
  {
    const r = rig({ timeoutMs: 30_000 })
    const pending = r.queue.probeSource('C:\\slow.mkv').catch((e: unknown) => e)
    await turn()
    const call = r.calls[0]
    call.signal.addEventListener('abort', () => call.reject(Object.assign(new Error('The probe was canceled'), { name: 'AbortError' })))
    await r.timers.advance(29_999)
    expect(call.signal.aborted).toBe(false)
    await r.timers.advance(1)
    expect(call.signal.aborted).toBe(true)
    const err = failure(await pending)
    expect(err.code).toBe('probe-failed')
    expect(err.message).toBe('ffprobe did not finish within 30 s')
    expect(r.queue.stats()).toMatchObject({ running: 0, cached: 0 })
  })

  it('kills ffprobe when every caller aborts, and only then', async () =>
  {
    const children: FakeChild[] = []
    const spawn = vi.fn(() =>
    {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const queue = createProbeQueue({
      probe: createProbe('ffprobe', { spawn: spawn as never }),
      timers: createManualTimers(),
      platform: 'win32',
      stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true })
    })
    const one = new AbortController()
    const two = new AbortController()
    const first = queue.probeSource('C:\\a.mkv', { signal: one.signal })
    const second = queue.probeSource('C:\\a.mkv', { signal: two.signal })
    await turn()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]).toEqual(['ffprobe', expect.arrayContaining(['-show_streams', 'C:\\a.mkv']), { windowsHide: true }])
    one.abort()
    expect(failure(await first.catch((e) => e)).code).toBe('canceled')
    expect(children[0].kill).not.toHaveBeenCalled()
    two.abort()
    const err = failure(await second.catch((e) => e))
    expect(err.code).toBe('canceled')
    expect(err.name).toBe('AbortError')
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    await turn()
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0, cached: 0 })
  })

  it('kills ffprobe on the time limit through the real probe', async () =>
  {
    const child = new FakeChild()
    const timers = createManualTimers()
    const queue = createProbeQueue({
      probe: createProbe('ffprobe', { spawn: (() => child) as never }),
      timers,
      platform: 'linux',
      stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }),
      timeoutMs: 1500
    })
    const pending = queue.probeSource('/m/a.mkv').catch((e: unknown) => e)
    await turn()
    await timers.advance(1500)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(failure(await pending).message).toBe('ffprobe did not finish within 2 s')
  })

  it('drops a waiting probe whose callers all aborted before it started', async () =>
  {
    const r = rig()
    for (let i = 0; i < 4; i++) void r.queue.probeSource(`C:\\busy${i}.mkv`)
    const controller = new AbortController()
    const queued = r.queue.probeSource('C:\\queued.mkv', { signal: controller.signal })
    await turn()
    expect(r.queue.stats().waiting).toBe(1)
    controller.abort()
    expect(failure(await queued.catch((e) => e)).code).toBe('canceled')
    expect(r.queue.stats().waiting).toBe(0)
    r.calls[0].resolve(MKV)
    await turn()
    expect(r.calls.map((c) => c.path)).not.toContain('C:\\queued.mkv')
    const fresh = r.queue.probeSource('C:\\queued.mkv')
    await turn()
    expect(r.calls.at(-1)?.path).toBe('C:\\queued.mkv')
    r.calls.at(-1)?.resolve(MKV)
    await fresh
  })

  it('starts a new probe for a source whose aborted probe is still ending', async () =>
  {
    const r = rig()
    const controller = new AbortController()
    const first = r.queue.probeSource('C:\\a.mkv', { signal: controller.signal })
    await turn()
    controller.abort()
    await first.catch(() => null)
    const second = r.queue.probeSource('C:\\a.mkv')
    await turn()
    expect(r.calls).toHaveLength(2)
    r.calls[0].resolve(MKV)
    await turn()
    expect(r.queue.stats().cached).toBe(0)
    r.calls[1].resolve(MKV)
    await second
    expect(r.queue.stats().cached).toBe(1)
  })

  it('answers canceled for an aborted signal before and during the stat', async () =>
  {
    const r = rig()
    expect(failure(await r.queue.probeSource('C:\\a.mkv', { signal: AbortSignal.abort() }).catch((e) => e)).code).toBe('canceled')
    const controller = new AbortController()
    const slow = rig({
      stat: async () =>
      {
        controller.abort()
        return { size: 1, mtimeMs: 1, isFile: () => true }
      }
    })
    expect(failure(await slow.queue.probeSource('C:\\a.mkv', { signal: controller.signal }).catch((e) => e)).code).toBe('canceled')
    expect(slow.calls).toHaveLength(0)
  })
})

describe('createProbeQueue failures', () =>
{
  it.each([
    ['ENOENT', 'source-missing', 'The source is missing: C:\\a.mkv'],
    ['ENOTDIR', 'source-missing', 'The source is missing: C:\\a.mkv'],
    ['EACCES', 'source-unreadable', 'The source could not be read (access denied): C:\\a.mkv'],
    ['EPERM', 'source-unreadable', 'The source could not be read (access denied): C:\\a.mkv'],
    ['EIO', 'source-unreadable', 'The source could not be read: EIO: injected']
  ])('maps a stat error %s to %s', async (code, expected, message) =>
  {
    const r = rig({ stat: () => Promise.reject(errno(code)) })
    const err = failure(await r.queue.probeSource('C:\\a.mkv').catch((e) => e))
    expect(err.code).toBe(expected)
    expect(err.message).toBe(message)
  })

  it('maps a stat rejection that is not an Error', async () =>
  {
    const r = rig({ stat: () => Promise.reject('gone') })
    expect(failure(await r.queue.probeSource('C:\\a.mkv').catch((e) => e)).message).toBe('The source could not be read: gone')
  })

  it('refuses a folder as not media', async () =>
  {
    const r = rig()
    r.files.set('C:\\dir.mkv', { size: 0, mtimeMs: 1, dir: true })
    expect(failure(await r.queue.probeSource('C:\\dir.mkv').catch((e) => e)).code).toBe('not-media')
  })

  it.each([
    ['ffprobe exited with 1: x.mp3: Invalid data found when processing input', 'not-media'],
    ['ffprobe exited with 1: x.mp3: Permission denied', 'source-unreadable'],
    ['ffprobe exited with 1: x.mp3: No such file or directory', 'source-missing'],
    ['ffprobe exited with 3: something else', 'probe-failed'],
    ['spawn ffprobe ENOENT', 'probe-failed']
  ])('maps the ffprobe error "%s" to %s', async (message, expected) =>
  {
    const r = rig()
    const pending = r.queue.probeSource('C:\\x.mp3')
    await turn()
    r.calls[0].reject(new Error(message))
    expect(failure(await pending.catch((e) => e)).code).toBe(expected)
  })

  it('refuses a probe with neither audio nor a picture', async () =>
  {
    const r = rig()
    const pending = r.queue.probeSource('C:\\x.srt')
    await turn()
    r.calls[0].resolve({ streams: [{ index: 0, codec_type: 'subtitle', codec_name: 'subrip' }], format: { format_name: 'srt' }, chapters: [] })
    const err = failure(await pending.catch((e) => e))
    expect(err.code).toBe('not-media')
    expect(err.message).toBe('The file has no audio or video stream.')
  })

  it('passes a ProbeFailure through and wraps anything else', () =>
  {
    const known = new ProbeFailure('source-missing', 'gone')
    expect(probeFailure(known)).toBe(known)
    expect(probeFailure('text').message).toBe('text')
    expect(new ProbeFailure('not-media', 'x').name).toBe('ProbeFailure')
  })
})

describe('toMediaSummary on recorded probes', () =>
{
  it('summarizes a Matroska file with two audio streams, subtitles, an attachment, and chapters', () =>
  {
    const source = toProbedSource(MKV, { path: 'D:\\Rips\\video-multi.mkv', size: 10, mtimeMs: 2 })
    expect(source.facts.audio).toHaveLength(2)
    expect(source.summary).toEqual({
      container: 'mkv',
      durationSec: 20.021,
      video: { codec: 'h264', width: 320, height: 180, rotation: 0, fps: 25 },
      audio: [
        { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: null, bitrateKbps: null, language: 'eng', isDefault: true },
        { codec: 'ac3', channels: 6, layout: '5.1(side)', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 448, language: 'jpn', isDefault: false }
      ],
      subtitles: 1,
      attachments: 1,
      chapters: 2,
      cover: false
    })
  })

  it('fills isDefault from each audio stream disposition in an MP4', () =>
  {
    const source = toProbedSource(recorded('video-multi.mp4'), { path: '/m/video-multi.mp4', size: 1, mtimeMs: 1 })
    expect(source.summary.audio.map((a) => [a.language, a.isDefault])).toEqual([['eng', true], ['spa', false]])
    expect(source.summary.audio[0].bitrateKbps).toBe(192)
  })

  it('treats cover art as a cover, not a picture', () =>
  {
    const source = toProbedSource(recorded('cover.mp3'), { path: '/m/cover.mp3', size: 1, mtimeMs: 1 })
    expect(source.summary).toMatchObject({ container: 'mp3', video: null, cover: true, durationSec: 20 })
    expect(source.summary.audio[0]).toMatchObject({ codec: 'mp3', isDefault: false, bitrateKbps: 256 })
    expect(recorded('hires96.flac').streams[0].codec_type).toBe('audio')
    expect(toProbedSource(recorded('hires96.flac'), { path: '/m/hires96.flac', size: 1, mtimeMs: 1 }).summary.audio[0].bitsPerSample).toBe(24)
  })

  it('reads rotation from the display matrix or the rotate tag, and frame rates in every form', () =>
  {
    const picture = (extra: Partial<ProbeStream> & Record<string, unknown>): ProbeJson => ({
      streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, ...extra }],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '0' },
      chapters: []
    })
    const summary = (json: ProbeJson): ReturnType<typeof toMediaSummary> => toProbedSource(json, { path: '/m/p.mov', size: 1, mtimeMs: 1 }).summary
    expect(summary(picture({ side_data_list: [{ side_data_type: 'x' }, { rotation: -90 }], avg_frame_rate: '30000/1001' })).video)
      .toMatchObject({ rotation: -90, fps: 29.97 })
    expect(summary(picture({ side_data_list: [{ rotation: -0 }], r_frame_rate: '24' })).video).toMatchObject({ rotation: 0, fps: 24 })
    expect(summary(picture({ tags: { rotate: '90' }, avg_frame_rate: '0/0', r_frame_rate: '25/1' })).video).toMatchObject({ rotation: -90, fps: 25 })
    expect(summary(picture({ side_data_list: 'none', tags: { rotate: '0' } })).video).toMatchObject({ rotation: 0, fps: null })
    expect(summary(picture({ width: undefined, height: undefined, codec_name: undefined })).video).toMatchObject({ codec: 'unknown', width: 0, height: 0 })
    expect(summary(picture({})).durationSec).toBeNull()
  })

  it('reads the raw bit depth and copes with sparse probes', () =>
  {
    const json: ProbeJson = {
      streams: [{ index: 3, channels: 2, codec_name: 'pcm_s24le', codec_type: 'audio', sample_rate: '48000', bits_per_sample: 24, disposition: { default: 1 } }],
      format: null,
      chapters: [{ id: 0 }]
    }
    const source = toProbedSource(json, { path: '/m/a.wav', size: 1, mtimeMs: 1 })
    expect(source.summary.audio[0]).toMatchObject({ bitsPerSample: 24, isDefault: true })
    expect(source.summary.chapters).toBe(1)
    const facts = { ...source.facts, audio: [{ ...source.facts.audio[0], streamIndex: 99, bitsPerRawSample: 16 }] }
    expect(toMediaSummary(json, facts).audio[0].bitsPerSample).toBe(16)
    const untyped: ProbeJson = { streams: [{ index: 0, codec_name: 'bin' }], format: null, chapters: [] }
    expect(() => toProbedSource(untyped, { path: '/m/x', size: 1, mtimeMs: 1 })).toThrow(ProbeFailure)
  })
})

describe('uncShareRoot', () =>
{
  it.each([
    ['\\\\Server\\Share\\folder\\a.mkv', '\\\\server\\share'],
    ['//server/share/a.mkv', '\\\\server\\share'],
    ['\\\\?\\UNC\\server\\share\\a.mkv', '\\\\server\\share'],
    ['\\\\?\\C:\\long\\a.mkv', null],
    ['C:\\local\\a.mkv', null],
    ['\\\\server', null],
    ['/mnt/share/a.mkv', null]
  ])('%s -> %s', (path, expected) =>
  {
    expect(uncShareRoot(path)).toBe(expected)
  })
})

class FakeChild extends EventEmitter
{
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() =>
  {
    setImmediate(() => this.emit('close', null, 'SIGTERM'))
    return true
  })
}

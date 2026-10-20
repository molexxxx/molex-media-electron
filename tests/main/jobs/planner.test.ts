import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'path'
import type { AudioFacts, BoostRecipe, MediaFacts, NormalizeRecipe, OutputCodec } from '../../../src/shared/audio/types'
import { applyDefaultPreset } from '../../../src/shared/jobs/presets'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { CompressRecipe, ConvertRecipe, ExtractRecipe, Recipe, VideoEncoder } from '../../../src/shared/jobs/recipes'
import type { BatchPolicy, CapabilitySummary, JobPlan, PlanFix, PlanIssue, PreflightReport, SourceRef } from '../../../src/shared/jobs/types'
import type { Platform } from '../../../src/shared/text/platform'
import type { BuildCapabilities } from '../../../src/main/ffmpeg/audio/encoders'
import type { FileStat, PlannerIO, VolumeInfo } from '../../../src/main/jobs/deps'
import type { JobRunner, PlanInput, RunnerPlan } from '../../../src/main/jobs/runners/types'
import { containerFor } from '../../../src/main/ffmpeg/audio/containers'
import { volumeRoot } from '../../../src/main/jobs/volumes'
import { encoderLabel, firstIssue, fixTargets, formatSize, muxerFor, planFingerprint, planPreflight, reserveBytes, surroundMeterIssues } from '../../../src/main/jobs/planner'
import type { AlbumGroup, OtherJob, PlanJob, PreflightInput, PreflightResult, ProbeOutcome, RunnerSet } from '../../../src/main/jobs/planner'

const ENCODERS = [
  'aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s24le', 'wmav2',
  'libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1', 'prores_ks', 'ffv1', 'utvideo', 'mpeg2video', 'mpeg4', 'libtheora', 'wmv2'
]

const BUILD: BuildCapabilities = { encoders: new Set(ENCODERS), experimental: new Set(), soxr: true }

const SAME = { kind: 'same-as-source' } as const

function id(n: number): JobId
{
  return `MM-${String(n).padStart(4, '0')}` as JobId
}

function paths(platform: Platform): typeof win32
{
  return platform === 'win32' ? win32 : posix
}

function stream(audioIndex: number, over: Partial<AudioFacts> = {}): AudioFacts
{
  return {
    audioIndex,
    streamIndex: audioIndex + 1,
    codecName: 'aac',
    profile: 'LC',
    channels: 2,
    layout: 'stereo',
    layoutGuessed: false,
    sampleRate: 48000,
    sampleFmt: 'fltp',
    bitsPerRawSample: null,
    bitRate: 192000,
    durationSec: 60,
    language: null,
    title: null,
    disposition: { default: audioIndex === 0 ? 1 : 0 },
    ...over
  }
}

function movie(over: Partial<MediaFacts> = {}): MediaFacts
{
  return {
    path: '',
    container: 'mkv',
    formatName: 'matroska,webm',
    durationSec: 60,
    audio: [stream(0)],
    video: [{ streamIndex: 0, codecName: 'h264', cover: false }],
    subtitles: [],
    attachments: [],
    data: [],
    chapters: 0,
    ...over
  }
}

function song(over: Partial<MediaFacts> = {}): MediaFacts
{
  return movie({
    container: 'wav',
    formatName: 'wav',
    audio: [stream(0, { codecName: 'pcm_s16le', profile: null, sampleFmt: 's16', bitsPerRawSample: 16, bitRate: 1411200, sampleRate: 44100 })],
    video: [],
    ...over
  })
}

function normalize(): NormalizeRecipe
{
  return applyDefaultPreset('normalize', SAME) as NormalizeRecipe
}

function boost(): BoostRecipe
{
  return applyDefaultPreset('boost', SAME) as BoostRecipe
}

function convert(over: Partial<ConvertRecipe> = {}): ConvertRecipe
{
  return {
    kind: 'convert',
    presetId: null,
    userPreset: null,
    container: 'mp4',
    video: { encoder: 'libx264', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' },
    audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 192 },
    channels: 'keep',
    subtitles: 'drop',
    ...over
  }
}

function compress(over: Partial<CompressRecipe> = {}): CompressRecipe
{
  return {
    kind: 'compress',
    presetId: null,
    userPreset: null,
    target: { mode: 'crf', crf: 23 },
    encoder: 'libx264',
    speed: 'medium',
    pixelFormat: 'source',
    tune: null,
    fit: null,
    audio: { kind: 'copy' },
    container: 'source',
    ...over
  }
}

const EXTRACT_BASE = { kind: 'extract', presetId: null, userPreset: null } as const

function extractAudio(over: Partial<Extract<ExtractRecipe, { mode: 'audio' }>> = {}): ExtractRecipe
{
  return { ...EXTRACT_BASE, mode: 'audio', stream: { by: 'default' }, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }, container: 'mp3', sampleRate: null, channels: 'keep', range: null, ...over }
}

function extractSubtitles(format: 'srt' | 'vtt' | 'ass', stream: Extract<ExtractRecipe, { mode: 'subtitles' }>['stream'] = { by: 'default' }): ExtractRecipe
{
  return { ...EXTRACT_BASE, mode: 'subtitles', stream, format }
}

function extractFrames(): ExtractRecipe
{
  return { ...EXTRACT_BASE, mode: 'frames', sampling: { by: 'interval', seconds: 10 }, format: 'png', jpgQuality: null, range: null }
}

function extractVideo(over: Partial<Extract<ExtractRecipe, { mode: 'video' }>> = {}): ExtractRecipe
{
  return { ...EXTRACT_BASE, mode: 'video', container: 'mp4', reencode: null, range: null, ...over }
}

function extractGif(): ExtractRecipe
{
  return { ...EXTRACT_BASE, mode: 'gif', fps: 10, width: 480, dither: 'sierra2_4a', plays: 'infinite', range: null }
}

function sourceRef(path: string, platform: Platform, over: Partial<SourceRef> = {}): SourceRef
{
  const api = paths(platform)
  const name = api.basename(path)
  const dot = name.lastIndexOf('.')
  return { path, name, ext: dot > 0 ? name.slice(dot) : '', dir: api.dirname(path), size: 1000, mtimeMs: 1000, origin: 'files', subdir: '', ...over }
}

interface JobSetup
{
  facts?: MediaFacts
  source?: Partial<SourceRef>
  probe?: ProbeOutcome
  inputsRev?: number
}

function videoPlanOf(recipe: Recipe): RunnerPlan['video']
{
  const plan = (encoder: string, lossless: 'exact' | 'none' | 'not-requested', passes: 1 | 2): RunnerPlan['video'] =>
    ({ encoder, gpu: null, lossless, passes, filters: ['format=yuv420p'], notes: [], cpuFallback: null })
  if (recipe.kind === 'convert' && recipe.video !== null)
  {
    return plan(recipe.video.encoder, 'not-requested', 1)
  }
  if (recipe.kind === 'compress')
  {
    const lossless = recipe.target.mode === 'quality' && recipe.target.tier === 'lossless' ? 'exact' : 'not-requested'
    const passes = recipe.target.mode === 'size' && recipe.target.twoPass ? 2 : 1
    return plan(recipe.encoder, lossless, passes)
  }
  return null
}

type PlanOverride = (input: PlanInput) => Partial<RunnerPlan>

/** A fake runner whose static plan follows the recipe: a video encode is class video-cpu, a copy is class copy, the rest audio. */
function fakeRunner(kind: Recipe['kind'], override: PlanOverride | undefined, calls: Array<{ kind: string; input: PlanInput }>): JobRunner<Recipe>
{
  return {
    kind,
    plan: (input: PlanInput): RunnerPlan =>
    {
      calls.push({ kind, input })
      const video = videoPlanOf(input.recipe)
      const copy = input.recipe.kind === 'convert' && input.recipe.video?.encoder === 'copy'
      const base: RunnerPlan = {
        command: { argv: ['-i', input.source.path, '-f', input.output.muxer, input.output.finalPath], display: '', placeholders: [] },
        streams: { kept: [{ kind: 'audio', source: 1, output: 0, action: 'encode' }], dropped: [], chapters: 'none' },
        video: copy ? null : video,
        audio: [],
        class: video !== null && !copy && video.encoder !== 'copy' ? 'video-cpu' : copy ? 'copy' : 'audio',
        stages: [],
        estimate: { outputBytes: 500, workSec: 10, confidence: 'medium' },
        issues: []
      }
      return { ...base, ...(override?.(input) ?? {}) }
    },
    run: () => Promise.resolve({ kind: 'aborted' })
  }
}

interface DiskSetup
{
  /** Extra files by exact path, with their sizes. */
  files?: Readonly<Record<string, number>>
  dirs?: readonly string[]
  /** Paths whose stat throws, with the reason. */
  errors?: Readonly<Record<string, string>>
  /** Free bytes per volume root. */
  free?: Readonly<Record<string, number>>
  total?: Readonly<Record<string, number>>
  volumes?: Readonly<Record<string, Partial<VolumeInfo>>>
  unwritable?: readonly string[]
  /** Folders whose write probe throws, with the reason. */
  probeErrors?: Readonly<Record<string, string>>
  /** Paths where nothing is, sources included. */
  absent?: readonly string[]
  /** Volume roots whose free space or volume info cannot be read. */
  statfsErrors?: readonly string[]
  infoErrors?: readonly string[]
}

interface FakeIO extends PlannerIO
{
  calls: { stat: string[]; probeWrite: string[]; statfs: string[]; volumeInfo: string[] }
}

function fakeIO(setup: DiskSetup, platform: Platform, sources: readonly SourceRef[]): FakeIO
{
  const api = paths(platform)
  const files = new Map<string, number>(Object.entries(setup.files ?? {}))
  const dirs = new Set(setup.dirs ?? [])
  for (const source of sources)
  {
    if (!files.has(source.path) && !dirs.has(source.path) && !(setup.absent ?? []).includes(source.path))
    {
      files.set(source.path, source.size)
    }
  }
  const isDir = (path: string): boolean =>
    dirs.has(path) || api.dirname(path) === path || [...files.keys()].some((file) => file.startsWith(path.endsWith(api.sep) ? path : path + api.sep))
  const calls: FakeIO['calls'] = { stat: [], probeWrite: [], statfs: [], volumeInfo: [] }
  const defaults: VolumeInfo = { kind: 'local', trash: 'available', trashBytesFree: platform === 'win32' ? 50_000_000_000 : null, volumeBytes: 1_000_000_000_000 }
  return {
    calls,
    stat: (path: string): Promise<FileStat | null> =>
    {
      calls.stat.push(path)
      const error = setup.errors?.[path]
      if (error !== undefined)
      {
        return Promise.reject(new Error(error))
      }
      if ((setup.absent ?? []).includes(path))
      {
        return Promise.resolve(null)
      }
      const size = files.get(path)
      if (size !== undefined)
      {
        return Promise.resolve({ size, mtimeMs: 1000, isFile: true, isDirectory: false, dev: '1', ino: '2' })
      }
      return Promise.resolve(isDir(path) ? { size: 0, mtimeMs: 1000, isFile: false, isDirectory: true, dev: '1', ino: '3' } : null)
    },
    statfs: (path: string) =>
    {
      calls.statfs.push(path)
      const root = volumeRoot(path, platform)
      if ((setup.statfsErrors ?? []).includes(root))
      {
        return Promise.reject(new Error('EIO: i/o error'))
      }
      return Promise.resolve({ freeBytes: setup.free?.[root] ?? 500_000_000_000, totalBytes: setup.total?.[root] ?? 1_000_000_000_000 })
    },
    probeWrite: (dir: string) =>
    {
      calls.probeWrite.push(dir)
      const error = setup.probeErrors?.[dir]
      if (error !== undefined)
      {
        return Promise.reject(new Error(error))
      }
      return Promise.resolve(!(setup.unwritable ?? []).includes(dir))
    },
    volumeInfo: (path: string) =>
    {
      calls.volumeInfo.push(path)
      const root = volumeRoot(path, platform)
      if ((setup.infoErrors ?? []).includes(root))
      {
        return Promise.reject(new Error('the volume query timed out'))
      }
      return Promise.resolve({ ...defaults, ...(setup.volumes?.[root] ?? {}) })
    },
    reachable: () => Promise.resolve(true)
  }
}

function summary(over: Partial<CapabilitySummary> = {}): CapabilitySummary
{
  return {
    rev: 7,
    ffmpeg: { ready: true, version: '9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true, surroundMeter: true },
    encoders: ENCODERS,
    gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
    cpuCount: 8,
    platform: 'win32',
    ...over
  }
}

interface Scenario
{
  platform?: Platform
  policy?: Partial<BatchPolicy>
  jobs: Array<[number, string, Recipe, JobSetup?]>
  others?: OtherJob[]
  albums?: AlbumGroup[]
  summary?: Partial<CapabilitySummary>
  build?: BuildCapabilities
  disk?: DiskSetup
  runners?: Partial<Record<Recipe['kind'], PlanOverride>>
  volumeKey?: (path: string) => Promise<string>
}

interface Planned extends PreflightResult
{
  io: FakeIO
  input: PreflightInput
  calls: Array<{ kind: string; input: PlanInput }>
  entry(n: number): PreflightReport['jobs'][number]
  codes(n: number): string[]
  issue(n: number, code: string): PlanIssue
}

function policyOf(platform: Platform, over: Partial<BatchPolicy> = {}): BatchPolicy
{
  const folder = platform === 'win32' ? 'D:\\Exports' : '/exports'
  return { rev: 3, destination: { mode: 'folder', folder }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off', ...over }
}

async function plan(s: Scenario): Promise<Planned>
{
  const platform = s.platform ?? 'win32'
  const jobs: PlanJob[] = s.jobs.map(([n, path, recipe, setup = {}]) =>
  {
    const source = sourceRef(path, platform, setup.source)
    const facts = { ...(setup.facts ?? (recipe.kind === 'normalize' || recipe.kind === 'boost' ? song() : movie())), path }
    return { id: id(n), inputsRev: setup.inputsRev ?? 1, source, recipe, probe: setup.probe ?? { status: 'ok', facts } }
  })
  const input: PreflightInput = {
    preflightId: 'pf-1',
    createdAt: 1_700_000_000_000,
    platform,
    policy: policyOf(platform, s.policy),
    capabilities: { summary: summary({ platform, ...s.summary }), build: s.build ?? BUILD, minimumVersion: '5.1' },
    jobs,
    others: s.others ?? [],
    albums: s.albums ?? [],
    limits: { total: 4, videoCpu: 2, gpu: 1 },
    date: '2026-10-17'
  }
  const io = fakeIO(s.disk ?? {}, platform, jobs.map((job) => job.source))
  const calls: Planned['calls'] = []
  const kinds: Array<Recipe['kind']> = ['normalize', 'boost', 'convert', 'compress', 'extract']
  const runners = Object.fromEntries(kinds.map((kind) => [kind, fakeRunner(kind, s.runners?.[kind], calls)])) as unknown as RunnerSet
  const result = await planPreflight(input, { io, runners, volumeKey: s.volumeKey })
  const entry = (n: number): PreflightReport['jobs'][number] =>
  {
    const found = result.report.jobs.find((e) => e.jobId === id(n))
    if (found === undefined)
    {
      throw new Error(`no entry for ${id(n)}`)
    }
    return found
  }
  const issue = (n: number, code: string): PlanIssue =>
  {
    const found = entry(n).issues.find((i) => i.code === code)
    if (found === undefined)
    {
      throw new Error(`${id(n)} has no ${code}: ${entry(n).issues.map((i) => i.code).join(', ')}`)
    }
    return found
  }
  return { ...result, io, input, calls, entry, codes: (n) => [...new Set(entry(n).issues.map((i) => i.code))], issue }
}

function finalPath(p: Planned, n: number): string
{
  return p.entry(n).plan?.output.finalPath ?? ''
}

describe('collisions inside one report', () =>
{
  it('blocks the later of two same-named sources from different folders under skip, with the rename and token fixes', async () =>
  {
    const p = await plan({
      policy: { conflict: 'skip' },
      jobs: [[1, 'D:\\Media\\A\\song.wav', normalize()], [2, 'D:\\Media\\B\\song.wav', normalize()]]
    })
    expect(p.entry(1).status).toBe('ready')
    expect(finalPath(p, 1)).toBe('D:\\Exports\\song.wav')
    expect(p.entry(2).status).toBe('blocked')
    const issues = p.entry(2).issues.filter((i) => i.code === 'intra-batch-collision')
    expect(issues.map((i) => i.message)).toEqual(Array(3).fill('MM-0001 and MM-0002 would both write song.wav.'))
    expect(issues.map((i) => i.fix)).toEqual([
      { kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' },
      { kind: 'add-token', token: '{subdir}', scope: 'batch' },
      { kind: 'add-token', token: '{catalog}', scope: 'batch' }
    ])
    expect(p.report.collisions).toEqual([{ finalPath: 'D:\\Exports\\song.wav', jobIds: [id(1), id(2)], resolution: 'blocked' }])
    expect(p.entry(2).plan?.output.conflict).toBe('collides')
  })

  it('numbers the later output under rename and notes the collision', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\A\\song.wav', normalize()], [2, 'D:\\Media\\B\\song.wav', normalize()]]
    })
    expect(p.entry(2).status).toBe('ready')
    expect(finalPath(p, 2)).toBe('D:\\Exports\\song (2).wav')
    expect(p.entry(2).plan?.output).toMatchObject({ conflict: 'collides', resolution: 'rename', renamedTo: 'D:\\Exports\\song (2).wav' })
    expect(p.issue(2, 'intra-batch-collision').severity).toBe('info')
    expect(p.report.collisions).toEqual([{ finalPath: 'D:\\Exports\\song.wav', jobIds: [id(1), id(2)], resolution: 'renamed' }])
    expect(p.report.counts.renames).toBe(1)
  })

  it('blocks a.mkv and a.avi converted to .mp4 under overwrite and offers the {ext} token', async () =>
  {
    const p = await plan({
      policy: { conflict: 'overwrite' },
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\a.avi', convert(), { facts: movie({ container: 'avi', formatName: 'avi' }) }]]
    })
    expect(finalPath(p, 1)).toBe('D:\\Exports\\a.mp4')
    expect(p.entry(2).status).toBe('blocked')
    const fixes = p.entry(2).issues.filter((i) => i.code === 'intra-batch-collision').map((i) => i.fix)
    expect(fixes).toContainEqual({ kind: 'add-token', token: '{ext}', scope: 'batch' })
    expect(fixes).toContainEqual({ kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' })
    expect(fixes).not.toContainEqual({ kind: 'add-token', token: '{subdir}', scope: 'batch' })
  })

  it('treats two jobs on one source like any other collision', async () =>
  {
    const p = await plan({
      policy: { conflict: 'skip' },
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\a.mkv', convert({ video: { encoder: 'libx265', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } })]]
    })
    expect(p.entry(2).status).toBe('blocked')
    expect(p.issue(2, 'intra-batch-collision').message).toBe('MM-0001 and MM-0002 would both write a.mp4.')
    const renamed = await plan({
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\a.mkv', convert()]]
    })
    expect(finalPath(renamed, 2)).toBe('D:\\Exports\\a (2).mp4')
  })
})

describe('path keys per platform', () =>
{
  const folders: Record<Platform, [string, string]> =
  {
    win32: ['D:\\Media\\A\\', 'D:\\Media\\B\\'],
    darwin: ['/Users/you/A/', '/Users/you/B/'],
    linux: ['/home/you/A/', '/home/you/B/']
  }

  it.each([
    ['win32', true],
    ['darwin', true],
    ['linux', false]
  ] as const)('compares names that differ only in case on %s: collide %s', async (platform, collide) =>
  {
    const [a, b] = folders[platform]
    const p = await plan({ platform, jobs: [[1, `${a}Song.wav`, normalize()], [2, `${b}song.wav`, normalize()]] })
    const api = paths(platform)
    expect(api.basename(finalPath(p, 2))).toBe(collide ? 'song (2).wav' : 'song.wav')
    expect(p.report.collisions).toHaveLength(collide ? 1 : 0)
  })

  it.each([
    ['win32', true],
    ['darwin', true],
    ['linux', false]
  ] as const)('compares composed and decomposed names as NFC on %s: collide %s', async (platform, collide) =>
  {
    const [a, b] = folders[platform]
    const p = await plan({ platform, jobs: [[1, `${a}Caf\u00e9.wav`, normalize()], [2, `${b}Cafe\u0301.wav`, normalize()]] })
    expect(p.report.collisions).toHaveLength(collide ? 1 : 0)
    expect(p.entry(2).plan?.output.renamedTo !== null).toBe(collide)
  })
})

describe('the conflict rule against existing files and reserved paths', () =>
{
  const SONG = 'D:\\Media\\song.wav'
  const OUT = 'D:\\Exports\\song.wav'

  it('skips a job whose output exists under skip, visibly and counted', async () =>
  {
    const p = await plan({ policy: { conflict: 'skip' }, jobs: [[1, SONG, normalize()]], disk: { files: { [OUT]: 4000 } } })
    expect(p.entry(1).status).toBe('will-skip')
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: OUT, conflict: 'exists', resolution: 'skip', renamedTo: null, displaces: null })
    const issue = p.issue(1, 'output-exists')
    expect(issue).toEqual({
      code: 'output-exists', severity: 'info', message: 'song.wav exists; it will be skipped (rule: skip).', field: 'naming',
      fix: { kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' }
    })
    expect(p.report.counts).toMatchObject({ jobs: 1, ready: 0, willSkip: 1, blocked: 0 })
    expect(p.summaries[0].summary.status).toBe('will-skip')
  })

  it('numbers the output under rename', async () =>
  {
    const p = await plan({ jobs: [[1, SONG, normalize()]], disk: { files: { [OUT]: 4000 } } })
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: 'D:\\Exports\\song (2).wav', conflict: 'exists', resolution: 'rename', renamedTo: 'D:\\Exports\\song (2).wav' })
    expect(p.issue(1, 'output-exists').message).toBe('song.wav exists; this job writes song (2).wav.')
    expect(p.issue(1, 'output-exists').severity).toBe('info')
    expect(p.report.counts.renames).toBe(1)
    expect(p.summaries[0].summary).toMatchObject({ finalName: 'song (2).wav', relativePath: 'song (2).wav', resolution: 'rename' })
  })

  it('sends the existing file to the bin under overwrite, as a counted warning', async () =>
  {
    const p = await plan({ policy: { conflict: 'overwrite' }, jobs: [[1, SONG, normalize()]], disk: { files: { [OUT]: 4000 } } })
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: OUT, conflict: 'exists', resolution: 'overwrite', displaces: OUT })
    const issue = p.issue(1, 'output-exists')
    expect(issue.severity).toBe('warning')
    expect(issue.message).toMatch(/^song\.wav exists; it goes to .*Recycle Bin.* after this output verifies\.$/)
    expect(p.report.counts).toMatchObject({ overwrites: 1, originalsAffected: 0, warnings: 1 })
    expect(p.report.volumes.find((v) => v.volume.startsWith('D'))?.trashBytesNeeded).toBe(4000)
    expect(p.report.warnings.map((w) => w.code)).toContain('output-exists')
  })

  it('keeps the existing file as name (previous).ext under overwrite with keep', async () =>
  {
    const p = await plan({ policy: { conflict: 'overwrite', displaced: 'keep' }, jobs: [[1, SONG, normalize()]], disk: { files: { [OUT]: 4000 } } })
    expect(p.issue(1, 'output-exists').message).toBe('song.wav exists; it is renamed to song (previous).wav after this output verifies.')
    expect(p.report.volumes.every((v) => v.trashBytesNeeded === 0)).toBe(true)
    expect(p.report.counts.overwrites).toBe(1)
  })

  it.each([
    ['skip', 'blocked', OUT],
    ['overwrite', 'blocked', OUT],
    ['rename', 'ready', 'D:\\Exports\\song (2).wav']
  ] as const)('treats a path reserved by a queued job like a collision under %s', async (rule, status, path) =>
  {
    const p = await plan({
      policy: { conflict: rule },
      jobs: [[1, SONG, normalize()]],
      others: [{ id: id(9), sourcePath: 'D:\\Elsewhere\\song.flac', reservedPath: OUT }]
    })
    expect(p.entry(1).status).toBe(status)
    expect(finalPath(p, 1)).toBe(path)
    const issues = p.entry(1).issues.filter((i) => i.code === 'intra-batch-collision')
    expect(issues[0].message).toBe('MM-0009 and MM-0001 would both write song.wav.')
    expect(issues.every((i) => i.severity === (rule === 'rename' ? 'info' : 'error'))).toBe(true)
    expect(p.report.collisions).toEqual([{ finalPath: OUT, jobIds: [id(9), id(1)], resolution: rule === 'rename' ? 'renamed' : 'blocked' }])
  })

  it('never lets an overwrite take another output of the same report', async () =>
  {
    const p = await plan({
      policy: { conflict: 'overwrite' },
      jobs: [[1, 'D:\\Media\\A\\song.wav', normalize()], [2, 'D:\\Media\\B\\song.wav', normalize()]]
    })
    expect(p.entry(2).status).toBe('blocked')
    expect(p.entry(2).issues.filter((i) => i.code === 'intra-batch-collision').map((i) => i.fix?.kind)).toEqual(['set-conflict-rule', 'add-token', 'add-token'])
    expect(p.report.counts.overwrites).toBe(0)
  })
})

describe('rename numbering', () =>
{
  it('skips numbers that exist, are reserved, or are the source of another job', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\song.wav', normalize()]],
      disk: { files: { 'D:\\Exports\\song.wav': 1, 'D:\\Exports\\song (2).wav': 1, 'D:\\Exports\\song (5).wav': 1 } },
      others: [
        { id: id(7), sourcePath: 'D:\\Exports\\song (3).wav', reservedPath: null },
        { id: id(8), sourcePath: 'D:\\Other\\x.wav', reservedPath: 'D:\\Exports\\song (4).wav' }
      ]
    })
    expect(finalPath(p, 1)).toBe('D:\\Exports\\song (6).wav')
  })

  it('takes the first gap in the numbering', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\song.wav', normalize()]],
      disk: { files: { 'D:\\Exports\\song.wav': 1, 'D:\\Exports\\song (2).wav': 1, 'D:\\Exports\\song (4).wav': 1 } }
    })
    expect(finalPath(p, 1)).toBe('D:\\Exports\\song (3).wav')
  })

  it('numbers three jobs on one name in queue order', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\A\\song.wav', normalize()], [2, 'D:\\B\\song.wav', normalize()], [3, 'D:\\C\\song.wav', normalize()]],
      disk: { files: { 'D:\\Exports\\song (2).wav': 1 } }
    })
    expect([1, 2, 3].map((n) => finalPath(p, n))).toEqual(['D:\\Exports\\song.wav', 'D:\\Exports\\song (3).wav', 'D:\\Exports\\song (4).wav'])
    expect(p.report.collisions).toEqual([{ finalPath: 'D:\\Exports\\song.wav', jobIds: [id(1), id(2), id(3)], resolution: 'renamed' }])
  })

  it('stops at 9999 with an error', async () =>
  {
    const files: Record<string, number> = { 'D:\\Exports\\song.wav': 1 }
    for (let n = 2; n <= 9999; n++)
    {
      files[`D:\\Exports\\song (${n}).wav`] = 1
    }
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', normalize()]], disk: { files } })
    expect(p.entry(1).status).toBe('blocked')
    expect(p.issue(1, 'output-exists')).toMatchObject({ severity: 'error', message: 'Every numbered name for song.wav up to (9999) is taken.' })
    expect(finalPath(p, 1)).toBe('D:\\Exports\\song.wav')
  })
})

describe('outputs that meet a source', () =>
{
  const NEXT = { destination: { mode: 'next-to-source' } } as const

  it.each(['skip', 'overwrite'] as const)('blocks an output on its own source under %s', async (conflict) =>
  {
    const p = await plan({ policy: { ...NEXT, conflict }, jobs: [[1, 'D:\\Media\\song.wav', normalize()]] })
    expect(p.entry(1).status).toBe('blocked')
    expect(p.issue(1, 'same-as-source')).toMatchObject({ severity: 'error', message: 'This output would overwrite its own source.', field: 'naming' })
  })

  it('renames an output on its own source under rename', async () =>
  {
    const p = await plan({ policy: NEXT, jobs: [[1, 'D:\\Media\\song.wav', normalize()]] })
    expect(p.entry(1).status).toBe('ready')
    expect(finalPath(p, 1)).toBe('D:\\Media\\song (2).wav')
    expect(p.issue(1, 'same-as-source')).toMatchObject({ severity: 'info', message: 'This output would overwrite its own source. This job writes song (2).wav.' })
    expect(p.summaries[0].summary.relativePath).toBe('song (2).wav')
  })

  it.each(['skip', 'overwrite'] as const)('blocks an output on the source of another job under %s', async (conflict) =>
  {
    const p = await plan({
      policy: { ...NEXT, conflict },
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\a.mp4', compress(), { facts: movie({ container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }) }]]
    })
    expect(p.entry(1).status).toBe('blocked')
    expect(p.issue(1, 'overwrites-another-source')).toMatchObject({ severity: 'error', message: 'This output would overwrite the source of MM-0002.' })
    expect(p.codes(2)).not.toContain('source-is-pending-output')
  })

  it('renames an output on the source of another job and leaves that job runnable', async () =>
  {
    const p = await plan({
      policy: NEXT,
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\a.mp4', compress(), { facts: movie({ container: 'mp4' }) }]],
      others: [{ id: id(5), sourcePath: 'D:\\Media\\b.mp4', reservedPath: null }]
    })
    expect(finalPath(p, 1)).toBe('D:\\Media\\a (2).mp4')
    expect(p.issue(1, 'overwrites-another-source').message).toBe('This output would overwrite the source of MM-0002. This job writes a (2).mp4.')
    expect(p.entry(2).status).toBe('ready')
  })

  it('blocks a job whose source is the pending output of a queued job', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\a.mp4', compress(), { facts: movie({ container: 'mp4' }) }]],
      others: [{ id: id(140), sourcePath: 'D:\\Media\\a.mkv', reservedPath: 'D:\\Media\\a.mp4' }]
    })
    expect(p.entry(1).status).toBe('blocked')
    expect(p.issue(1, 'source-is-pending-output')).toEqual({
      code: 'source-is-pending-output', severity: 'error', message: 'Run MM-0140 first; chained jobs are not supported.', field: 'source',
      fix: { kind: 'remove', scope: 'jobs' }
    })
  })
})

describe('replace originals', () =>
{
  const REPLACE = { destination: { mode: 'replace-originals' }, template: '{name}-{op}' } as const
  const SONG = 'D:\\Media\\song.wav'
  const toM4a = (): ConvertRecipe => convert({ container: 'm4a', video: null, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } })

  it('writes over the source when the extension is unchanged, ignoring the template', async () =>
  {
    const p = await plan({ policy: REPLACE, jobs: [[1, SONG, normalize()]] })
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: SONG, conflict: 'none', resolution: 'replace-original', displaces: SONG, renamedTo: null })
    expect(p.codes(1)).not.toContain('replace-extension-change')
    expect(p.report.counts).toMatchObject({ originalsAffected: 1, overwrites: 0 })
    expect(p.report.volumes).toEqual([expect.objectContaining({ trashBytesNeeded: 1000 })])
    expect(p.summaries[0].summary).toMatchObject({ relativePath: 'song.wav', resolution: 'replace-original' })
  })

  it('writes beside the source with the new extension and names both files', async () =>
  {
    const p = await plan({ policy: REPLACE, jobs: [[1, SONG, toM4a(), { facts: song() }]] })
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: 'D:\\Media\\song.m4a', resolution: 'replace-original', displaces: SONG, container: 'm4a' })
    expect(p.issue(1, 'replace-extension-change')).toMatchObject({ severity: 'warning', message: 'song.wav will be replaced by song.m4a.', field: 'naming' })
    expect(p.report.counts.originalsAffected).toBe(1)
  })

  it('applies the conflict rule to an existing file at the new path', async () =>
  {
    const disk = { files: { 'D:\\Media\\song.m4a': 3000 } }
    const renamed = await plan({ policy: REPLACE, jobs: [[1, SONG, toM4a(), { facts: song() }]], disk })
    expect(renamed.entry(1).plan?.output).toMatchObject({ finalPath: 'D:\\Media\\song (2).m4a', resolution: 'replace-original', renamedTo: 'D:\\Media\\song (2).m4a', displaces: SONG })
    const overwritten = await plan({ policy: { ...REPLACE, conflict: 'overwrite' }, jobs: [[1, SONG, toM4a(), { facts: song() }]], disk })
    expect(overwritten.entry(1).plan?.output).toMatchObject({ finalPath: 'D:\\Media\\song.m4a', conflict: 'exists', resolution: 'replace-original', displaces: SONG })
    expect(overwritten.report.counts).toMatchObject({ overwrites: 1, originalsAffected: 1 })
    expect(overwritten.report.volumes[0].trashBytesNeeded).toBe(4000)
    const skipped = await plan({ policy: { ...REPLACE, conflict: 'skip' }, jobs: [[1, SONG, toM4a(), { facts: song() }]], disk })
    expect(skipped.entry(1).status).toBe('will-skip')
    expect(skipped.report.counts.originalsAffected).toBe(0)
  })

  it('follows a container change of the audio encoder to the new extension', async () =>
  {
    const recipe = applyDefaultPreset('normalize', { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }) as NormalizeRecipe
    const p = await plan({ policy: REPLACE, jobs: [[1, SONG, recipe]] })
    expect(p.entry(1).plan?.output.containerChanged).toEqual({ from: 'wav', reason: 'AAC cannot be stored in .wav; the output is .m4a.' })
    expect(p.issue(1, 'container-changed')).toMatchObject({ severity: 'info', message: 'AAC cannot be stored in .wav; the output is .m4a.' })
    expect(p.issue(1, 'replace-extension-change').message).toBe('song.wav will be replaced by song.m4a.')
    expect(p.report.counts.containerChanges).toBe(1)
  })

  it('keeps originals beside their outputs with keep, so nothing goes to the bin', async () =>
  {
    const p = await plan({ policy: { ...REPLACE, displaced: 'keep' }, jobs: [[1, SONG, normalize()]] })
    expect(p.report.counts.originalsAffected).toBe(1)
    expect(p.report.volumes[0].trashBytesNeeded).toBe(0)
  })

  it('plans extract jobs next to the source with the template and says so', async () =>
  {
    const p = await plan({ policy: REPLACE, jobs: [[1, 'D:\\Media\\movie.mkv', extractAudio()]] })
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: 'D:\\Media\\movie-extract.mp3', resolution: 'place', displaces: null })
    expect(p.issue(1, 'extract-never-replaces')).toEqual({
      code: 'extract-never-replaces', severity: 'info', message: 'Extract jobs never replace originals; this one writes beside its source.', field: 'destination', fix: null
    })
    expect(p.report.counts.originalsAffected).toBe(0)
  })

  it('blocks two jobs that would both replace one source, but not an extract beside them', async () =>
  {
    const p = await plan({
      policy: REPLACE,
      jobs: [[1, SONG, normalize()], [2, SONG, boost()], [3, SONG, extractAudio(), { facts: song() }]]
    })
    for (const n of [1, 2])
    {
      expect(p.entry(n).status).toBe('blocked')
      expect(p.issue(n, 'replace-one-job-per-source')).toEqual({
        code: 'replace-one-job-per-source', severity: 'error', message: 'Two jobs on one source cannot both replace it.', field: 'destination', fix: { kind: 'remove', scope: 'jobs' }
      })
    }
    expect(p.codes(3)).not.toContain('replace-one-job-per-source')
    expect(p.entry(3).status).toBe('ready')
  })
})

describe('FFmpeg and encoder checks', () =>
{
  it.each([
    ['ffmpeg-unavailable', { ready: false, version: null, meetsMinimum: false }, 'FFmpeg 5.1 or newer is required; found none.'],
    ['ffmpeg-below-minimum', { ready: true, version: '5.0', meetsMinimum: false }, 'FFmpeg 5.1 or newer is required; found 5.0.'],
    ['self-test-failed', { selfTest: 'failed' }, 'FFmpeg 9.0.2 failed its self-test; repair it in Settings.']
  ] as const)('blocks every job with %s', async (code, ffmpeg, message) =>
  {
    const base = summary().ffmpeg
    const p = await plan({
      summary: { ffmpeg: { ...base, ...ffmpeg } },
      jobs: [[1, 'D:\\Media\\song.wav', normalize()], [2, 'D:\\Media\\movie.mkv', convert()]]
    })
    for (const n of [1, 2])
    {
      expect(p.entry(n).status).toBe('blocked')
      expect(p.issue(n, code)).toMatchObject({ severity: 'error', message, field: 'encoder' })
    }
    expect(p.report.blocking.filter((i) => i.code === code)).toHaveLength(1)
  })

  it('names the self-test failure without a version', async () =>
  {
    const p = await plan({ summary: { ffmpeg: { ...summary().ffmpeg, version: null, selfTest: 'failed' } }, jobs: [[1, 'D:\\Media\\song.wav', normalize()]] })
    expect(p.issue(1, 'self-test-failed').message).toBe('FFmpeg failed its self-test; repair it in Settings.')
  })

  describe('surround loudness on a build whose surround meter misreads', () =>
  {
    const misreads: Partial<CapabilitySummary> = { ffmpeg: { ...summary().ffmpeg, surroundMeter: false } }
    const NORMALIZE_REFUSAL = 'This FFmpeg build measures surround loudness incorrectly, so surround files are not normalized. Choose another FFmpeg build in Settings, FFmpeg.'
    const GAIN_REFUSAL = 'This FFmpeg build measures surround loudness incorrectly, so Gain does not run on surround files. Choose another FFmpeg build in Settings, FFmpeg.'
    const DOWNMIX = { kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'downmix', value: 'standard' }, scope: 'jobs' }

    function film(layout = '5.1(side)', channels = 6): MediaFacts
    {
      return movie({ audio: [stream(0, { codecName: 'ac3', profile: null, channels, layout })] })
    }

    it('blocks a 5.1 normalize with the plain refusal and the stereo downmix as its fix', async () =>
    {
      const p = await plan({ summary: misreads, jobs: [[1, 'D:\\Media\\film.mkv', normalize(), { facts: film() }]] })
      expect(p.entry(1).status).toBe('blocked')
      expect(p.issue(1, 'surround-meter-failed')).toEqual({ code: 'surround-meter-failed', severity: 'error', message: NORMALIZE_REFUSAL, field: 'encoder', fix: DOWNMIX })
      expect(p.codes(1)).not.toContain('self-test-failed')
      expect(p.report.blocking.filter((i) => i.code === 'surround-meter-failed')).toHaveLength(1)
    })

    it('plans a 5.1 normalize that downmixes to stereo, since the meter then reads two channels', async () =>
    {
      const p = await plan({ summary: misreads, jobs: [[1, 'D:\\Media\\film.mkv', { ...normalize(), downmix: 'standard' }, { facts: film() }]] })
      expect(p.codes(1)).not.toContain('surround-meter-failed')
      expect(p.entry(1).status).toBe('ready')
    })

    it('blocks a 5.1 Gain job without a fix, since Gain has no downmix', async () =>
    {
      const p = await plan({ summary: misreads, jobs: [[1, 'D:\\Media\\film.mkv', boost(), { facts: film('5.1') }]] })
      expect(p.issue(1, 'surround-meter-failed')).toMatchObject({ severity: 'error', message: GAIN_REFUSAL, field: 'encoder', fix: null })
      expect(p.entry(1).status).toBe('blocked')
    })

    it('leaves stereo, mono, and jobs that never measure loudness alone', async () =>
    {
      const mono = song({ audio: [stream(0, { codecName: 'pcm_s16le', profile: null, channels: 1, layout: 'mono', sampleFmt: 's16' })] })
      const p = await plan({
        summary: misreads,
        jobs: [
          [1, 'D:\\Media\\song.wav', normalize()],
          [2, 'D:\\Media\\voice.wav', boost(), { facts: mono }],
          [3, 'D:\\Media\\voice2.wav', { ...normalize(), monoToStereo: true }, { facts: mono }],
          [4, 'D:\\Media\\film.mkv', convert({ container: 'mkv' }), { facts: film() }],
          [5, 'D:\\Media\\film2.mkv', compress({ container: 'mkv' }), { facts: film() }]
        ]
      })
      for (const n of [1, 2, 3, 4, 5])
      {
        expect(p.codes(n)).not.toContain('surround-meter-failed')
        expect(p.entry(n).status).toBe('ready')
      }
    })

    it('reads every audio stream the output keeps, so a 5.1 track beside a stereo one still blocks', async () =>
    {
      const both = movie({ audio: [stream(0), stream(1, { codecName: 'ac3', profile: null, channels: 6, layout: '5.1' })] })
      const p = await plan({ summary: misreads, jobs: [[1, 'D:\\Media\\film.mkv', normalize(), { facts: both }]] })
      expect(p.issue(1, 'surround-meter-failed').fix).toEqual(DOWNMIX)
    })

    it('offers no downmix fix when a surround layout has no stereo downmix', async () =>
    {
      const p = await plan({ summary: misreads, jobs: [[1, 'D:\\Media\\film.mkv', normalize(), { facts: film('7.1(wide)', 8) }]] })
      expect(p.issue(1, 'surround-meter-failed')).toMatchObject({ message: NORMALIZE_REFUSAL, fix: null })
    })

    it('adds nothing on a build whose surround meter passed, or one the self-test already refuses', async () =>
    {
      const passed = await plan({ jobs: [[1, 'D:\\Media\\film.mkv', normalize(), { facts: film() }]] })
      expect(passed.codes(1)).not.toContain('surround-meter-failed')
      expect(passed.entry(1).status).toBe('ready')
      const refused = await plan({ summary: { ffmpeg: { ...summary().ffmpeg, selfTest: 'failed', surroundMeter: false } }, jobs: [[1, 'D:\\Media\\film.mkv', normalize(), { facts: film() }]] })
      expect(refused.codes(1)).toContain('self-test-failed')
      expect(refused.codes(1)).not.toContain('surround-meter-failed')
    })

    it('keeps only the default stream of a one-track container, so a non-default 5.1 track is not metered', () =>
    {
      const facts = movie({ audio: [stream(0), stream(1, { codecName: 'ac3', profile: null, channels: 6, layout: '5.1' })] })
      const ffmpeg = { ...summary().ffmpeg, surroundMeter: false }
      expect(surroundMeterIssues(normalize(), facts, 'flac', ffmpeg)).toEqual([])
      expect(surroundMeterIssues(normalize(), facts, 'mkv', ffmpeg).map((i) => i.code)).toEqual(['surround-meter-failed'])
      expect(surroundMeterIssues(extractAudio(), facts, 'mkv', ffmpeg)).toEqual([])
    })
  })

  it('blocks a missing or experimental video encoder, with a fix only where the recipe names the encoder', async () =>
  {
    const build: BuildCapabilities = { encoders: new Set(ENCODERS.filter((e) => e !== 'libsvtav1')), experimental: new Set(['libaom-av1']), soxr: true }
    const av1 = convert({ container: 'mkv', video: { encoder: 'libsvtav1', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } })
    const aom = compress({ encoder: 'libaom-av1', container: 'mkv' })
    const p = await plan({ build, jobs: [[1, 'D:\\Media\\a.mkv', av1], [2, 'D:\\Media\\b.mkv', aom]] })
    expect(p.issue(1, 'encoder-missing')).toMatchObject({ severity: 'error', message: 'This FFmpeg has no libsvtav1 encoder.', field: 'encoder' })
    expect(p.issue(1, 'encoder-missing').fix).toMatchObject({ kind: 'patch-recipe', patch: { field: 'video-encoder', value: 'libx264' }, scope: 'jobs' })
    expect(p.issue(2, 'encoder-missing')).toMatchObject({ message: 'This FFmpeg has no libaom-av1 encoder.', fix: null })
    expect(p.entry(2).status).toBe('blocked')
  })

  it('offers no encoder fix when no alternative is usable', async () =>
  {
    const build: BuildCapabilities = { encoders: new Set(['aac']), experimental: new Set(), soxr: false }
    const p = await plan({ build, jobs: [[1, 'D:\\Media\\a.mkv', convert({ container: 'mkv' })]] })
    expect(p.issue(1, 'encoder-missing').fix).toBeNull()
  })

  it('blocks SVT-AV1 lossless with the x265 lossless fix, and the x265 film tune', async () =>
  {
    const p = await plan({
      jobs: [
        [1, 'D:\\Media\\a.mkv', compress({ encoder: 'libsvtav1', target: { mode: 'quality', tier: 'lossless' } })],
        [2, 'D:\\Media\\b.mkv', compress({ encoder: 'libx265', tune: 'film' })]
      ]
    })
    expect(p.issue(1, 'lossless-unsupported')).toEqual({
      code: 'lossless-unsupported', severity: 'error', message: 'SVT-AV1 has no lossless mode.', field: 'encoder',
      fix: { kind: 'patch-recipe', label: 'Use x265 lossless', patch: { field: 'compress-target', value: { mode: 'quality', tier: 'lossless' }, encoder: 'libx265' }, scope: 'jobs' }
    })
    expect(p.issue(2, 'tune-unsupported')).toMatchObject({ severity: 'error', message: 'x265 has no film tune; choose another tune or none.' })
  })
})

describe('the GPU policy', () =>
{
  const NVIDIA: CapabilitySummary['gpu'] = { status: 'ready', vendor: 'nvidia', name: 'GeForce', encoders: ['h264_nvenc', 'hevc_nvenc'] }
  const MOVIE = 'D:\\Media\\movie.mkv'

  it('moves an x264 encode to NVENC under auto and keeps the CPU plan as its fallback', async () =>
  {
    const p = await plan({ policy: { gpu: 'auto' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, compress()]] })
    const video = p.entry(1).plan?.video
    expect(p.entry(1).plan?.class).toBe('video-gpu')
    expect(video).toMatchObject({ encoder: 'h264_nvenc', gpu: 'NVENC', lossless: 'not-requested', passes: 1, filters: [] })
    expect(video?.cpuFallback).toEqual({ encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: ['format=yuv420p'], notes: [] })
    expect(p.issue(1, 'gpu-downgrade')).toEqual({
      code: 'gpu-downgrade', severity: 'warning', message: 'On the GPU, CRF 23 becomes QP 23.', field: 'encoder', fix: { kind: 'set-gpu', gpu: 'off', scope: 'batch' }
    })
    expect(p.report.counts).toMatchObject({ gpuJobs: 1, cpuFallbacks: 1 })
    expect(p.summaries[0].summary.encoderLabel).toBe('NVENC H.264')
  })

  it('carries no fallback under require', async () =>
  {
    const p = await plan({ policy: { gpu: 'require' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, compress({ encoder: 'libx265', container: 'mkv' })]] })
    expect(p.entry(1).plan?.video).toMatchObject({ encoder: 'hevc_nvenc', cpuFallback: null })
    expect(p.report.counts).toMatchObject({ gpuJobs: 1, cpuFallbacks: 0 })
    expect(p.summaries[0].summary.encoderLabel).toBe('NVENC HEVC')
  })

  it('lists every downgrade of a two-pass encode with a tune and a pixel format in one warning', async () =>
  {
    const recipe = compress({ target: { mode: 'size', targetBytes: 25_000_000, twoPass: true }, tune: 'film', pixelFormat: 'yuv420p10le' })
    const p = await plan({ policy: { gpu: 'auto' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, recipe]] })
    expect(p.issue(1, 'gpu-downgrade').message).toBe('On the GPU, two-pass runs as one pass, the film tune is not used and the yuv420p10le pixel format is not kept.')
    expect(p.entry(1).plan?.video?.cpuFallback?.passes).toBe(2)
  })

  it('names the quality tier that becomes a constant QP, and stays quiet with nothing to change', async () =>
  {
    const p = await plan({
      policy: { gpu: 'auto' },
      summary: { gpu: NVIDIA },
      jobs: [[1, MOVIE, compress({ target: { mode: 'quality', tier: 'high' } })], [2, 'D:\\Media\\b.mkv', convert({ container: 'mkv' })]]
    })
    expect(p.issue(1, 'gpu-downgrade').message).toBe('On the GPU, the high quality setting becomes a constant QP.')
    expect(p.codes(2)).not.toContain('gpu-downgrade')
    expect(p.entry(2).plan?.class).toBe('video-gpu')
  })

  it('keeps lossless on the CPU under auto and blocks it under require', async () =>
  {
    const lossless = compress({ target: { mode: 'quality', tier: 'lossless' } })
    const auto = await plan({ policy: { gpu: 'auto' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, lossless]] })
    expect(auto.entry(1).plan).toMatchObject({ class: 'video-cpu', video: { encoder: 'libx264', cpuFallback: null } })
    expect(auto.issue(1, 'gpu-downgrade')).toMatchObject({ severity: 'warning', message: 'NVENC cannot encode lossless; this job uses libx264.', fix: { kind: 'set-gpu', gpu: 'off', scope: 'batch' } })
    const require = await plan({ policy: { gpu: 'require' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, lossless]] })
    expect(require.issue(1, 'gpu-unavailable')).toMatchObject({ severity: 'error', message: 'NVENC cannot encode lossless; GPU encoding is required for this batch.', fix: { kind: 'set-gpu', gpu: 'auto', scope: 'batch' } })
  })

  it('blocks a codec without a GPU encoder under require and notes it under auto', async () =>
  {
    const vp9 = compress({ encoder: 'libvpx-vp9', container: 'webm' })
    const require = await plan({ policy: { gpu: 'require' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, vp9]] })
    expect(require.issue(1, 'gpu-unavailable')).toMatchObject({ severity: 'error', message: 'NVENC cannot encode VP9; GPU encoding is required for this batch.' })
    const auto = await plan({ policy: { gpu: 'auto' }, summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, vp9]] })
    expect(auto.issue(1, 'gpu-unavailable')).toMatchObject({ severity: 'info', message: 'No GPU encoder for VP9; this job uses libvpx-vp9.', fix: null })
    expect(auto.entry(1).status).toBe('ready')
    expect(auto.entry(1).plan?.class).toBe('video-cpu')
  })

  it('blocks require when no GPU was found, and notes auto', async () =>
  {
    const none: CapabilitySummary['gpu'] = { status: 'detecting', vendor: null, name: null, encoders: [] }
    const require = await plan({ policy: { gpu: 'require' }, summary: { gpu: none }, jobs: [[1, MOVIE, compress()]] })
    expect(require.issue(1, 'gpu-unavailable').message).toBe('GPU encoding is required, but no GPU encoder was found.')
    const auto = await plan({ policy: { gpu: 'auto' }, summary: { gpu: none }, jobs: [[1, MOVIE, compress()]] })
    expect(auto.issue(1, 'gpu-unavailable').message).toBe('No GPU encoder for H.264; this job uses libx264.')
    const missing = await plan({ policy: { gpu: 'require' }, summary: { gpu: { ...NVIDIA, encoders: ['hevc_nvenc'] } }, jobs: [[1, MOVIE, compress()]] })
    expect(missing.issue(1, 'gpu-unavailable').message).toBe('NVENC cannot encode H.264; GPU encoding is required for this batch.')
  })

  it('leaves audio jobs, copies, and the off policy on their own plans', async () =>
  {
    const p = await plan({
      policy: { gpu: 'require' },
      summary: { gpu: NVIDIA },
      jobs: [[1, 'D:\\Media\\song.wav', normalize()], [2, MOVIE, convert({ container: 'mkv', video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } })]]
    })
    expect(p.entry(1).plan?.class).toBe('audio')
    expect(p.entry(2).plan?.class).toBe('copy')
    expect(p.report.counts.gpuJobs).toBe(0)
    const off = await plan({ summary: { gpu: NVIDIA }, jobs: [[1, MOVIE, compress()]] })
    expect(off.entry(1).plan?.video?.encoder).toBe('libx264')
    expect(off.summaries[0].summary.encoderLabel).toMatch(/x264/)
  })
})

describe('applicability', () =>
{
  const COVER = movie({ container: 'mp3', formatName: 'mp3', audio: [stream(0, { codecName: 'mp3' })], video: [{ streamIndex: 1, codecName: 'mjpeg', cover: true }] })

  it.each([
    ['Compress', compress()],
    ['Extract video', extractVideo()],
    ['GIF', extractGif()],
    ['Frames', extractFrames()]
  ] as const)('refuses %s on a source with only cover art', async (operation, recipe) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\cover.mp3', recipe, { facts: COVER }]] })
    expect(p.entry(1).status).toBe('blocked')
    expect(p.issue(1, 'no-video-stream').message).toBe(`${operation} needs a video stream; cover.mp3 has none. Cover art does not count.`)
    expect(p.calls).toHaveLength(0)
  })

  it('notes that a Convert with a video encoder writes audio only from an audio source', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', convert(), { facts: song() }]] })
    expect(p.entry(1).status).toBe('ready')
    expect(p.issue(1, 'audio-only-output')).toMatchObject({ severity: 'info', message: 'song.wav has no video; the output is audio only.' })
  })

  it.each([
    ['Normalize', normalize()],
    ['Gain', boost()],
    ['Extract audio', extractAudio()]
  ] as const)('names %s when the source has no audio stream', async (operation, recipe) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\silent.mkv', recipe, { facts: movie({ audio: [] }) }]] })
    expect(p.issue(1, 'no-audio-stream').message).toBe(`${operation} needs an audio stream; silent.mkv has none.`)
  })

  it('blocks a stream pick the probe does not have', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractAudio({ stream: { by: 'ordinal', ordinal: 2 } })]] })
    expect(p.issue(1, 'stream-not-found')).toMatchObject({ severity: 'error', message: 'movie.mkv has 1 audio stream; the recipe asks for stream 2.' })
  })

  it('blocks more channels than the output codec holds', async () =>
  {
    const surround = movie({ audio: [stream(0, { channels: 6, layout: '5.1' })] })
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 } }), { facts: surround }]] })
    expect(p.issue(1, 'too-many-channels').severity).toBe('error')
    expect(p.issue(1, 'too-many-channels').message).toMatch(/at most 2 channels; this stream has 6/)
  })

  it('refuses a source without audio or video streams, and a failed or unfinished probe', async () =>
  {
    const p = await plan({
      jobs: [
        [1, 'D:\\Media\\notes.mkv', convert(), { facts: movie({ audio: [], video: [] }) }],
        [2, 'D:\\Media\\broken.mkv', convert(), { probe: { status: 'failed', reason: 'Invalid data found when processing input.' } }],
        [3, 'D:\\Media\\slow.mkv', convert(), { probe: { status: 'pending' } }]
      ]
    })
    expect(p.issue(1, 'not-media')).toMatchObject({ message: 'notes.mkv has no audio or video streams.', fix: { kind: 'remove', scope: 'jobs' } })
    expect(p.issue(2, 'probe-failed').message).toBe('Could not read the streams of broken.mkv: Invalid data found when processing input.')
    expect(p.issue(3, 'probe-failed').message).toBe('Could not read the streams of slow.mkv: the probe has not finished.')
    expect([1, 2, 3].map((n) => p.entry(n).plan)).toEqual([null, null, null])
    expect(p.summaries.map((s) => s.summary.finalName)).toEqual(['', '', ''])
  })
})

describe('extract subtitles from bitmap sources', () =>
{
  const bitmap = (codec: string): MediaFacts =>
    movie({ subtitles: [{ streamIndex: 2, subIndex: 0, codecName: codec, bitmap: true, language: null }] })

  it.each(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvbsub'])('refuses a %s stream bound for a text format', async (codec) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractSubtitles('srt'), { facts: bitmap(codec) }]] })
    expect(p.entry(1).status).toBe('blocked')
    const issue = p.issue(1, 'subtitle-bitmap')
    expect(issue.severity).toBe('error')
    expect(issue.message).toMatch(new RegExp(`^Stream \\d+ of movie\\.mkv is a bitmap subtitle \\(${codec}\\); it cannot become SRT\\.$`))
  })

  it('names the target format in the refusal', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractSubtitles('vtt'), { facts: bitmap('hdmv_pgs_subtitle') }]] })
    expect(p.issue(1, 'subtitle-bitmap').message).toContain('VTT')
  })

  it('refuses before the runner plans anything', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractSubtitles('srt'), { facts: bitmap('hdmv_pgs_subtitle') }]] })
    expect(p.calls).toHaveLength(0)
    expect(p.entry(1).plan).toBeNull()
  })

  it.each([
    ['subrip', 'srt', 'srt'],
    ['ass', 'ass', 'ass'],
    ['mov_text', 'vtt', 'webvtt']
  ] as const)('lets a %s stream through to .%s', async (codec, format, muxer) =>
  {
    const facts = movie({ subtitles: [{ streamIndex: 2, subIndex: 0, codecName: codec, bitmap: false, language: null }] })
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractSubtitles(format), { facts }]] })
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.output).toMatchObject({ finalPath: `D:\\Exports\\movie.${format}`, container: format, muxer })
  })

  it('resolves the requested subtitle stream and passes it to the runner', async () =>
  {
    const facts = movie({
      subtitles: [
        { streamIndex: 2, subIndex: 0, codecName: 'subrip', bitmap: false, language: null },
        { streamIndex: 3, subIndex: 1, codecName: 'subrip', bitmap: false, language: null }
      ]
    })
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractSubtitles('srt', { by: 'ordinal', ordinal: 2 }), { facts }]] })
    expect(p.entry(1).status).toBe('ready')
    expect(p.calls[0].input.recipe).toMatchObject({ mode: 'subtitles', stream: { by: 'ordinal', ordinal: 2 } })
    const missing = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractSubtitles('srt', { by: 'ordinal', ordinal: 3 }), { facts }]] })
    expect(missing.codes(1)).toContain('stream-not-found')
  })
})

describe('runner issues and plans', () =>
{
  it('adds the re-encode fix to a stream-copy trim and drops what the planner already reported', async () =>
  {
    const runnerIssues: PlanIssue[] = [
      { code: 'keyframe-trim', severity: 'warning', message: 'Copy cuts at keyframes; the clip can start up to 4.8 s early.', field: 'recipe', fix: null },
      { code: 'container-changed', severity: 'info', message: 'from the runner', field: 'container', fix: null },
      { code: 'odd-dimensions', severity: 'warning', message: '853x481 cannot be encoded as 4:2:0; the output is cropped to 852x480.', field: 'encoder', fix: null }
    ]
    const p = await plan({
      jobs: [[1, 'D:\\Media\\movie.mov', compress({ encoder: 'libvpx-vp9' }), { facts: movie({ container: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }) }]],
      runners: { compress: () => ({ issues: runnerIssues }) }
    })
    expect(p.issue(1, 'keyframe-trim').fix).toEqual({ kind: 'patch-recipe', label: 'Re-encode video', patch: { field: 'extract-reencode', value: { encoder: 'libx264', crf: 18 } }, scope: 'jobs' })
    expect(p.entry(1).issues.filter((i) => i.code === 'container-changed').map((i) => i.message)).toEqual(['VP9 cannot be stored in .mov; the output is .mkv.'])
    expect(p.issue(1, 'odd-dimensions').severity).toBe('warning')
  })

  it('blocks a job whose runner cannot plan it', async () =>
  {
    const refuse = (): Partial<RunnerPlan> =>
    {
      throw new Error('the frame size is not a number.')
    }
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert()]], runners: { convert: refuse } })
    expect(p.entry(1).status).toBe('blocked')
    expect(p.issue(1, 'invalid-recipe')).toMatchObject({ severity: 'error', message: 'molexMedia cannot plan movie.mkv: the frame size is not a number.', field: 'recipe' })
    expect(p.entry(1).plan).toBeNull()
  })

  it('passes the runner the output the planner chose and keeps its stream plan and command', async () =>
  {
    const streams: RunnerPlan['streams'] = { kept: [{ kind: 'video', source: 0, output: 0, action: 'copy' }], dropped: [{ kind: 'data', source: 4, reason: 'never mapped' }], chapters: 'kept' }
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container: 'webm', video: { encoder: 'libvpx-vp9', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' }, audio: { kind: 'codec', codec: 'opus', kbpsPerPair: 128 } })]], runners: { convert: () => ({ streams }) } })
    expect(p.calls[0].input.output).toMatchObject({ finalPath: 'D:\\Exports\\movie.webm', container: 'webm', muxer: 'webm', resolution: 'place' })
    expect(p.calls[0].input.platform).toBe('win32')
    expect(p.entry(1).plan?.streams).toEqual(streams)
    expect(p.entry(1).plan?.command?.argv).toEqual(['-i', 'D:\\Media\\movie.mkv', '-f', 'webm', 'D:\\Exports\\movie.webm'])
  })
})

describe('albums', () =>
{
  const album = (group: string | null, over: Partial<NormalizeRecipe> = {}): NormalizeRecipe => ({ ...normalize(), albumGroupId: group, ...over })

  it('records the group on every member', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\A\\1.wav', album('A')], [2, 'D:\\A\\2.wav', album('A')]], albums: [{ groupId: 'A', jobIds: [id(1), id(2)] }] })
    expect(p.entry(1).plan?.album).toEqual({ groupId: 'A', members: 2 })
    expect(p.entry(2).status).toBe('ready')
  })

  it('blocks members that do not share a target', async () =>
  {
    const louder = album('A', { maxLimitingDb: 3 })
    const p = await plan({ jobs: [[1, 'D:\\A\\1.wav', album('A')], [2, 'D:\\A\\2.wav', louder]] })
    expect(p.issue(1, 'album-mismatch')).toMatchObject({ severity: 'error', message: 'Album members must share a target and output layout.', field: 'album' })
    expect(p.codes(2)).toContain('album-mismatch')
  })

  it('blocks a start that leaves album members out', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\A\\1.wav', album('A')], [2, 'D:\\A\\2.wav', album('A')]],
      albums: [{ groupId: 'A', jobIds: [id(1), id(2), id(3), id(4)] }]
    })
    expect(p.issue(1, 'album-incomplete').message).toBe('Album A has 4 tracks; 2 are in this start. Start all 4, or take the others out of the album.')
    expect(p.entry(1).plan?.album).toEqual({ groupId: 'A', members: 4 })
    const one = await plan({ jobs: [[1, 'D:\\A\\1.wav', album('B')]], albums: [{ groupId: 'B', jobIds: [id(1), id(2)] }] })
    expect(one.issue(1, 'album-incomplete').message).toBe('Album B has 2 tracks; 1 is in this start. Start all 2, or take the others out of the album.')
  })
})

describe('containers and codecs on Convert', () =>
{
  const video = (encoder: VideoEncoder): ConvertRecipe['video'] => ({ encoder, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' })
  const codec = (c: OutputCodec): ConvertRecipe['audio'] => ({ kind: 'codec', codec: c, kbpsPerPair: 128 })

  it.each([
    ['webm', 'libx264'], ['webm', 'libx265'], ['ogv', 'libx264'], ['mp4', 'libtheora'], ['mp4', 'prores_ks'], ['ts', 'libvpx-vp9'], ['ts', 'prores_ks']
  ] as const)('refuses .%s with %s, with the MKV fix', async (container, encoder) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container, video: video(encoder), audio: { kind: 'copy' } })]] })
    expect(p.entry(1).status).toBe('blocked')
    const issue = p.issue(1, 'container-cannot-hold')
    expect(issue).toMatchObject({ severity: 'error', field: 'container', fix: { kind: 'set-container', container: 'mkv', scope: 'jobs' } })
    expect(issue.message).toMatch(/ cannot hold .+; choose .+\.$/)
  })

  it.each([
    ['flv', 'libx265', true], ['mp4', 'ffv1', true], ['wmv', 'libx264', false], ['avi', 'libvpx-vp9', false], ['avi', 'libaom-av1', false]
  ] as const)('holds .%s with %s on the pinned build; refused below the minimum: %s', async (container, encoder, legacyRefuses) =>
  {
    const recipe = convert({ container, video: video(encoder), audio: { kind: 'copy' } })
    const pinned = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', recipe]] })
    expect(pinned.codes(1)).not.toContain('container-cannot-hold')
    expect(pinned.entry(1).status).toBe('ready')
    const legacy = await plan({ summary: { ffmpeg: { ...summary().ffmpeg, version: '5.1.2', meetsMinimum: false } }, jobs: [[1, 'D:\\Media\\movie.mkv', recipe]] })
    expect(legacy.codes(1).includes('container-cannot-hold')).toBe(legacyRefuses)
    expect(legacy.codes(1)).toContain('ffmpeg-below-minimum')
  })

  it('names the containers that would hold ProRes', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container: 'mp4', video: video('prores_ks'), audio: { kind: 'copy' } })]] })
    expect(p.issue(1, 'container-cannot-hold').message).toBe('MP4 cannot hold ProRes; choose MOV or MKV.')
  })

  it.each([
    ['mp4', 'libx264', 'aac'], ['webm', 'libvpx-vp9', 'opus'], ['flv', 'libx264', 'aac'], ['wmv', 'wmv2', 'wmav2'], ['ogv', 'libtheora', 'vorbis'], ['mov', 'prores_ks', 'aac']
  ] as const)('accepts .%s with %s and %s', async (container, encoder, audio) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container, video: video(encoder), audio: codec(audio) })]] })
    expect(p.codes(1)).not.toContain('container-cannot-hold')
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.output.container).toBe(container)
  })

  it('judges FLV audio by the audio container table, and does not refuse what the table has no row for', async () =>
  {
    const row = containerFor('flv')
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container: 'flv', video: video('libx264'), audio: codec('opus') })]] })
    const refused = row.muxer !== null && !row.audioEncoders.has('libopus')
    expect(p.codes(1).includes('container-cannot-hold')).toBe(refused)
    expect(muxerFor('flv')).toBe('flv')
  })

  it.each([
    ['webm', 'libvpx-vp9', 'aac'], ['mp4', 'libx264', 'vorbis'], ['mov', 'libx264', 'vorbis']
  ] as const)('refuses .%s with %s and %s audio, offering MKV and an audio codec it holds', async (container, encoder, audio) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container, video: video(encoder), audio: codec(audio) })]] })
    const fixes = p.entry(1).issues.filter((i) => i.code === 'container-cannot-hold').map((i) => i.fix)
    expect(fixes[0]).toEqual({ kind: 'set-container', container: 'mkv', scope: 'jobs' })
    expect(fixes[1]).toMatchObject({ kind: 'patch-recipe', patch: { field: 'audio', value: { kind: 'codec', kbpsPerPair: 128 } }, scope: 'jobs' })
    expect(p.entry(1).status).toBe('blocked')
  })

  it('names the AAC fix for MP4 with Vorbis', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container: 'mp4', video: video('libx264'), audio: codec('vorbis') })]] })
    const issues = p.entry(1).issues.filter((i) => i.code === 'container-cannot-hold')
    expect(issues[0].message).toBe('MP4 cannot hold Vorbis; choose MKV.')
    expect(issues[1].fix).toEqual({ kind: 'patch-recipe', label: 'Use AAC audio', patch: { field: 'audio', value: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } }, scope: 'jobs' })
  })

  it.each([
    ['ogg', 'alac'], ['mp3', 'aac'], ['ogg', 'aac']
  ] as const)('refuses an audio-only .%s with %s', async (container, audio) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', convert({ container, video: null, audio: codec(audio) }), { facts: song() }]] })
    const issues = p.entry(1).issues.filter((i) => i.code === 'container-cannot-hold')
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0].fix).toMatchObject({ kind: 'set-container', scope: 'jobs' })
    expect(issues[0].fix).not.toEqual({ kind: 'set-container', container, scope: 'jobs' })
    expect(p.entry(1).status).toBe('blocked')
  })

  it('offers only the container fix when no codec the container holds can be encoded', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', convert({ container: 'wv', video: null, audio: codec('flac') }), { facts: song() }]] })
    const fixes = p.entry(1).issues.filter((i) => i.code === 'container-cannot-hold').map((i) => i.fix)
    expect(fixes).toEqual([{ kind: 'set-container', container: 'flac', scope: 'jobs' }])
  })

  it('accepts an audio-only .m4a with ALAC', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', convert({ container: 'm4a', video: null, audio: codec('alac') }), { facts: song() }]] })
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.output).toMatchObject({ container: 'm4a', containerChanged: null })
  })

  it('checks a copied video stream against the container', async () =>
  {
    const copy = convert({ container: 'webm', video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' }, audio: { kind: 'copy' } })
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', copy]] })
    expect(p.issue(1, 'container-cannot-hold').message).toMatch(/^WebM cannot hold H\.264/)
    const vp9 = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', copy, { facts: movie({ video: [{ streamIndex: 0, codecName: 'vp9', cover: false }], audio: [stream(0, { codecName: 'opus' })] }) }]] })
    expect(vp9.codes(1)).not.toContain('container-cannot-hold')
  })
})

describe('containers on Compress, Extract, and the audio operations', () =>
{
  it('keeps the source container when it holds the encode', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mp4', compress(), { facts: movie({ container: 'mp4' }) }]] })
    expect(p.entry(1).plan?.output).toMatchObject({ container: 'mp4', muxer: 'mp4', containerChanged: null })
  })

  it('switches to .mkv with a note when the source container cannot hold the video or the audio', async () =>
  {
    const p = await plan({
      jobs: [
        [1, 'D:\\Media\\a.mov', compress({ encoder: 'libvpx-vp9' }), { facts: movie({ container: 'mov' }) }],
        [2, 'D:\\Media\\b.mp4', compress({ audio: { kind: 'codec', codec: 'vorbis', kbpsPerPair: 128 } }), { facts: movie({ container: 'mp4' }) }]
      ]
    })
    expect(p.entry(1).plan?.output).toMatchObject({ container: 'mkv', muxer: 'matroska', containerChanged: { from: 'mov', reason: 'VP9 cannot be stored in .mov; the output is .mkv.' } })
    expect(p.issue(2, 'container-changed').message).toBe('Vorbis cannot be stored in .mp4; the output is .mkv.')
    expect(finalPath(p, 2)).toBe('D:\\Exports\\b.mkv')
    expect(p.report.counts.containerChanges).toBe(2)
    expect(p.entry(1).status).toBe('ready')
  })

  it('blocks an explicit Compress container that cannot hold the encode', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\a.mkv', compress({ container: 'webm' })]] })
    expect(p.issue(1, 'container-cannot-hold').severity).toBe('error')
  })

  it('checks Extract video copies and re-encodes against the container', async () =>
  {
    const p = await plan({
      jobs: [
        [1, 'D:\\Media\\a.mkv', extractVideo({ container: 'webm' })],
        [2, 'D:\\Media\\b.mkv', extractVideo({ container: 'webm', reencode: { encoder: 'libvpx-vp9', crf: 31 } })],
        [3, 'D:\\Media\\c.mkv', extractVideo({ container: 'mp4' })]
      ]
    })
    expect(p.codes(1)).toContain('container-cannot-hold')
    expect(p.codes(2)).not.toContain('container-cannot-hold')
    expect(p.entry(3).plan?.output).toMatchObject({ container: 'mp4', muxer: 'mp4' })
  })

  it('refuses an Extract audio codec its container cannot hold and offers the codec\'s own container', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractAudio({ container: 'mp3', audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } })]] })
    const issue = p.issue(1, 'container-cannot-hold')
    expect(issue.fix).toMatchObject({ kind: 'set-container', scope: 'jobs' })
    expect(issue.message).toMatch(/^MP3 cannot hold AAC; choose /)
  })

  it('writes frames into a folder through image2 and a GIF through the gif muxer', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', extractFrames()], [2, 'D:\\Media\\clip.mkv', extractGif()]] })
    expect(p.entry(1).plan?.output).toMatchObject({ kind: 'folder', finalPath: 'D:\\Exports\\movie', container: 'png', muxer: 'image2' })
    expect(p.entry(2).plan?.output).toMatchObject({ kind: 'file', finalPath: 'D:\\Exports\\clip.gif', container: 'gif', muxer: 'gif' })
    expect(p.entry(2).status).toBe('ready')
  })

  it('keeps the container of a normalize job whose encoder fits it', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.flac', normalize(), { facts: song({ container: 'flac', formatName: 'flac', audio: [stream(0, { codecName: 'flac', profile: null, bitRate: null })] }) }]] })
    expect(p.entry(1).plan?.output).toMatchObject({ container: 'flac', muxer: 'flac', containerChanged: null })
  })
})

describe('the muxer per container', () =>
{
  it.each([
    ['mp4', 'mp4'], ['mov', 'mov'], ['mkv', 'matroska'], ['mka', 'matroska'], ['webm', 'webm'], ['m4a', 'ipod'], ['wav', 'wav'], ['flac', 'flac'],
    ['mp3', 'mp3'], ['ogg', 'ogg'], ['opus', 'opus'], ['avi', 'avi'], ['ts', 'mpegts'], ['flv', 'flv'], ['ogv', 'ogv'], ['mpg', 'mpeg'],
    ['srt', 'srt'], ['vtt', 'webvtt'], ['ass', 'ass']
  ])('writes .%s with -f %s', (container, muxer) =>
  {
    expect(muxerFor(container)).toBe(muxer)
  })

  it('has no muxer for an unknown extension and blocks a job that asks for one', async () =>
  {
    expect(muxerFor('xyz')).toBeNull()
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', convert({ container: 'xyz', video: null }), { facts: song() }]] })
    expect(p.entry(1).issues.some((i) => i.code === 'container-cannot-hold' && i.message.startsWith('FFmpeg cannot write'))).toBe(true)
  })
})

describe('disk estimates and volume status', () =>
{
  const sized = (bytes: (input: PlanInput) => number | null): PlanOverride => (input) => ({ estimate: { outputBytes: bytes(input), workSec: null, confidence: 'medium' } })

  it('reserves twice the output for normalize and gain, and the source size when the output cannot be estimated', () =>
  {
    expect(reserveBytes('normalize', 500, 1000)).toBe(1000)
    expect(reserveBytes('boost', null, 1000)).toBe(2000)
    expect(reserveBytes('convert', 700, 1000)).toBe(700)
    expect(reserveBytes('compress', null, 1000)).toBe(1000)
    expect(reserveBytes('extract', Number.NaN, 300)).toBe(300)
    expect(reserveBytes('convert', -5, 1000)).toBe(0)
    expect(reserveBytes('normalize', 0.4, 1000)).toBe(1)
  })

  it('stores the output estimate and the reserve in the plan, with low confidence when the size is unknown', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\song.wav', normalize()], [2, 'D:\\Media\\movie.mkv', convert()]],
      runners: { convert: () => ({ estimate: { outputBytes: null, workSec: null, confidence: 'high' } }) }
    })
    expect(p.entry(1).plan?.estimate).toEqual({ outputBytes: 500, reserveBytes: 1000, workSec: 10, confidence: 'medium' })
    expect(p.entry(2).plan?.estimate).toEqual({ outputBytes: null, reserveBytes: 1000, workSec: null, confidence: 'low' })
  })

  it('reports a destination volume as ok under 80 percent of its free space', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\a.mkv', convert()]] })
    expect(p.report.volumes).toEqual([{
      volume: 'D:', kind: 'local', trash: 'available', trashBytesFree: 50_000_000_000, trashBytesNeeded: 0, volumeBytes: 1_000_000_000_000,
      freeBytes: 500_000_000_000, estimatedBytes: 500, status: 'ok'
    }])
    expect(p.io.calls.statfs).toEqual(['D:\\Exports'])
  })

  it('warns every job on a volume whose estimates pass 80 percent of its free space', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\b.mkv', convert()]],
      runners: { convert: sized(() => 900) },
      disk: { free: { 'D:\\': 2000 } }
    })
    expect(p.report.volumes[0]).toMatchObject({ estimatedBytes: 1800, freeBytes: 2000, status: 'tight' })
    for (const n of [1, 2])
    {
      expect(p.issue(n, 'disk-tight')).toEqual({ code: 'disk-tight', severity: 'warning', message: 'About 1.8 KB to write to D:, 2 KB free.', field: 'disk', fix: null })
      expect(p.entry(n).status).toBe('ready')
    }
    expect(p.report.counts.warnings).toBe(2)
    expect(p.report.warnings.filter((w) => w.code === 'disk-tight')).toHaveLength(1)
  })

  it('blocks a job whose estimate alone exceeds the free space and judges the rest without it', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\a.mkv', convert()], [2, 'D:\\Media\\b.mkv', convert()]],
      runners: { convert: sized((input) => (input.source.name === 'a.mkv' ? 3000 : 100)) },
      disk: { free: { 'D:\\': 2000 } }
    })
    expect(p.report.volumes[0].status).toBe('insufficient')
    expect(p.issue(1, 'disk-insufficient')).toMatchObject({ severity: 'error', message: 'About 3 KB to write to D:, 2 KB free.' })
    expect(p.entry(2).status).toBe('ready')
    expect(p.codes(2)).not.toContain('disk-tight')
  })

  it('reports unknown when the free space cannot be read', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\a.mkv', convert()]], disk: { statfsErrors: ['D:\\'] } })
    expect(p.report.volumes[0]).toMatchObject({ freeBytes: null, status: 'unknown', volumeBytes: 1_000_000_000_000 })
    expect(p.entry(1).status).toBe('ready')
  })

  it('lists source volumes beside destination volumes, and groups them by the volume key', async () =>
  {
    const p = await plan({ jobs: [[1, 'E:\\Media\\a.mkv', convert()]], disk: { volumes: { 'E:\\': { kind: 'removable', trash: 'unavailable', trashBytesFree: null, volumeBytes: 64_000_000_000 } } } })
    expect(p.report.volumes).toEqual([
      { volume: 'E:', kind: 'removable', trash: 'unavailable', trashBytesFree: null, trashBytesNeeded: 0, volumeBytes: 64_000_000_000, freeBytes: null, estimatedBytes: 0, status: 'unknown' },
      expect.objectContaining({ volume: 'D:', status: 'ok', estimatedBytes: 500 })
    ])
    const grouped = await plan({ jobs: [[1, 'E:\\Media\\a.mkv', convert()]], volumeKey: () => Promise.resolve('one') })
    expect(grouped.report.volumes).toHaveLength(1)
  })

  it('treats a volume query that fails as unknown', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\a.mkv', convert()]], disk: { infoErrors: ['D:\\'] } })
    expect(p.report.volumes[0]).toMatchObject({ kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: 1_000_000_000_000 })
  })
})

describe('volumes without a Recycle Bin', () =>
{
  const SHARE = '\\\\nas\\media\\song.wav'
  const ROOT = volumeRoot(SHARE, 'win32')
  const NO_BIN = { kind: 'network', trash: 'unavailable', trashBytesFree: null, volumeBytes: null } as const

  it('warns every job that would send an original to a volume without a bin', async () =>
  {
    const p = await plan({ policy: { destination: { mode: 'replace-originals' } }, jobs: [[1, SHARE, normalize()]], disk: { volumes: { [ROOT]: NO_BIN } } })
    const volume = p.report.volumes[0]
    expect(volume).toMatchObject({ kind: 'network', trash: 'unavailable', trashBytesFree: null, trashBytesNeeded: 0 })
    expect(p.issue(1, 'no-recycle-bin')).toEqual({
      code: 'no-recycle-bin', severity: 'warning', field: 'destination', fix: null,
      message: `${volume.volume} has no Recycle Bin. Originals replaced there stay beside their outputs as name (original).ext, and replaced files as name (previous).ext.`
    })
    expect(volume.volume).toBe('\\\\nas\\media')
    expect(p.entry(1).status).toBe('ready')
  })

  it('warns an overwrite whose existing file is on a removable drive', async () =>
  {
    const p = await plan({
      policy: { destination: { mode: 'folder', folder: 'E:\\Out' }, conflict: 'overwrite' },
      jobs: [[1, 'D:\\Media\\song.wav', normalize()]],
      disk: { files: { 'E:\\Out\\song.wav': 10 }, volumes: { 'E:\\': { kind: 'removable', trash: 'unavailable', trashBytesFree: null } } }
    })
    expect(p.issue(1, 'no-recycle-bin').message).toMatch(/^E: has no Recycle Bin\./)
  })

  it('says nothing when displaced files are kept', async () =>
  {
    const p = await plan({ policy: { destination: { mode: 'replace-originals' }, displaced: 'keep' }, jobs: [[1, SHARE, normalize()]], disk: { volumes: { [ROOT]: NO_BIN } } })
    expect(p.codes(1)).not.toContain('no-recycle-bin')
  })
})

describe('the Recycle Bin room', () =>
{
  const REPLACE = { destination: { mode: 'replace-originals' } } as const
  const FIXES: PlanFix[] = [{ kind: 'set-displaced', displaced: 'keep', scope: 'batch' }, { kind: 'set-destination', destination: 'next-to-source', scope: 'batch' }]

  it('blocks every job that sends files to a bin without room, with the keep and next-to-source fixes', async () =>
  {
    const p = await plan({
      policy: REPLACE,
      jobs: [[1, 'D:\\Media\\a.wav', normalize()], [2, 'D:\\Media\\b.wav', normalize()], [3, 'E:\\Media\\c.wav', normalize()]],
      disk: { volumes: { 'D:\\': { trashBytesFree: 1500 } } }
    })
    const message = 'The Recycle Bin on D: has room for about 1.5 KB. Replacing 2 KB of originals would make Windows permanently delete older Recycle Bin items, including originals from this batch.'
    for (const n of [1, 2])
    {
      const issues = p.entry(n).issues.filter((i) => i.code === 'trash-too-small')
      expect(issues.map((i) => i.message)).toEqual([message, message])
      expect(issues.map((i) => i.fix)).toEqual(FIXES)
      expect(issues.every((i) => i.severity === 'error')).toBe(true)
      expect(p.entry(n).status).toBe('blocked')
    }
    expect(p.entry(3).status).toBe('ready')
    expect(p.report.volumes.find((v) => v.volume === 'D:')).toMatchObject({ trashBytesFree: 1500, trashBytesNeeded: 2000 })
    expect(p.report.blocking.filter((i) => i.code === 'trash-too-small').map((i) => i.fix)).toEqual(FIXES)
    expect(fixTargets(p.report, FIXES[0])).toEqual([id(1), id(2), id(3)])
  })

  it('names existing files, and both kinds, in the words of the page', async () =>
  {
    const existing = await plan({
      policy: { conflict: 'overwrite' },
      jobs: [[1, 'D:\\Media\\song.wav', normalize()]],
      disk: { files: { 'D:\\Exports\\song.wav': 3000 }, volumes: { 'D:\\': { trashBytesFree: 1000 } } }
    })
    expect(existing.issue(1, 'trash-too-small').message).toBe('The Recycle Bin on D: has room for about 1 KB. Replacing 3 KB of existing files would make Windows permanently delete older Recycle Bin items, including originals from this batch.')
    const both = await plan({
      policy: { ...REPLACE, conflict: 'overwrite' },
      jobs: [[1, 'D:\\Media\\song.wav', convert({ container: 'm4a', video: null, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } }), { facts: song() }]],
      disk: { files: { 'D:\\Media\\song.m4a': 3000 }, volumes: { 'D:\\': { trashBytesFree: 1000 } } }
    })
    expect(both.issue(1, 'trash-too-small').message).toBe('The Recycle Bin on D: has room for about 1 KB. Replacing 4 KB of originals and existing files would make Windows permanently delete older Recycle Bin items, including originals from this batch.')
  })

  it('blocks when the room cannot be read on Windows and the batch sends more than 5 percent of the drive', async () =>
  {
    const unreadable = (volumeBytes: number): DiskSetup => ({ volumes: { 'D:\\': { trash: 'unknown', trashBytesFree: null, volumeBytes } } })
    const p = await plan({ policy: REPLACE, jobs: [[1, 'D:\\Media\\a.wav', normalize()]], disk: unreadable(10_000) })
    expect(p.issue(1, 'trash-too-small').message).toBe('molexMedia cannot read how much room the Recycle Bin on D: has, and this batch would send 1 KB there, more than 5 percent of the drive.')
    const large = await plan({ policy: REPLACE, jobs: [[1, 'D:\\Media\\a.wav', normalize()]], disk: unreadable(1_000_000) })
    expect(large.codes(1)).not.toContain('trash-too-small')
  })

  it('does not apply when displaced files are kept', async () =>
  {
    const p = await plan({ policy: { ...REPLACE, displaced: 'keep' }, jobs: [[1, 'D:\\Media\\a.wav', normalize()]], disk: { volumes: { 'D:\\': { trashBytesFree: 10 } } } })
    expect(p.codes(1)).not.toContain('trash-too-small')
    expect(p.report.volumes[0].trashBytesNeeded).toBe(0)
  })

  it.each(['darwin', 'linux'] as const)('never blocks on %s, where the Trash is not emptied by size', async (platform) =>
  {
    const p = await plan({ platform, policy: REPLACE, jobs: [[1, '/media/a.wav', normalize()]], disk: { volumes: { '/': { trashBytesFree: null, volumeBytes: 100 } } } })
    expect(p.codes(1)).not.toContain('trash-too-small')
    expect(p.report.volumes[0].trashBytesNeeded).toBe(1000)
  })

  it('leaves out jobs already blocked for another reason', async () =>
  {
    const p = await plan({
      policy: REPLACE,
      jobs: [[1, 'D:\\Media\\a.wav', normalize()], [2, 'D:\\Media\\a.wav', boost()]],
      disk: { volumes: { 'D:\\': { trashBytesFree: 10 } } }
    })
    expect(p.codes(1)).not.toContain('trash-too-small')
    expect(p.report.volumes[0].trashBytesNeeded).toBe(0)
  })
})

describe('plan basis and fingerprint', () =>
{
  const NVIDIA: CapabilitySummary['gpu'] = { status: 'ready', vendor: 'nvidia', name: 'GeForce', encoders: ['h264_nvenc'] }

  it('records the revisions the plan was made against', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', normalize(), { inputsRev: 4 }]] })
    expect(p.entry(1).plan?.basis).toEqual({ inputsRev: 4, policyRev: 3, capabilitiesRev: 7 })
    expect(p.entry(1).inputsRev).toBe(4)
    expect(p.entry(1).plan?.source).toEqual({ path: 'D:\\Media\\song.wav', size: 1000, mtimeMs: 1000 })
    expect(p.report).toMatchObject({ preflightId: 'pf-1', createdAt: 1_700_000_000_000, policyRev: 3, capabilitiesRev: 7, limits: { total: 4, videoCpu: 2, gpu: 1 } })
  })

  it('fingerprints the plan with the pure planFingerprint', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert()]] })
    const { fingerprint, ...rest } = p.entry(1).plan as JobPlan
    expect(fingerprint).toBe(planFingerprint(rest))
    expect(JSON.parse(fingerprint)).toMatchObject({ path: 'D:\\Exports\\movie.mp4', resolution: 'place', displaces: null, container: 'mp4', muxer: 'mp4', class: 'video-cpu' })
  })

  it('keeps the fingerprint across estimates and revisions, and changes it with the path, container, or encoders', async () =>
  {
    const base = (await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert()]] })).entry(1).plan?.fingerprint
    const estimate = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert(), { inputsRev: 9 }]], runners: { convert: () => ({ estimate: { outputBytes: 9999, workSec: 99, confidence: 'high' } }) } })
    expect(estimate.entry(1).plan?.fingerprint).toBe(base)
    const renamed = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert()]], disk: { files: { 'D:\\Exports\\movie.mp4': 1 } } })
    expect(renamed.entry(1).plan?.fingerprint).not.toBe(base)
    const container = await plan({ jobs: [[1, 'D:\\Media\\movie.mkv', convert({ container: 'mkv' })]] })
    expect(container.entry(1).plan?.fingerprint).not.toBe(base)
    const gpu = await plan({ policy: { gpu: 'auto' }, summary: { gpu: NVIDIA }, jobs: [[1, 'D:\\Media\\movie.mkv', convert()]] })
    expect(gpu.entry(1).plan?.fingerprint).not.toBe(base)
  })

  it('changes the fingerprint when only the CPU fallback differs', async () =>
  {
    const p = await plan({ policy: { gpu: 'auto' }, summary: { gpu: NVIDIA }, jobs: [[1, 'D:\\Media\\movie.mkv', convert()]] })
    const { fingerprint, ...rest } = p.entry(1).plan as JobPlan
    const video = rest.video as NonNullable<JobPlan['video']>
    expect(planFingerprint({ ...rest, video: { ...video, cpuFallback: null } })).not.toBe(fingerprint)
    expect(planFingerprint({ ...rest, audio: [] })).toBe(fingerprint)
  })

  it('changes the fingerprint with an audio encoder, bitrate, layout, or rate, and not with its notes', async () =>
  {
    type AudioPlan = JobPlan['audio'][number]
    const fingerprint = async (over: Partial<AudioPlan> = {}): Promise<string | undefined> =>
    {
      const audio: AudioPlan = {
        audioIndex: 0, encoder: 'aac', bitrateKbps: 256, outputLayout: 'stereo', outputRate: 48000,
        ceiling: {} as AudioPlan['ceiling'], notes: [], bitsPerSample: null, messages: [], ...over
      }
      const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', normalize()]], runners: { normalize: () => ({ audio: [audio] }) } })
      return p.entry(1).plan?.fingerprint
    }
    const base = await fingerprint()
    expect(JSON.parse(base as string).audio).toEqual([[0, 'aac', 256, 'stereo', 48000]])
    expect(await fingerprint({ bitsPerSample: 16, messages: [] })).toBe(base)
    for (const over of [{ encoder: 'libopus' }, { bitrateKbps: 192 }, { outputLayout: 'mono' }, { outputRate: 44100 }, { audioIndex: 1 }])
    {
      expect(await fingerprint(over)).not.toBe(base)
    }
  })
})

describe('counts', () =>
{
  const NVIDIA: CapabilitySummary['gpu'] = { status: 'ready', vendor: 'nvidia', name: 'GeForce', encoders: ['h264_nvenc'] }

  it('counts ready, blocked, skipped, GPU, fallback, container change, and warning jobs', async () =>
  {
    const p = await plan({
      policy: { conflict: 'skip', gpu: 'auto' },
      summary: { gpu: NVIDIA },
      jobs: [
        [1, 'D:\\Media\\a.wav', normalize()],
        [2, 'D:\\Media\\b.wav', normalize()],
        [3, 'D:\\Media\\c.mkv', compress()],
        [4, 'D:\\Media\\d.mov', compress({ encoder: 'libvpx-vp9' }), { facts: movie({ container: 'mov' }) }],
        [5, 'D:\\Media\\x\\a.wav', normalize()]
      ],
      disk: { files: { 'D:\\Exports\\b.wav': 10 } }
    })
    expect(p.report.counts).toEqual({
      jobs: 5, ready: 3, blocked: 1, willSkip: 1, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 1, gpuJobs: 1, cpuFallbacks: 1, warnings: 1
    })
    expect(p.summaries.map((s) => s.summary.status)).toEqual(['ready', 'will-skip', 'ready', 'ready', 'blocked'])
  })

  it('counts renames, overwrites, and originals affected only for jobs that will run', async () =>
  {
    const p = await plan({
      policy: { destination: { mode: 'replace-originals' }, conflict: 'overwrite' },
      jobs: [
        [1, 'D:\\Media\\a.wav', normalize()],
        [2, 'D:\\Media\\b.wav', convert({ container: 'm4a', video: null, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } }), { facts: song() }],
        [3, 'D:\\Media\\c.wav', normalize()],
        [4, 'D:\\Media\\c.wav', boost()]
      ],
      disk: { files: { 'D:\\Media\\b.m4a': 50 } }
    })
    expect(p.report.counts).toMatchObject({ jobs: 4, ready: 2, blocked: 2, overwrites: 1, originalsAffected: 2, renames: 0 })
  })
})

describe('fixes and their scope', () =>
{
  const prores = (): ConvertRecipe => convert({ container: 'mp4', video: { encoder: 'prores_ks', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' }, audio: { kind: 'copy' } })

  it('applies a jobs fix to exactly the jobs whose issues carry it, and a batch fix to every job', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\a.mkv', prores()], [2, 'D:\\Media\\b.mkv', prores()], [3, 'D:\\Media\\c.mkv', convert()]] })
    const fix = p.issue(1, 'container-cannot-hold').fix as PlanFix
    expect(fix).toEqual({ kind: 'set-container', container: 'mkv', scope: 'jobs' })
    expect(fixTargets(p.report, fix)).toEqual([id(1), id(2)])
    expect(fixTargets(p.report, { kind: 'set-gpu', gpu: 'off', scope: 'batch' })).toEqual([id(1), id(2), id(3)])
    expect(fixTargets(p.report, { kind: 'remove', scope: 'jobs' })).toEqual([])
  })

  it('gives every fix in a varied report the scope its kind calls for', async () =>
  {
    const p = await plan({
      policy: { conflict: 'skip' },
      jobs: [
        [1, 'D:\\Media\\A\\song.wav', normalize()],
        [2, 'D:\\Media\\B\\song.wav', normalize()],
        [3, 'D:\\Media\\a.mkv', prores()],
        [4, 'D:\\Media\\b.mkv', convert({ container: 'mp4', audio: { kind: 'codec', codec: 'vorbis', kbpsPerPair: 128 } })],
        [5, 'D:\\Media\\gone.wav', normalize()],
        [6, 'D:\\Media\\c.mkv', compress({ encoder: 'libsvtav1', target: { mode: 'quality', tier: 'lossless' } })]
      ],
      disk: { absent: ['D:\\Media\\gone.wav'] }
    })
    const batchKinds = new Set(['set-conflict-rule', 'add-token', 'set-gpu', 'set-displaced', 'set-destination'])
    const fixes = p.report.jobs.flatMap((entry) => entry.issues).map((issue) => issue.fix).filter((fix): fix is PlanFix => fix !== null)
    expect(new Set(fixes.map((fix) => fix.kind))).toEqual(new Set(['set-conflict-rule', 'add-token', 'set-container', 'patch-recipe', 'remove']))
    for (const fix of fixes)
    {
      expect(fix.scope).toBe(batchKinds.has(fix.kind) ? 'batch' : 'jobs')
      expect(fixTargets(p.report, fix).length).toBeGreaterThan(0)
    }
    const patch = p.issue(4, 'container-cannot-hold')
    expect(fixTargets(p.report, p.entry(4).issues.filter((i) => i.code === 'container-cannot-hold')[1].fix as PlanFix)).toEqual([id(4)])
    expect(patch.fix?.scope).toBe('jobs')
  })
})

describe('source checks', () =>
{
  it('blocks a source that is gone, with the remove fix', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\gone.wav', normalize()]], disk: { absent: ['D:\\Media\\gone.wav'] } })
    expect(p.issue(1, 'source-missing')).toEqual({
      code: 'source-missing', severity: 'error', message: 'The file is no longer at D:\\Media\\gone.wav.', field: 'source', fix: { kind: 'remove', scope: 'jobs' }
    })
    expect(p.entry(1).plan).toBeNull()
    expect(p.report.volumes).toEqual([])
  })

  it('blocks a source that cannot be read or is not a file', async () =>
  {
    const p = await plan({
      jobs: [[1, 'D:\\Media\\locked.wav', normalize()], [2, 'D:\\Media\\folder.wav', normalize()]],
      disk: { errors: { 'D:\\Media\\locked.wav': 'EACCES: permission denied, stat.' }, dirs: ['D:\\Media\\folder.wav'] }
    })
    expect(p.issue(1, 'source-unreadable')).toEqual({
      code: 'source-unreadable', severity: 'error', message: 'molexMedia cannot read locked.wav: EACCES: permission denied, stat.', field: 'source', fix: { kind: 'remove', scope: 'jobs' }
    })
    expect(p.issue(2, 'source-unreadable').message).toBe('molexMedia cannot read folder.wav: it is not a file.')
    expect(p.calls).toHaveLength(0)
  })

  it('warns when the source changed since it was probed, and plans it anyway', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', normalize()]], disk: { files: { 'D:\\Media\\song.wav': 2000 } } })
    expect(p.issue(1, 'source-changed')).toMatchObject({ severity: 'warning', message: 'song.wav changed after Review; review it again before it runs.' })
    expect(p.entry(1).status).toBe('ready')
    expect(p.entry(1).plan?.estimate.reserveBytes).toBe(1000)
  })
})

describe('destination checks', () =>
{
  it.each([
    ['win32', 'D:\\Media\\song.wav', 'D:\\Exports'],
    ['linux', '/media/song.wav', '/home/you/Exports'],
    ['darwin', '/media/song.wav', '/Users/you/Exports']
  ] as const)('refuses a relative output folder on %s', async (platform, source, example) =>
  {
    const p = await plan({ platform, policy: { destination: { mode: 'folder', folder: 'Exports' } }, jobs: [[1, source, normalize()]] })
    expect(p.issue(1, 'destination-invalid')).toMatchObject({ severity: 'error', message: `The output folder must be a full path, like ${example}.`, field: 'destination' })
    expect(p.entry(1).plan).toBeNull()
    expect(p.report.blocking.filter((i) => i.code === 'destination-invalid')).toHaveLength(1)
  })

  it('probes each output folder once and blocks when nothing can be created there', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\a.wav', normalize()], [2, 'D:\\Media\\b.wav', normalize()]], disk: { dirs: ['D:\\Exports'], unwritable: ['D:\\Exports'] } })
    expect(p.io.calls.probeWrite).toEqual(['D:\\Exports'])
    for (const n of [1, 2])
    {
      expect(p.issue(n, 'destination-not-writable').message).toBe('molexMedia cannot write to D:\\Exports: new files cannot be created there.')
    }
  })

  it('probes the nearest existing folder above one the engine will create', async () =>
  {
    const p = await plan({
      policy: { template: '{subdir}/{name}' },
      jobs: [[1, 'D:\\Media\\Season 1\\ep.wav', normalize(), { source: { subdir: 'Season 1' } }]],
      disk: { dirs: ['D:\\Exports'] }
    })
    expect(finalPath(p, 1)).toBe('D:\\Exports\\Season 1\\ep.wav')
    expect(p.io.calls.probeWrite).toEqual(['D:\\Exports'])
    expect(p.summaries[0].summary.relativePath).toBe('Season 1\\ep.wav')
  })

  it.each([
    ['a write probe that fails', { dirs: ['D:\\Exports'], probeErrors: { 'D:\\Exports': 'EPERM: operation not permitted.' } }, 'EPERM: operation not permitted'],
    ['a file where the folder should be', { files: { 'D:\\Exports': 10 } }, 'D:\\Exports is a file, not a folder'],
    ['a folder that cannot be read', { errors: { 'D:\\Exports': 'EACCES: permission denied' } }, 'EACCES: permission denied']
  ] as const)('blocks %s', async (_, disk, reason) =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', normalize()]], disk })
    expect(p.issue(1, 'destination-not-writable').message).toBe(`molexMedia cannot write to D:\\Exports: ${reason}.`)
  })

  it('blocks a drive that is not there', async () =>
  {
    const p = await plan({ policy: { destination: { mode: 'folder', folder: 'Q:\\Out' } }, jobs: [[1, 'D:\\Media\\song.wav', normalize()]], disk: { absent: ['Q:\\'] } })
    expect(p.issue(1, 'destination-not-writable').message).toBe('molexMedia cannot write to Q:\\Out: the drive is not available.')
  })

  it('blocks an output whose path cannot be checked', async () =>
  {
    const p = await plan({ jobs: [[1, 'D:\\Media\\song.wav', normalize()]], disk: { errors: { 'D:\\Exports\\song.wav': 'EIO: i/o error' } } })
    expect(p.issue(1, 'destination-not-writable').message).toBe('molexMedia cannot write to D:\\Exports: EIO: i/o error.')
    expect(p.io.calls.probeWrite).toEqual([])
  })
})

describe('the naming template', () =>
{
  it('blocks an unknown token', async () =>
  {
    const p = await plan({ policy: { template: '{name}-{album}' }, jobs: [[1, 'D:\\Media\\song.wav', normalize()]] })
    expect(p.issue(1, 'template-unknown-token')).toMatchObject({ severity: 'error', message: 'Unknown token {album} in the file name.', field: 'naming' })
    expect(p.entry(1).plan).toBeNull()
  })

  it('fills the catalog, operation, preset, and date tokens', async () =>
  {
    const p = await plan({ policy: { template: '{catalog}-{name}-{op}-{date}' }, jobs: [[1, 'D:\\Media\\song.wav', normalize()], [2, 'D:\\Media\\b.mkv', convert()]] })
    expect(finalPath(p, 1)).toBe('D:\\Exports\\MM-0001-song-normalize-2026-10-17.wav')
    expect(finalPath(p, 2)).toBe('D:\\Exports\\MM-0002-b-convert-2026-10-17.mp4')
  })

  it('warns when characters were replaced', async () =>
  {
    const p = await plan({ platform: 'linux', jobs: [[1, '/media/a:b.wav', normalize()]] })
    expect(finalPath(p, 1)).toBe('/exports/a_b.wav')
    expect(p.issue(1, 'template-sanitized')).toMatchObject({ severity: 'warning', message: 'Characters that file names cannot hold were replaced with _.', field: 'naming' })
  })

  it('warns when the output or its work path passes the Windows limit, and only on Windows', async () =>
  {
    const folder = `D:\\Exports\\${'deep\\'.repeat(20)}out`
    const name = `${'x'.repeat(150)}.wav`
    const p = await plan({ policy: { destination: { mode: 'folder', folder } }, jobs: [[1, `D:\\Media\\${name}`, normalize()]] })
    expect(p.issue(1, 'path-long').message).toMatch(/^The output path is \d+ characters; some programs cannot open paths over 260\.$/)
    expect(p.entry(1).status).toBe('ready')
    const linux = await plan({ platform: 'linux', policy: { destination: { mode: 'folder', folder: `/exports/${'deep/'.repeat(20)}out` } }, jobs: [[1, `/media/${name}`, normalize()]] })
    expect(linux.codes(1)).not.toContain('path-long')
  })
})

describe('report text', () =>
{
  it.each([
    [0, '0 bytes'], [999, '999 bytes'], [1500, '1.5 KB'], [512_000, '512 KB'], [9_400_000_000, '9.4 GB'], [41_000_000_000, '41 GB'], [2_500_000_000_000, '2.5 TB'], [-5, '0 bytes']
  ])('states %d bytes as %s', (bytes, text) =>
  {
    expect(formatSize(bytes)).toBe(text)
  })

  it('picks the most severe issue, the first of its severity', () =>
  {
    const issue = (code: PlanIssue['code'], severity: PlanIssue['severity']): PlanIssue => ({ code, severity, message: code, field: 'source', fix: null })
    expect(firstIssue([])).toBeNull()
    expect(firstIssue([issue('container-changed', 'info'), issue('disk-tight', 'warning'), issue('source-missing', 'error'), issue('not-media', 'error')])?.code).toBe('source-missing')
    expect(firstIssue([issue('container-changed', 'info'), issue('disk-tight', 'warning'), issue('path-long', 'warning')])?.code).toBe('disk-tight')
  })

  it('counts distinct errors and warnings in the row summary and leads with the worst', async () =>
  {
    const p = await plan({ policy: { conflict: 'skip' }, jobs: [[1, 'D:\\Media\\A\\song.wav', normalize()], [2, 'D:\\Media\\B\\song.wav', normalize()]] })
    expect(p.summaries[1].summary).toMatchObject({
      status: 'blocked', current: true, errors: 1, warnings: 0, finalName: 'song.wav', relativePath: 'song.wav', container: 'wav', resolution: 'place',
      firstIssue: { code: 'intra-batch-collision', severity: 'error', message: 'MM-0001 and MM-0002 would both write song.wav.' }
    })
    expect(p.summaries[0].summary.firstIssue).toBeNull()
  })

  it('labels the encoder that will run', () =>
  {
    const output = { kind: 'file', finalPath: '', container: 'srt', muxer: 'srt', containerChanged: null, conflict: 'none', resolution: 'place', renamedTo: null, displaces: null } as const
    const audio = (encoder: string, bitrateKbps: number | null, bitsPerSample: number | null): JobPlan['audio'][number] =>
      ({ audioIndex: 0, encoder, bitrateKbps, outputLayout: 'stereo', outputRate: 48000, ceiling: {} as JobPlan['audio'][number]['ceiling'], notes: [], bitsPerSample, messages: [] })
    const video = (encoder: string, passes: 1 | 2): NonNullable<JobPlan['video']> => ({ encoder, gpu: null, lossless: 'not-requested', passes, filters: [], notes: [], cpuFallback: null })
    expect(encoderLabel({ output, class: 'audio', video: null, audio: [audio('aac', 256, null)] })).toBe('AAC 256k')
    expect(encoderLabel({ output, class: 'audio', video: null, audio: [audio('pcm', null, 24)] })).toMatch(/24-bit$/)
    expect(encoderLabel({ output, class: 'audio', video: null, audio: [audio('flac', null, null)] })).toBe('FLAC')
    expect(encoderLabel({ output, class: 'video-cpu', video: video('libx264', 2), audio: [] })).toMatch(/2-pass$/)
    expect(encoderLabel({ output, class: 'video-cpu', video: video('libfancy', 1), audio: [] })).toBe('libfancy')
    expect(encoderLabel({ output, class: 'copy', video: video('copy', 1), audio: [] })).toBe('copy')
    expect(encoderLabel({ output, class: 'copy', video: null, audio: [] })).toBe('copy')
    expect(encoderLabel({ output, class: 'audio', video: null, audio: [] })).toBe('SRT')
  })
})

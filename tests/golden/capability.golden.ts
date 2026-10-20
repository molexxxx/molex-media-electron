import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExec } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'
import { CONTAINER_ROWS, codecOfEncoder, containerFor } from '../../src/main/ffmpeg/audio/containers'
import type { ContainerRow } from '../../src/main/ffmpeg/audio/containers'
import { chooseEncoder } from '../../src/main/ffmpeg/audio/encoders'
import type { BuildCapabilities, EncoderDecision, EncoderOutput } from '../../src/main/ffmpeg/audio/encoders'
import type { AudioFacts, EncoderPolicy, OutputCodec } from '../../src/shared/audio/types'
import { createOracle } from './oracle'

const golden = inject('golden')
const ready = !golden.skip && golden.meetsMinimum && (golden.only === null || golden.only.includes('G20'))

const exec = createExec(golden.ffmpeg, { timers: realTimers })
const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
const outDir = join(golden.outDir || '.', 'capability')
const caps: BuildCapabilities = { encoders: new Set(golden.encoders), experimental: new Set(golden.experimental), soxr: golden.soxr }

const POLICY_CODECS: readonly OutputCodec[] = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm', 'wmav2']
const SOURCE_CODECS: readonly string[] = ['aac', 'mp3', 'mp2', 'opus', 'vorbis', 'ac3', 'eac3', 'flac', 'alac', 'wavpack', 'tta', 'pcm_s16le',
  'pcm_s24le', 'pcm_s16be', 'wmav2', 'dts', 'truehd', 'ape']
const STEREO: EncoderOutput = { channels: 2, layout: 'stereo', minSampleRate: null }

function facts(codecName: string): AudioFacts
{
  const pcm = codecName.startsWith('pcm_')
  return {
    audioIndex: 0, streamIndex: 0, codecName, profile: null, channels: 2, layout: 'stereo', layoutGuessed: false, sampleRate: 48000,
    sampleFmt: pcm ? 's16' : 'fltp', bitsPerRawSample: pcm ? 16 : null, bitRate: pcm ? null : 192000, durationSec: 1, language: null, title: null,
    disposition: { default: 1 }
  }
}

/** Every extension the table names, paired with each policy; each decision either refuses or names a container that holds its encoder. */
interface Decided
{
  name: string
  policy: string
  video: boolean
  decision: EncoderDecision
}

function decisions(): Decided[]
{
  const all: Decided[] = []
  for (const name of CONTAINER_ROWS.flatMap((r) => r.names))
  {
    for (const video of [false, true])
    {
      const out = { ...STEREO, video }
      for (const codec of POLICY_CODECS)
      {
        const policy: EncoderPolicy = { kind: 'codec', codec, kbpsPerPair: null }
        all.push({ name, policy: `codec ${codec}`, video, decision: chooseEncoder(facts('pcm_s16le'), policy, name, out, caps) })
      }
      for (const source of SOURCE_CODECS)
      {
        all.push({ name, policy: `same as ${source}`, video, decision: chooseEncoder(facts(source), { kind: 'same-as-source' }, name, out, caps) })
      }
    }
  }
  return all
}

/** One allowed pair of the table: a row's muxer with one of the encoders it lists. */
interface Pair
{
  key: string
  row: ContainerRow
  extension: string
  encoder: string
}

/**
 * A pair the table allows that a build's muxer refuses as experimental. The app writes no -strict, so on such a
 * build the encode fails; the bounds are measured (libavformat 59.27.100 refuses, 59.34.101 accepts).
 */
interface MuxerLimit
{
  key: string
  refusedAtOrBelow: readonly [number, number, number]
  acceptedFrom: readonly [number, number, number]
  error: RegExp
}

const MUXER_LIMITS: readonly MuxerLimit[] = [
  { key: 'mp4 with flac', refusedAtOrBelow: [59, 27, 100], acceptedFrom: [59, 34, 101], error: /flac in MP4 support is experimental/ }
]

function compare(a: readonly number[], b: readonly number[]): number
{
  for (let i = 0; i < 3; i++)
  {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return 0
}

/** 'refused' or 'accepted' when the build's libavformat is inside a measured bound, otherwise null. */
function muxerExpectation(key: string): 'refused' | 'accepted' | null
{
  const limit = MUXER_LIMITS.find((m) => m.key === key)
  if (limit === undefined) return 'accepted'
  const avformat = golden.libs.avformat ?? [0, 0, 0]
  if (compare(avformat, limit.refusedAtOrBelow) <= 0) return 'refused'
  return compare(avformat, limit.acceptedFrom) >= 0 ? 'accepted' : null
}

const PAIRS: Pair[] = CONTAINER_ROWS.flatMap((row) => row.audioEncoders.map((encoder) =>
  ({ key: `${row.names[0]} with ${encoder}`, row, extension: row.names[0], encoder })))

interface PairRun
{
  key: string
  skipped: string | null
  encodeCode: number | null
  encodeErrors: string[]
  decodeCode: number | null
  decodeErrors: string[]
  codec: string | null
  ms: number
}

async function runPair(p: Pair): Promise<PairRun>
{
  const base: PairRun = { key: p.key, skipped: null, encodeCode: null, encodeErrors: [], decodeCode: null, decodeErrors: [], codec: null, ms: 0 }
  if (!caps.encoders.has(p.encoder))
  {
    return { ...base, skipped: `${p.encoder} is not in this build` }
  }
  const started = Date.now()
  const file = join(outDir, `${p.extension}-${p.encoder}.${p.extension}`)
  const errors: string[] = []
  const r = await exec.run(['-loglevel', 'level+error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=0.5',
    '-af', 'aformat=channel_layouts=stereo', '-map', '0:a', '-c:a', p.encoder, '-f', p.row.muxer, file],
  { signal: new AbortController().signal, stop: 'kill', onStderrLine: (line) => errors.push(line) })
  const run: PairRun = { ...base, encodeCode: r.code, encodeErrors: errors.filter((line) => /\[(error|fatal)\]/.test(line)) }
  if (r.code !== 0)
  {
    return { ...run, ms: Date.now() - started }
  }
  const decoded = await oracle.decodeCheck(file)
  const stream = await oracle.audioStream(file)
  return { ...run, decodeCode: decoded.code, decodeErrors: decoded.errors, codec: stream.codec, ms: Date.now() - started }
}

describe('G20 capability matrix in the encoder choice', () =>
{
  const decided = decisions()

  it('never chooses an encoder for a container the table does not let hold it', () =>
  {
    for (const p of decided)
    {
      if (!p.decision.ok) continue
      const target = containerFor(p.decision.container)
      expect(target.audioEncoders.has(p.decision.choice.encoder), `${p.name} ${p.policy} video=${p.video}`).toBe(true)
      expect(p.decision.containerChanged, `${p.name} ${p.policy}`).toBe(p.decision.container !== p.name)
      if (p.video && p.decision.containerChanged) expect(p.decision.container, `${p.name} ${p.policy}`).toBe('mkv')
    }
  })

  it('refuses or moves every pair the table refuses, before FFmpeg runs', () =>
  {
    for (const p of decided)
    {
      if (!p.policy.startsWith('codec ')) continue
      if (p.decision.ok)
      {
        if (!containerFor(p.name).audioEncoders.has(p.decision.choice.encoder))
        {
          expect(p.decision.containerChanged, `${p.name} ${p.policy}`).toBe(true)
        }
        continue
      }
      expect(['container-cannot-hold', 'no-encoder'], `${p.name} ${p.policy}`).toContain(p.decision.reason)
    }
  })

  it('keeps every allowed policy pair in its own container', () =>
  {
    for (const p of decided)
    {
      if (!p.policy.startsWith('codec ') || !p.decision.ok) continue
      if (containerFor(p.name).audioEncoders.has(p.decision.choice.encoder))
      {
        expect(p.decision.container, `${p.name} ${p.policy}`).toBe(p.name)
      }
    }
  })
})

describe.skipIf(!ready)('G20 capability matrix on real FFmpeg', () =>
{
  const runs = new Map<string, PairRun>()
  let ms = 0

  beforeAll(async () =>
  {
    const started = Date.now()
    await mkdir(outDir, { recursive: true })
    let next = 0
    const worker = async (): Promise<void> =>
    {
      while (next < PAIRS.length)
      {
        const p = PAIRS[next++]
        runs.set(p.key, await runPair(p))
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    ms = Date.now() - started
  })

  afterAll(async () =>
  {
    if (runs.size === 0) return
    await mkdir(golden.reportDir, { recursive: true })
    await writeFile(join(golden.reportDir, `${golden.buildId}-capability.json`), JSON.stringify({ ms, pairs: [...runs.values()] }, null, 2))
  })

  it.each(PAIRS.map((p) => [p.key, p] as const))('%s encodes and decodes', (key, p) =>
  {
    const run = runs.get(key)
    expect(run, key).toBeDefined()
    if (run?.skipped)
    {
      expect(caps.encoders.has(p.encoder)).toBe(false)
      return
    }
    const expectation = muxerExpectation(key)
    if (expectation !== 'accepted')
    {
      const limit = MUXER_LIMITS.find((m) => m.key === key)
      if (expectation === 'refused' || run?.encodeCode !== 0)
      {
        expect(run?.encodeCode, key).not.toBe(0)
        expect(run?.encodeErrors.some((line) => limit?.error.test(line)), key).toBe(true)
        return
      }
    }
    expect({ key, encode: run?.encodeCode, encodeErrors: run?.encodeErrors, decode: run?.decodeCode, decodeErrors: run?.decodeErrors })
      .toEqual({ key, encode: 0, encodeErrors: [], decode: 0, decodeErrors: [] })
    expect(run?.codec).toBe(codecOfEncoder(p.encoder))
  })
})

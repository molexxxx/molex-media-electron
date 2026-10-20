/**
 * Verification of Convert, Compress, and Extract outputs. A media output must probe, hold the streams its plan
 * kept, span the expected duration, decode without errors, and stay at or under a size target; a frame folder
 * must hold its images and a subtitle file its cues.
 */

import { promises as fsp } from 'fs'
import * as path from 'path'
import type { MediaFacts } from '../../../shared/audio/types'
import type { JobError, MediaVerification, Verification } from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import { execArgv } from '../../ffmpeg/exec'
import type { Exec } from '../../ffmpeg/exec'
import { ERROR_TAIL_BYTES, quoteForDisplay, tailAtLineBoundary } from '../log'

/** Decode-error lines a verification keeps; the rest are only counted. */
export const MAX_DECODE_ERRORS = 20

/** The length of one window of a sampled decode, in seconds. */
export const SAMPLE_WINDOW_SEC = 20

/** The windows a sampled decode reads: the start, the middle, and the end. */
export const SAMPLE_WINDOWS = 3

/** The duration tolerance: the larger of this many seconds and DURATION_TOLERANCE_RATIO of the expected span. */
export const DURATION_TOLERANCE_SEC = 0.5

/** The share of the expected span a re-encode's duration may differ by, when larger than DURATION_TOLERANCE_SEC. */
export const DURATION_TOLERANCE_RATIO = 0.005

/** Stream counts as ffprobe reports them; cover art counts as video. */
export interface StreamCounts
{
  video: number
  audio: number
  subtitle: number
  attachment: number
}

/**
 * The span an output should hold. `tolerance` is a re-encode, judged within the tolerance both ways; `covers` is
 * a stream-copy trim, which snaps to keyframes and is judged only on covering the span.
 */
export interface DurationExpectation
{
  expectedSec: number
  rule: 'tolerance' | 'covers'
}

/** A subtitle output format the verifier parses. */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa'

/** What a verification reads: a media file, a folder of frames, or a subtitle file. */
export type VerifyTarget =
  | {
    kind: 'media'
    path: string
    /** The streams the plan kept. */
    streams: StreamCounts
    duration: DurationExpectation | null
    /** A size target in bytes, judged with no allowance over it. */
    targetBytes: number | null
    /** The source's size, so a larger output is reported. */
    sourceBytes: number | null
  }
  | { kind: 'frames'; path: string; extension: string; expectedFrames: number | null }
  | { kind: 'subtitle'; path: string; format: SubtitleFormat }

/** Why an output failed verification. */
export type MediaFailure = 'unreadable' | 'stream-mismatch' | 'decode-errors' | 'no-frames' | 'no-cues'

/** The duration tolerance for an expected span, in seconds. */
export function durationTolerance(expectedSec: number): number
{
  return Math.max(DURATION_TOLERANCE_SEC, DURATION_TOLERANCE_RATIO * expectedSec)
}

/** Judges an output's duration against its expectation; an unknown duration is outside. */
export function durationStatus(actualSec: number | null, expectation: DurationExpectation): 'within' | 'outside'
{
  if (actualSec === null || !Number.isFinite(actualSec))
  {
    return 'outside'
  }
  const tolerance = durationTolerance(expectation.expectedSec)
  if (expectation.rule === 'covers')
  {
    return actualSec >= expectation.expectedSec - tolerance ? 'within' : 'outside'
  }
  return Math.abs(actualSec - expectation.expectedSec) <= tolerance ? 'within' : 'outside'
}

/** Judges bytes against a size target with no allowance over it. */
export function sizeStatus(bytes: number, targetBytes: number | null): 'within' | 'over' | 'not-checked'
{
  if (targetBytes === null)
  {
    return 'not-checked'
  }
  return bytes <= targetBytes ? 'within' : 'over'
}

/** True when a frame count is at least one image and within one of the expected count. */
export function framesWithin(frames: number, expected: number | null): boolean
{
  return frames >= 1 && (expected === null || Math.abs(frames - expected) <= 1)
}

const SRT_TIMING = /^\s*\d+:\d{2}:\d{2}[,.]\d{1,3}\s+-->\s+\d+:\d{2}:\d{2}[,.]\d{1,3}/
const VTT_TIMING = /^\s*(?:\d+:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d+:)?\d{2}:\d{2}\.\d{3}/
const VTT_HEADER = /^WEBVTT(?:[ \t].*)?$/
const ASS_DIALOGUE = /^Dialogue:/

/**
 * Counts the cues of a subtitle file: SRT and WebVTT timing lines, ASS and SSA dialogue lines. Null when the text
 * is not that format (a WebVTT file without its header).
 */
export function countCues(text: string, format: SubtitleFormat): number | null
{
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  if (format === 'vtt')
  {
    if (!VTT_HEADER.test(lines[0] ?? ''))
    {
      return null
    }
    return lines.filter((line) => VTT_TIMING.test(line)).length
  }
  if (format === 'srt')
  {
    return lines.filter((line) => SRT_TIMING.test(line)).length
  }
  return lines.filter((line) => ASS_DIALOGUE.test(line.trimStart())).length
}

/** The start of each window of a sampled decode, or null when the span is too short to sample. */
export function sampleStarts(durationSec: number): number[] | null
{
  if (!Number.isFinite(durationSec) || durationSec <= SAMPLE_WINDOWS * SAMPLE_WINDOW_SEC)
  {
    return null
  }
  const last = durationSec - SAMPLE_WINDOW_SEC
  return [0, round3(last / 2), round3(last)]
}

/**
 * The decode check's arguments: every video and audio stream to the null muxer, or, with window starts, the video
 * in those windows while the audio still decodes in full.
 */
export function decodeArgs(file: string, counts: { video: number; audio: number }, starts: readonly number[] | null): string[]
{
  const args = ['-v', 'error']
  const maps: string[] = []
  let input = 0
  if (starts === null)
  {
    args.push('-i', file)
    if (counts.video > 0)
    {
      maps.push('-map', '0:v')
    }
    if (counts.audio > 0)
    {
      maps.push('-map', '0:a')
    }
    return [...args, ...maps, '-f', 'null', '-']
  }
  if (counts.audio > 0)
  {
    args.push('-i', file)
    maps.push('-map', `${input}:a`)
    input += 1
  }
  for (const start of starts)
  {
    args.push('-ss', String(start), '-t', String(SAMPLE_WINDOW_SEC), '-i', file)
    maps.push('-map', `${input}:v`)
    input += 1
  }
  return [...args, ...maps, '-f', 'null', '-']
}

function round3(value: number): number
{
  return Math.round(value * 1000) / 1000
}

/** The file reads verification needs, over the work folder. */
export interface VerifyFiles
{
  size(file: string): Promise<number>
  text(file: string): Promise<string>
  list(folder: string): Promise<Array<{ name: string; bytes: number }>>
}

/** The verifier's file reads over `fs.promises`. */
export const nodeVerifyFiles: VerifyFiles =
{
  async size(file)
  {
    return (await fsp.stat(file)).size
  },
  async text(file)
  {
    return fsp.readFile(file, 'utf8')
  },
  async list(folder)
  {
    const entries = await fsp.readdir(folder, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile())
    return Promise.all(files.map(async (entry) => ({ name: entry.name, bytes: (await fsp.stat(path.join(folder, entry.name))).size })))
  }
}

const REPEATED = /^\s*Last message repeated (\d+) times?\s*$/

/**
 * Collects the decode check's stderr, which runs at the error level, so every line is an error: the first
 * MAX_DECODE_ERRORS lines are kept and every one is counted, with FFmpeg's "Last message repeated N times" adding
 * its N to the count instead of a line.
 */
export function decodeErrorCollector(): { push(line: string): void; lines: string[]; count(): number }
{
  const lines: string[] = []
  let count = 0
  return {
    push(line)
    {
      if (line.trim() === '')
      {
        return
      }
      const repeated = REPEATED.exec(line)
      if (repeated !== null)
      {
        count += Number(repeated[1])
        return
      }
      count += 1
      if (lines.length < MAX_DECODE_ERRORS)
      {
        lines.push(line)
      }
    },
    lines,
    count: () => count
  }
}

/** Whether the decode check may sample: the setting, unless the placement displaces a file, which always decodes in full. */
export interface DecodePolicy
{
  setting: 'full' | 'sampled'
  displacing: boolean
}

/** What verification reads through: the job's exec, signal, and probe, the file reads, and the verify stage's progress. */
export interface VerifyDeps
{
  exec: Exec
  signal: AbortSignal
  probe(file: string): Promise<MediaFacts>
  files?: VerifyFiles
  progress?(p: { outTimeSec: number | null; durationSec: number | null; speed: number | null; bytes: number | null }): void
}

/** The decode check as it ran. */
export interface DecodeRun
{
  args: string[]
  exitCode: number | null
  exitName: string | null
  signal: string | null
  stderrTail: string
}

/** A verification's result; the verdict decides whether the output can be placed. */
export type MediaCheck =
  | {
    kind: 'checked'
    verdict: 'verified' | 'outside-tolerance' | 'failed'
    media: MediaVerification
    failure: MediaFailure | null
    /** Why the output could not be read, or what did not match. */
    detail: string | null
    decodeRun: DecodeRun | null
    /** A Compress output larger than its source verifies but warns. */
    largerThanSource: boolean
  }
  | { kind: 'aborted' }

type Checked = Extract<MediaCheck, { kind: 'checked' }>

const NO_STREAMS: StreamCounts = { video: 0, audio: 0, subtitle: 0, attachment: 0 }

/** Verifies an output in the work folder; never throws for an unreadable output, and returns aborted on abort. */
export async function verifyMedia(target: VerifyTarget, policy: DecodePolicy, deps: VerifyDeps): Promise<MediaCheck>
{
  const files = deps.files ?? nodeVerifyFiles
  if (target.kind === 'frames')
  {
    return verifyFrames(target, files, deps.signal)
  }
  if (target.kind === 'subtitle')
  {
    return verifySubtitle(target, files, deps.signal)
  }
  return verifyFile(target, policy, files, deps)
}

function emptyMedia(bytes: number, targetBytes: number | null): MediaVerification
{
  return {
    decode: 'full',
    decodeErrors: [],
    decodeErrorCount: 0,
    durationSec: null,
    expectedDurationSec: null,
    duration: 'not-checked',
    streams: { ...NO_STREAMS },
    streamMatch: true,
    size: { bytes, targetBytes, status: sizeStatus(bytes, targetBytes) },
    frames: null,
    cues: null
  }
}

function checked(verdict: Checked['verdict'], media: MediaVerification, failure: MediaFailure | null, detail: string | null): Checked
{
  return { kind: 'checked', verdict, media, failure, detail, decodeRun: null, largerThanSource: false }
}

function messageOf(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

async function verifyFrames(target: Extract<VerifyTarget, { kind: 'frames' }>, files: VerifyFiles, signal: AbortSignal): Promise<MediaCheck>
{
  let entries: Array<{ name: string; bytes: number }>
  try
  {
    entries = await files.list(target.path)
  }
  catch (error)
  {
    return signal.aborted ? { kind: 'aborted' } : checked('failed', emptyMedia(0, null), 'unreadable', messageOf(error))
  }
  if (signal.aborted)
  {
    return { kind: 'aborted' }
  }
  const suffix = `.${target.extension.replace(/^\./, '').toLowerCase()}`
  const images = entries.filter((entry) => entry.name.toLowerCase().endsWith(suffix))
  const media = emptyMedia(images.reduce((sum, entry) => sum + entry.bytes, 0), null)
  media.frames = images.length
  if (images.length === 0)
  {
    return checked('failed', media, 'no-frames', null)
  }
  return checked(framesWithin(images.length, target.expectedFrames) ? 'verified' : 'outside-tolerance', media, null, null)
}

async function verifySubtitle(target: Extract<VerifyTarget, { kind: 'subtitle' }>, files: VerifyFiles, signal: AbortSignal): Promise<MediaCheck>
{
  let bytes: number
  let text: string
  try
  {
    bytes = await files.size(target.path)
    text = await files.text(target.path)
  }
  catch (error)
  {
    return signal.aborted ? { kind: 'aborted' } : checked('failed', emptyMedia(0, null), 'unreadable', messageOf(error))
  }
  if (signal.aborted)
  {
    return { kind: 'aborted' }
  }
  const media = emptyMedia(bytes, null)
  const cues = countCues(text, target.format)
  if (cues === null)
  {
    return checked('failed', media, 'unreadable', `The file is not ${target.format.toUpperCase()} text.`)
  }
  media.cues = cues
  media.streams.subtitle = 1
  return cues === 0 ? checked('failed', media, 'no-cues', null) : checked('verified', media, null, null)
}

/** Stream counts of a probed file; cover art counts as video, as ffprobe reports it. */
export function streamCounts(facts: MediaFacts): StreamCounts
{
  return {
    video: facts.video.length,
    audio: facts.audio.length,
    subtitle: facts.subtitles.length,
    attachment: facts.attachments.length
  }
}

function sameCounts(a: StreamCounts, b: StreamCounts): boolean
{
  return a.video === b.video && a.audio === b.audio && a.subtitle === b.subtitle && a.attachment === b.attachment
}

/** Stream counts as a sentence fragment: "1 video, 3 audio, 0 subtitle, and 0 attachment streams". */
export function describeCounts(c: StreamCounts): string
{
  return `${c.video} video, ${c.audio} audio, ${c.subtitle} subtitle, and ${c.attachment} attachment streams`
}

async function verifyFile(target: Extract<VerifyTarget, { kind: 'media' }>, policy: DecodePolicy, files: VerifyFiles, deps: VerifyDeps):
  Promise<MediaCheck>
{
  const { signal } = deps
  let bytes: number
  try
  {
    bytes = await files.size(target.path)
  }
  catch (error)
  {
    return signal.aborted ? { kind: 'aborted' } : checked('failed', emptyMedia(0, target.targetBytes), 'unreadable', messageOf(error))
  }
  if (signal.aborted)
  {
    return { kind: 'aborted' }
  }
  const media = emptyMedia(bytes, target.targetBytes)
  media.expectedDurationSec = target.duration?.expectedSec ?? null
  const largerThanSource = target.sourceBytes !== null && bytes > target.sourceBytes
  let facts: MediaFacts
  try
  {
    facts = await deps.probe(target.path)
  }
  catch (error)
  {
    return signal.aborted ? { kind: 'aborted' } : { ...checked('failed', media, 'unreadable', messageOf(error)), largerThanSource }
  }
  if (signal.aborted)
  {
    return { kind: 'aborted' }
  }
  media.durationSec = Number.isFinite(facts.durationSec) ? facts.durationSec : null
  media.duration = target.duration === null ? 'not-checked' : durationStatus(media.durationSec, target.duration)
  media.streams = streamCounts(facts)
  media.streamMatch = sameCounts(media.streams, target.streams)
  if (!media.streamMatch)
  {
    const detail = `The output holds ${describeCounts(media.streams)}; the plan kept ${describeCounts(target.streams)}.`
    return { ...checked('failed', media, 'stream-mismatch', detail), largerThanSource }
  }
  const sampled = policy.setting === 'sampled' && !policy.displacing && facts.video.some((stream) => !stream.cover)
  const starts = sampled ? sampleStarts(facts.durationSec) : null
  media.decode = starts === null ? 'full' : 'sampled'
  let decodeRun: DecodeRun | null = null
  if (media.streams.video + media.streams.audio > 0)
  {
    const decoded = await decode(target.path, media.streams, starts, media.durationSec, deps)
    if (decoded === null)
    {
      return { kind: 'aborted' }
    }
    media.decodeErrors = decoded.lines
    media.decodeErrorCount = decoded.count
    decodeRun = decoded.run
  }
  if (media.decodeErrorCount > 0)
  {
    return { ...checked('failed', media, 'decode-errors', null), decodeRun, largerThanSource }
  }
  const outside = media.duration === 'outside' || media.size.status === 'over'
  return { ...checked(outside ? 'outside-tolerance' : 'verified', media, null, null), decodeRun, largerThanSource }
}

async function decode(file: string, counts: StreamCounts, starts: readonly number[] | null, durationSec: number | null, deps: VerifyDeps):
  Promise<{ lines: string[]; count: number; run: DecodeRun } | null>
{
  const args = decodeArgs(file, counts, starts)
  const errors = decodeErrorCollector()
  const progress = deps.progress
  const result = await deps.exec.run(args, {
    signal: deps.signal,
    stop: 'kill',
    ...(durationSec === null ? {} : { durationSec }),
    onStderrLine: (line) => errors.push(line),
    ...(progress === undefined
      ? {}
      : { onProgress: (p) => progress({ outTimeSec: p.outTimeSec, durationSec, speed: p.speed, bytes: null }) })
  })
  if (result.aborted || deps.signal.aborted)
  {
    return null
  }
  const ended = result.code !== 0 || result.signal !== null || result.stopped !== 'none'
  if (ended && errors.count() === 0)
  {
    errors.push(result.signal !== null
      ? `The decode check was stopped by ${result.signal}.`
      : `The decode check ended with exit code ${result.code}${result.exitName === null ? '' : ` (${result.exitName})`}.`)
  }
  return {
    lines: errors.lines,
    count: errors.count(),
    run: { args, exitCode: result.code, exitName: result.exitName, signal: result.signal, stderrTail: result.stderrTail }
  }
}

/** The verification a run reports for a checked output. */
export function toVerification(check: Checked, encodePasses: number): Verification
{
  return { verdict: check.verdict, encodePasses, audio: null, media: check.media, messages: [] }
}

const FAILURE_SHORT: Readonly<Record<MediaFailure, string>> =
{
  'unreadable': 'Output unreadable',
  'stream-mismatch': 'Streams missing',
  'decode-errors': 'Decode errors',
  'no-frames': 'No frames',
  'no-cues': 'No subtitle cues'
}

function failureMessage(check: Checked, failure: MediaFailure): string
{
  switch (failure)
  {
    case 'decode-errors':
    {
      const count = check.media.decodeErrorCount
      return `Decoding the output reported ${count} error${count === 1 ? '' : 's'}, the first: ${check.media.decodeErrors[0] ?? 'none kept'}`
    }
    case 'stream-mismatch':
      return check.detail ?? 'The output does not hold the streams the plan kept.'
    case 'no-frames':
      return 'The output folder holds no images.'
    case 'no-cues':
      return 'The subtitle output holds no cues.'
    default:
      return check.detail === null ? 'The output could not be read back.' : `The output could not be read back: ${check.detail}`
  }
}

/**
 * The job error a failed verification ends the run with: `decode-errors` for decode errors, `output-unreadable`
 * for an output that cannot be read, holds other streams than the plan, or holds no frame or no cue.
 */
export function verificationError(check: Checked, context: { attempt: number; encodePass: number | null; at: number; platform: Platform }):
  JobError
{
  const failure = check.failure ?? 'unreadable'
  const run = failure === 'decode-errors' ? check.decodeRun : null
  const argv = run === null ? null : execArgv(run.args, 'kill')
  return {
    code: failure === 'decode-errors' ? 'decode-errors' : 'output-unreadable',
    short: FAILURE_SHORT[failure],
    cause: failure === 'decode-errors' ? 'decode' : null,
    message: failureMessage(check, failure),
    stage: 'verify',
    attempt: context.attempt,
    encodePass: context.encodePass,
    exitCode: run?.exitCode ?? null,
    exitName: run?.exitName ?? null,
    signal: run?.signal ?? null,
    stderrTail: run === null ? '' : tailAtLineBoundary(run.stderrTail, ERROR_TAIL_BYTES),
    command: argv === null ? null : { argv, display: quoteForDisplay(['ffmpeg', ...argv], context.platform) },
    fsError: null,
    hint: null,
    at: context.at
  }
}

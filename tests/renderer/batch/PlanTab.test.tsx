/**
 * The inspector's Plan tab: the command block's quoting for each platform's shell, its placeholders, and copying; the
 * stream list's kept and not-kept lines; one job's output, original, container, streams, encoder, ceiling, loudness,
 * issues, and planned command; and the several-jobs view with counts, issue groups, destination, and originals.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import
{
  COPY_COMMAND_LABEL,
  CommandBlock,
  quoteArgument,
  quoteCommand,
  splitPlaceholders
} from '../../../src/renderer/src/components/batch/inspector/CommandBlock'
import
{
  dropReasonText,
  languageName,
  StreamList,
  streamLines
} from '../../../src/renderer/src/components/batch/inspector/StreamList'
import
{
  audioEncoderText,
  ceilingText,
  containerText,
  destinationText,
  dialogueRef,
  fixLabel,
  ISSUE_ACTION_LABELS,
  issueActions,
  issueGroups,
  isLoudnessJob,
  jobNotes,
  loudnessBlocks,
  measuredRef,
  originalsText,
  originalText,
  outputNowText,
  PLAN_CAPTIONS,
  PLAN_WORDS,
  PlanTab,
  plannedCommand,
  planRef,
  selectionCounts,
  sortIssues,
  splitName,
  streamHeading,
  videoEncoderText,
  type PlanEntry
} from '../../../src/renderer/src/components/batch/inspector/PlanTab'
import { screenMessage } from '../../../src/renderer/src/copy/batch'
import type { StreamMeasurement } from '../../../src/shared/audio/events'
import type { GainPlan, MediaFacts } from '../../../src/shared/audio/types'
import type { BatchPolicy, JobMeasurement, JobPlan, JobView, PlanIssue } from '../../../src/shared/jobs/types'

afterEach(() =>
{
  cleanup()
})

const CEILING_AC3 =
{
  presetMaxDbtp: -1,
  codecCeilingDbtp: -2,
  ceilingDbtp: -2,
  limiterCeilingDbtp: -2.5,
  gateDbtp: -1,
  decodedLimitDbtp: -1,
  outputClass: 'lossy',
  reason: 'codec'
}

const CEILING_FLAC = { ...CEILING_AC3, codecCeilingDbtp: null, ceilingDbtp: -1, limiterCeilingDbtp: -1.5, decodedLimitDbtp: -1, outputClass: 'lossless', reason: 'preset' }

function audioFacts(audioIndex: number, streamIndex: number, extra: Partial<MediaFacts['audio'][number]> = {}): MediaFacts['audio'][number]
{
  return {
    audioIndex,
    streamIndex,
    codecName: 'ac3',
    profile: null,
    channels: 6,
    layout: '5.1(side)',
    layoutGuessed: false,
    sampleRate: 48000,
    sampleFmt: 'fltp',
    bitsPerRawSample: null,
    bitRate: 448000,
    durationSec: 3600,
    language: 'eng',
    title: null,
    disposition: {},
    ...extra
  }
}

function mediaFacts(extra: Partial<MediaFacts> = {}): MediaFacts
{
  return {
    path: 'D:\\Rips\\film.mkv',
    container: 'mkv',
    formatName: 'matroska,webm',
    durationSec: 3600,
    audio: [audioFacts(0, 1), audioFacts(1, 2, { codecName: 'aac', layout: 'stereo', language: 'fra', title: 'Commentary' })],
    video: [{ streamIndex: 0, codecName: 'h264', cover: false }, { streamIndex: 7, codecName: 'mjpeg', cover: true }],
    subtitles: [{ streamIndex: 3, subIndex: 0, codecName: 'subrip', bitmap: false, language: 'eng' }, { streamIndex: 4, subIndex: 1, codecName: 'hdmv_pgs_subtitle', bitmap: true, language: 'und' }],
    attachments: [{ streamIndex: 5, filename: 'a.ttf', mimetype: 'font/ttf' }, { streamIndex: 6, filename: 'b.ttf', mimetype: 'font/ttf' }],
    data: [{ streamIndex: 8, codecName: 'bin_data' }],
    chapters: 12,
    ...extra
  }
}

function jobPlan(extra: Partial<JobPlan> = {}): JobPlan
{
  return {
    basis: { inputsRev: 1, policyRev: 1, capabilitiesRev: 1 },
    fingerprint: 'f',
    source: { path: 'D:\\Rips\\film.mkv', size: 1000, mtimeMs: 1 },
    output:
    {
      kind: 'file',
      finalPath: 'D:\\Exports\\film.mp4',
      container: 'mp4',
      muxer: 'mp4',
      containerChanged: null,
      conflict: 'none',
      resolution: 'place',
      renamedTo: null,
      displaces: null
    },
    streams:
    {
      kept:
      [
        { kind: 'video', source: 0, output: 0, action: 'copy' },
        { kind: 'audio', source: 1, output: 1, action: 'encode' },
        { kind: 'audio', source: 2, output: 2, action: 'copy' },
        { kind: 'subtitle', source: 3, output: 3, action: 'convert' }
      ],
      dropped:
      [
        { kind: 'subtitle', source: 4, reason: 'bitmap-subtitle' },
        { kind: 'attachment', source: 5, reason: 'attachments-unsupported' },
        { kind: 'attachment', source: 6, reason: 'attachments-unsupported' },
        { kind: 'cover', source: 7, reason: 'cover-unsupported' },
        { kind: 'data', source: 8, reason: 'data-stream' }
      ],
      chapters: 'dropped'
    },
    video: null,
    audio:
    [
      { audioIndex: 0, encoder: 'ac3', bitrateKbps: 448, outputLayout: '5.1(side)', outputRate: 48000, ceiling: CEILING_AC3, notes: [], bitsPerSample: null, messages: [] },
      { audioIndex: 1, encoder: 'copy', bitrateKbps: null, outputLayout: 'stereo', outputRate: 48000, ceiling: CEILING_AC3, notes: [], bitsPerSample: null, messages: [] }
    ],
    class: 'audio',
    stages: [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }],
    estimate: { outputBytes: 900_000_000, reserveBytes: 0, workSec: 60, confidence: 'medium' },
    album: null,
    command: null,
    ...extra
  } as JobPlan
}

describe('streamLines', () =>
{
  it('names each kept stream with codec, layout, language, title, and what happens to it', () =>
  {
    const { kept } = streamLines(jobPlan(), mediaFacts())
    expect(kept.map((line) => [line.term, line.detail])).toEqual([
      ['Video 1', 'h264 · copied'],
      ['Audio 1', 'AC-3 · 5.1(side) · English · encoded as AC-3 448 kb/s'],
      ['Audio 2', 'AAC · stereo · French · \u201cCommentary\u201d · copied'],
      ['Subtitle 1', 'subrip · English · converted']
    ])
  })

  it('gives each stream left out its reason and counts attachments, data, cover art, and chapters', () =>
  {
    const { dropped } = streamLines(jobPlan(), mediaFacts())
    expect(dropped.map((line) => [line.term, line.detail])).toEqual([
      ['Subtitle 2', 'hdmv_pgs_subtitle · bitmap: MP4 cannot hold bitmap subtitles.'],
      ['Attachments', '2 attachments: MP4 cannot hold attachments.'],
      ['Cover art', '1 cover image: MP4 cannot hold cover art.'],
      ['Data streams', '1 data stream: Data streams are not kept.'],
      ['Chapters', '12 chapters: MP4 cannot hold chapters.']
    ])
  })

  it('counts kept attachments and chapters, and names streams the probe does not describe', () =>
  {
    const plan = jobPlan({
      streams:
      {
        kept:
        [
          { kind: 'attachment', source: 5, output: 4, action: 'copy' },
          { kind: 'attachment', source: 6, output: 5, action: 'copy' },
          { kind: 'audio', source: 9, output: 0, action: 'encode' },
          { kind: 'video', source: 9, output: 1, action: 'encode' },
          { kind: 'subtitle', source: 9, output: 2, action: 'copy' },
          { kind: 'thumbnail', source: 9, output: 3, action: 'copy' }
        ],
        dropped: [{ kind: 'audio', source: 10, reason: 'policy' }, { kind: 'video', source: 11, reason: 'container-no-video' }],
        chapters: 'kept'
      },
      video: { encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: [], notes: [], cpuFallback: null }
    })
    const lines = streamLines(plan, mediaFacts())
    expect(lines.kept.map((line) => [line.term, line.detail])).toEqual([
      ['Audio, stream 9', 'encoded'],
      ['Video, stream 9', 'encoded as libx264'],
      ['Subtitle, stream 9', 'copied'],
      ['Thumbnail, stream 9', 'copied'],
      ['Attachments', '2 attachments, copied'],
      ['Chapters', '12 chapters']
    ])
    expect(lines.dropped.map((line) => line.detail)).toEqual(['These settings drop it.', 'MP4 holds no video.'])
    expect(streamLines(plan, null).kept.at(-1)).toEqual({ key: 'kept-chapters', term: 'Chapters', detail: 'kept' })
    expect(streamLines(jobPlan(), null).dropped.at(-1)?.detail).toBe('MP4 cannot hold chapters.')
    expect(streamLines(jobPlan({ streams: { kept: [], dropped: [], chapters: 'none' } }), null)).toEqual({ kept: [], dropped: [] })
  })

  it('words a kept video encode and an audio encode without a bitrate', () =>
  {
    const plan = jobPlan({
      streams: { kept: [{ kind: 'video', source: 0, output: 0, action: 'encode' }, { kind: 'audio', source: 1, output: 1, action: 'encode' }], dropped: [], chapters: 'none' },
      audio: [{ ...jobPlan().audio[0], encoder: 'flac', bitrateKbps: null }]
    })
    expect(streamLines(plan, mediaFacts()).kept.map((line) => line.detail)).toEqual(['h264 · encoded', 'AC-3 · 5.1(side) · English · encoded as FLAC'])
  })
})

describe('dropReasonText', () =>
{
  it('words every reason main gives for the output container', () =>
  {
    expect(dropReasonText('container-one-audio', 'wav')).toMatch(/holds one audio stream\.$/)
    expect(dropReasonText('subtitle-unsupported', 'mp4')).toBe('MP4 cannot hold these subtitles.')
    expect(dropReasonText('the container is full', 'mp4')).toBe('The container is full.')
    expect(dropReasonText('Already a sentence.', 'mp4')).toBe('Already a sentence.')
  })
})

describe('languageName', () =>
{
  it('names languages and leaves out undetermined ones', () =>
  {
    expect(languageName('eng')).toBe('English')
    expect(languageName('und')).toBeNull()
    expect(languageName(null)).toBeNull()
    expect(languageName('')).toBeNull()
    expect(languageName('not a code!')).toBe('not a code!')
  })
})

describe('StreamList', () =>
{
  it('renders a labeled, selectable definition list', () =>
  {
    render(<StreamList label='Streams kept' lines={[{ key: 'a', term: 'Audio 1', detail: 'AAC · stereo · copied' }]} />)
    const list = screen.getByLabelText('Streams kept')
    expect(list.tagName).toBe('DL')
    expect(list.className).toContain('select-text')
    expect(list.querySelector('dt')).toHaveTextContent('Audio 1')
    expect(list.querySelector('dd')).toHaveTextContent('AAC · stereo · copied')
  })
})

describe('quoteArgument', () =>
{
  it('leaves plain arguments bare on every platform', () =>
  {
    expect(quoteArgument('-c:a', 'win32')).toBe('-c:a')
    expect(quoteArgument('0:a:0', 'linux')).toBe('0:a:0')
    expect(quoteArgument('D:\\Rips\\a.mkv', 'win32')).toBe('D:\\Rips\\a.mkv')
  })

  it('quotes for the Windows argument rules', () =>
  {
    expect(quoteArgument('D:\\My Rips\\a b.mkv', 'win32')).toBe('"D:\\My Rips\\a b.mkv"')
    expect(quoteArgument('', 'win32')).toBe('""')
    expect(quoteArgument('say "hi"', 'win32')).toBe('"say \\"hi\\""')
    expect(quoteArgument('C:\\dir with space\\', 'win32')).toBe('"C:\\dir with space\\\\"')
    expect(quoteArgument('a\\"b c', 'win32')).toBe('"a\\\\\\"b c"')
    expect(quoteArgument('volume=<gain>dB', 'win32')).toBe('"volume=<gain>dB"')
  })

  it('quotes for a POSIX shell elsewhere', () =>
  {
    expect(quoteArgument('/media/My Rips/a.mkv', 'darwin')).toBe("'/media/My Rips/a.mkv'")
    expect(quoteArgument("Bob's song.flac", 'linux')).toBe("'Bob'\\''s song.flac'")
    expect(quoteArgument('', 'linux')).toBe("''")
    expect(quoteArgument('[0:a]loudnorm;[a]', 'linux')).toBe("'[0:a]loudnorm;[a]'")
  })

  it('joins a whole command', () =>
  {
    expect(quoteCommand(['ffmpeg', '-i', 'a b.wav', 'out.flac'], 'win32')).toBe('ffmpeg -i "a b.wav" out.flac')
    expect(quoteCommand(['ffmpeg', '-i', 'a b.wav', 'out.flac'], 'linux')).toBe("ffmpeg -i 'a b.wav' out.flac")
  })
})

describe('splitPlaceholders', () =>
{
  it('marks every placeholder, longest first', () =>
  {
    expect(splitPlaceholders('-af volume={gain-a0}dB {output}', ['{output}', '{gain-a0}'])).toEqual([
      { text: '-af volume=', placeholder: false },
      { text: '{gain-a0}', placeholder: true },
      { text: 'dB ', placeholder: false },
      { text: '{output}', placeholder: true }
    ])
    expect(splitPlaceholders('a {gain-a10} b', ['{gain-a1}', '{gain-a10}']).filter((p) => p.placeholder)).toEqual([
      { text: '{gain-a10}', placeholder: true }
    ])
  })

  it('returns the text whole without placeholders, and nothing for no text', () =>
  {
    expect(splitPlaceholders('ffmpeg -i a', [])).toEqual([{ text: 'ffmpeg -i a', placeholder: false }])
    expect(splitPlaceholders('', [])).toEqual([])
    expect(splitPlaceholders('x', ['', 'y'])).toEqual([{ text: 'x', placeholder: false }])
  })
})

describe('CommandBlock', () =>
{
  it('quotes the argument list for the given platform and keeps it selectable', () =>
  {
    render(<CommandBlock label='Planned FFmpeg command' platform='win32' argv={['ffmpeg', '-i', 'D:\\My Rips\\a.mkv', '{output}']} placeholders={['{output}']} state='planned' />)
    const group = screen.getByRole('group', { name: 'Planned FFmpeg command' })
    expect(group).toHaveAttribute('data-state', 'planned')
    const pre = group.querySelector('pre') as HTMLElement
    expect(pre).toHaveTextContent('ffmpeg -i "D:\\My Rips\\a.mkv" {output}')
    expect(pre.className).toContain('select-text')
    expect(group.querySelector('[data-part="placeholder"]')).toHaveTextContent('{output}')
  })

  it('shows an executed line as given', () =>
  {
    render(<CommandBlock label='Command' display="ffmpeg -i 'a b.wav' out.flac" />)
    const group = screen.getByRole('group', { name: 'Command' })
    expect(group).toHaveAttribute('data-state', 'executed')
    expect(group.querySelector('pre')).toHaveTextContent("ffmpeg -i 'a b.wav' out.flac")
    expect(group.querySelector('[data-part="placeholder"]')).toBeNull()
  })

  it('copies exactly the shown text, then reports it', async () =>
  {
    const onCopy = vi.fn(async () => undefined)
    const onCopied = vi.fn()
    render(<CommandBlock label='Command' platform='linux' argv={['ffmpeg', '-i', 'a b.wav']} onCopy={onCopy} onCopied={onCopied} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: COPY_COMMAND_LABEL }))
    })
    expect(onCopy).toHaveBeenCalledWith("ffmpeg -i 'a b.wav'")
    expect(onCopied).toHaveBeenCalledWith("ffmpeg -i 'a b.wav'")
  })

  it('stays quiet when the clipboard refuses', async () =>
  {
    const onCopied = vi.fn()
    const onCopy = vi.fn(async () =>
    {
      throw new Error('denied')
    })
    render(<CommandBlock label='Command' display='ffmpeg' onCopy={onCopy} onCopied={onCopied} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: COPY_COMMAND_LABEL }))
    })
    expect(onCopy).toHaveBeenCalled()
    expect(onCopied).not.toHaveBeenCalled()
  })

  it('writes to the system clipboard by default and disables copying with no command', async () =>
  {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { rerender } = render(<CommandBlock label='Command' display='ffmpeg -version' />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: COPY_COMMAND_LABEL }))
    })
    expect(writeText).toHaveBeenCalledWith('ffmpeg -version')
    rerender(<CommandBlock label='Command' />)
    expect(screen.getByRole('button', { name: COPY_COMMAND_LABEL })).toBeDisabled()
  })
})

const MINUS = '\u2212'

const POLICY: BatchPolicy =
{
  rev: 1,
  destination: { mode: 'folder', folder: 'D:\\Exports' },
  template: '{name}',
  conflict: 'rename',
  displaced: 'trash',
  gpu: 'auto'
}

function policy(extra: Partial<BatchPolicy> = {}): BatchPolicy
{
  return { ...POLICY, ...extra }
}

function jobView(id: string, extra: Partial<JobView> = {}): JobView
{
  return {
    id,
    seq: 1,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.mkv`, name: `${id}.mkv`, ext: 'mkv', dir: 'D:\\Rips', size: 1000, mtimeMs: 1, origin: 'files', subdir: '' },
    recipe: { kind: 'normalize' },
    recipeLabel: 'EBU R 128',
    state: 'pending',
    reason: null,
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'ok',
    plan: null,
    audioPlan: null,
    stamp: null,
    error: null,
    warnings: [],
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: 1,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...extra
  } as JobView
}

function issue(code: PlanIssue['code'], severity: PlanIssue['severity'], message: string, fix: PlanIssue['fix'] = null): PlanIssue
{
  return { code, severity, message, field: 'streams', fix }
}

function stats(extra: Partial<StreamMeasurement['stats']> = {}): StreamMeasurement['stats']
{
  return {
    status: 'measured',
    integratedLufs: -20.9,
    thresholdLufs: -31,
    loudnessRangeLu: 15.8,
    lraStatus: 'measured',
    maxShortTermLufs: null,
    truePeakDbtp: -7.1,
    dialogueLufs: null,
    dualMono: false,
    channelWeights: 'bs1770-annex1',
    ...extra
  }
}

function streamMeasurement(audioIndex = 0, extra: Partial<StreamMeasurement> = {}): StreamMeasurement
{
  return { audioIndex, layout: '5.1(side)', channels: 6, sampleRate: 48000, stats: stats(), loudnessToDialogueLu: null, ...extra }
}

function gainPlan(extra: Partial<GainPlan> = {}): GainPlan
{
  return {
    audioIndex: 0,
    mode: 'linear',
    reason: 'fits',
    targetLufs: -18,
    requestedGainDb: 2.9,
    gainDb: 2.9,
    headroomDb: 5.1,
    limitingDb: 0,
    maxLimitingDb: 1,
    predictedLufs: -18,
    predictedTruePeakDbtp: -4.2,
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling: CEILING_AC3,
    ...extra
  } as GainPlan
}

function measurement(streams: JobMeasurement['streams'], messages: JobMeasurement['messages'] = []): JobMeasurement
{
  return { pass: 'preview', measuredAt: 1, streams, album: null, messages }
}

function entry(jobId: string, extra: Partial<PlanEntry> = {}): PlanEntry
{
  return { jobId, inputsRev: 1, status: 'ready', plan: jobPlan(), issues: [], ...extra } as PlanEntry
}

describe('plan sentences', () =>
{
  it('says what is at the output path now', () =>
  {
    const output = jobPlan().output
    expect(outputNowText(output, POLICY, 'win32')).toBe(PLAN_WORDS.noFile)
    expect(outputNowText({ ...output, conflict: 'exists', resolution: 'rename', renamedTo: 'D:\\Exports\\film (2).mp4' }, POLICY, 'win32'))
      .toBe('A file with this name exists; this job writes film (2).mp4.')
    expect(outputNowText({ ...output, conflict: 'exists', resolution: 'rename' }, POLICY, 'win32'))
      .toBe('A file with this name exists; this job writes film.mp4.')
    expect(outputNowText({ ...output, conflict: 'exists', resolution: 'overwrite' }, POLICY, 'win32'))
      .toBe('A file with this name exists; it goes to the Recycle Bin after this output verifies.')
    expect(outputNowText({ ...output, conflict: 'exists', resolution: 'overwrite' }, POLICY, 'darwin'))
      .toBe('A file with this name exists; it goes to the Trash after this output verifies.')
    expect(outputNowText({ ...output, conflict: 'exists', resolution: 'overwrite', displaces: 'D:\\Exports\\film.mp4' }, policy({ displaced: 'keep' }), 'win32'))
      .toBe('A file with this name exists; it stays as film (previous).mp4 after this output verifies.')
    expect(outputNowText({ ...output, conflict: 'exists', resolution: 'skip' }, POLICY, 'win32')).toBe('A file with this name exists; this job will skip.')
    expect(outputNowText({ ...output, resolution: 'replace-original' }, POLICY, 'win32')).toBeNull()
  })

  it('states what happens to the original', () =>
  {
    const replace = jobPlan({ source: { path: 'D:\\Live\\concert-set-02.flac', size: 1, mtimeMs: 1 }, output: { ...jobPlan().output, resolution: 'replace-original' } })
    expect(originalText(jobPlan(), [], POLICY, 'win32')).toBe('Not touched.')
    expect(originalText(replace, [], POLICY, 'win32'))
      .toBe('Goes to the Recycle Bin after the output verifies. If the bin refuses it, it stays here as concert-set-02 (original).flac.')
    expect(originalText(replace, [], policy({ displaced: 'keep' }), 'win32'))
      .toBe('Renamed to concert-set-02 (original).flac after the output verifies; nothing goes to the Recycle Bin.')
    expect(originalText(jobPlan(), [issue('extract-never-replaces', 'info', 'Extract jobs never replace originals; this one writes beside its source.')], POLICY, 'win32'))
      .toBe(PLAN_WORDS.extractStays)
    const bare = jobPlan({ source: { path: '/media/README', size: 1, mtimeMs: 1 }, output: { ...jobPlan().output, resolution: 'replace-original' } })
    expect(originalText(bare, [], policy({ displaced: 'keep' }), 'linux')).toMatch(/^Renamed to README \(original\) after/)
  })

  it('splits names into stem and extension', () =>
  {
    expect(splitName('a.b.flac')).toEqual({ stem: 'a.b', ext: 'flac' })
    expect(splitName('.hidden')).toEqual({ stem: '.hidden', ext: '' })
    expect(splitName('README')).toEqual({ stem: 'README', ext: '' })
  })

  it('names the container and the source container when they differ', () =>
  {
    expect(containerText(jobPlan(), 'mkv')).toBe('MP4, from MKV')
    expect(containerText(jobPlan(), 'mp4')).toBe('MP4')
    expect(containerText(jobPlan(), null)).toBe('MP4')
    expect(containerText(jobPlan(), '')).toBe('MP4')
  })

  it('names the encoders as they run', () =>
  {
    const video = { encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: [], notes: [], cpuFallback: null } as const
    expect(videoEncoderText(video)).toBe('libx264, CPU')
    expect(videoEncoderText({ ...video, encoder: 'h264_nvenc', gpu: 'NVENC', passes: 2 })).toBe('h264_nvenc, two-pass, GPU (NVENC)')
    expect(audioEncoderText(jobPlan().audio[0])).toBe('Audio 1: AC-3 448 kb/s')
    expect(audioEncoderText(jobPlan().audio[1])).toBe('Audio 2: copied')
    expect(audioEncoderText({ ...jobPlan().audio[0], encoder: 'flac', bitrateKbps: null })).toBe('Audio 1: FLAC')
  })

  it('states each ceiling with its basis and the limiter level', () =>
  {
    expect(ceilingText({ ...jobPlan().audio[0], encoder: 'aac', bitrateKbps: 256 })).toEqual({
      value: `Audio 1: ${MINUS}2.0 dBTP for AAC at 256 kb/s`,
      basis: `This app's measured ceiling for AAC; the preset allows ${MINUS}1.0 dBTP. The limiter targets ${MINUS}2.5 dBTP.`
    })
    expect(ceilingText({ ...jobPlan().audio[0], encoder: 'flac', bitrateKbps: null, ceiling: CEILING_FLAC })).toEqual({
      value: `Audio 1: ${MINUS}1.0 dBTP for FLAC`,
      basis: `The preset's maximum true peak. The limiter targets ${MINUS}1.5 dBTP.`
    })
  })

  it('labels every fix with its scope', () =>
  {
    expect(fixLabel({ kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' }, 2)).toBe('Use Rename for this batch')
    expect(fixLabel({ kind: 'add-token', token: '{subdir}', scope: 'batch' }, 2)).toBe('Add {subdir} to file names')
    expect(fixLabel({ kind: 'set-gpu', gpu: 'off', scope: 'batch' }, 1)).toBe('Turn off GPU encoding for this batch')
    expect(fixLabel({ kind: 'set-gpu', gpu: 'auto', scope: 'batch' }, 1)).toBe('Set GPU encoding to Auto for this batch')
    expect(fixLabel({ kind: 'set-displaced', displaced: 'keep', scope: 'batch' }, 1)).toBe('Keep old files beside the new ones for this batch')
    expect(fixLabel({ kind: 'set-destination', destination: 'next-to-source', scope: 'batch' }, 1)).toBe('Write next to each source instead')
    expect(fixLabel({ kind: 'set-container', container: 'mkv', scope: 'jobs' }, 2)).toBe('Write MKV instead for 2 jobs')
    expect(fixLabel({ kind: 'set-container', container: 'mka', scope: 'jobs' }, 1)).toBe('Keep all tracks as .mka for 1 job')
    expect(fixLabel({ kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'downmix', value: 'standard' }, scope: 'jobs' }, 3))
      .toBe('Downmix to stereo for 3 jobs')
    expect(fixLabel({ kind: 'remove', scope: 'jobs' }, 1)).toBe('Remove from queue')
  })

  it('offers page actions by issue code and sorts blocking issues first', () =>
  {
    expect(issueActions('source-missing').map((action) => ISSUE_ACTION_LABELS[action])).toEqual(['Locate\u2026'])
    expect(issueActions('same-as-source')).toEqual(['change-file-name', 'choose-replace'])
    expect(issueActions('container-changed')).toEqual([])
    const sorted = sortIssues([issue('chapters-dropped', 'info', 'a'), issue('disk-tight', 'warning', 'b'), issue('not-media', 'error', 'c'), issue('path-long', 'warning', 'd')])
    expect(sorted.map((item) => item.message)).toEqual(['c', 'b', 'd', 'a'])
  })
})

describe('loudness sentences', () =>
{
  it('knows which recipes are measured', () =>
  {
    expect(isLoudnessJob({ recipe: { kind: 'normalize' } } as JobView)).toBe(true)
    expect(isLoudnessJob({ recipe: { kind: 'boost' } } as JobView)).toBe(true)
    expect(isLoudnessJob({ recipe: { kind: 'convert' } } as JobView)).toBe(false)
  })

  it('renders the measured line with U+2212 and the preset unit', () =>
  {
    const ref = measuredRef(streamMeasurement(), 'LUFS')
    expect(screenMessage(ref!)).toBe(`${MINUS}20.9 LUFS integrated, 15.8 LU range, ${MINUS}7.1 dBTP true peak.`)
    const short = measuredRef(streamMeasurement(0, { stats: stats({ lraStatus: 'not-applicable', loudnessRangeLu: null }) }), 'LKFS')
    expect(screenMessage(short!)).toBe(`${MINUS}20.9 LKFS integrated, ${MINUS}7.1 dBTP true peak. Loudness range is not applicable under 1 minute.`)
    expect(measuredRef(streamMeasurement(0, { stats: stats({ status: 'silent' }) }), 'LUFS')).toBeNull()
  })

  it('renders every plan sentence of the audio templates', () =>
  {
    const said = (plan: GainPlan, op: 'normalize' | 'boost' = 'normalize', codec = 'ac3'): string => screenMessage(planRef(plan, codec, 'LUFS', op)!)
    expect(said(gainPlan({ gainDb: -2.1, requestedGainDb: -2.1, predictedTruePeakDbtp: -9.2 })))
      .toBe(`Gain ${MINUS}2.1 dB. Predicted true peak ${MINUS}9.2 dBTP, under the ${MINUS}2.0 dBTP ceiling for AC-3.`)
    expect(said(gainPlan({ mode: 'peak-limited', reason: 'needs-limiting', gainDb: 5, requestedGainDb: 5, limitingDb: 2.5, ceiling: CEILING_FLAC }), 'normalize', 'flac'))
      .toBe(`Gain +5.0 dB with about 2.5 dB of peak limiting to stay under the ${MINUS}1.0 dBTP ceiling for FLAC. Limiting can lower the result by a few tenths of a LU.`)
    expect(said(gainPlan({ mode: 'reachable-linear', reason: 'headroom-capped', targetLufs: -8, requestedGainDb: 6, gainDb: 2.5, headroomDb: 2.5, predictedLufs: -11.5 })))
      .toBe(`${MINUS}8.0 LUFS needs +6.0 dB, but the peaks allow +2.5 dB. Normalizing to ${MINUS}11.5 LUFS instead. Reaching ${MINUS}8.0 LUFS would take 3.5 dB of peak limiting.`)
    expect(said(gainPlan({ mode: 'reachable-limited', reason: 'limiting-capped', targetLufs: -9, requestedGainDb: 5, gainDb: 3.5, limitingDb: 1, maxLimitingDb: 1, predictedLufs: -10.5 })))
      .toBe(`${MINUS}9.0 LUFS needs +5.0 dB. With the 1.0 dB limiting allowance the result is ${MINUS}10.5 LUFS.`)
    expect(said(gainPlan({ mode: 'reachable-linear', reason: 'short-term-capped', targetLufs: -23, requestedGainDb: 13.2, shortTermLimitLufs: -18, predictedLufs: -23.6 })))
      .toBe(`${MINUS}23.0 LUFS needs +13.2 dB, but the short-form limit keeps the maximum short-term loudness at ${MINUS}18.0 LUFS. Normalizing to ${MINUS}23.6 LUFS instead.`)
    expect(said(gainPlan({ mode: 'reachable-limited', reason: 'limiting-capped', requestedGainDb: 6, gainDb: 5.5, headroomDb: 2.5, limitingDb: 3, maxLimitingDb: 3 }), 'boost'))
      .toBe('Applying +5.5 dB of the requested +6.0 dB: the full gain needs 3.5 dB of peak limiting, over the 3.0 dB allowance.')
    expect(said(gainPlan({ requestedGainDb: 6, gainDb: 5.5, headroomDb: null, limitingDb: 3, maxLimitingDb: 3 }), 'boost')).toMatch(/needs 3\.0 dB of peak limiting/)
    expect(said(gainPlan({ mode: 'peak-limited', gainDb: 6, requestedGainDb: 6, limitingDb: 2 }), 'boost')).toMatch(/^Gain \+6\.0 dB with about 2\.0 dB/)
    expect(said(gainPlan({ mode: 'passthrough', reason: 'silent' }))).toBe('Silent stream. Copied unchanged.')
    expect(said(gainPlan({ mode: 'passthrough', reason: 'too-short' }))).toBe('Shorter than 0.4 s, too short to measure loudness. Copied unchanged.')
    expect(said(gainPlan({ mode: 'passthrough', reason: 'below-floor' }))).toBe(`Below the ${MINUS}70 LUFS measurement floor. Copied unchanged.`)
    expect(planRef(gainPlan({ mode: 'passthrough', reason: 'measured' }), 'ac3', 'LUFS', 'normalize')).toBeNull()
    expect(said(gainPlan({ mode: 'reachable-linear', reason: 'headroom-capped', headroomDb: null }))).toContain('?')
  })

  it('renders the center-channel estimate for cinematic streams only', () =>
  {
    const ref = dialogueRef(streamMeasurement(0, { stats: stats({ dialogueLufs: -32.8 }), loudnessToDialogueLu: 11.9 }), 'LUFS')
    expect(screenMessage(ref!)).toMatch(new RegExp(`^Center-channel integrated loudness ${MINUS}32\\.8 LUFS`))
    expect(dialogueRef(streamMeasurement(), 'LUFS')).toBeNull()
  })

  it('keeps job-level notes and leaves stream sentences to their blocks', () =>
  {
    const notes = jobNotes([{ key: 'measured', params: {} }, { key: 'mono-one', params: {} }, { key: 'plan-linear', params: {} }, { key: 'meter-swr', params: {} }])
    expect(notes.map((ref) => ref.key)).toEqual(['mono-one', 'meter-swr'])
  })

  it('heads each stream block from the probe', () =>
  {
    expect(streamHeading(0, mediaFacts())).toBe('Audio 1 · English · 5.1(side) · AC-3 448 kb/s')
    expect(streamHeading(1, mediaFacts({ audio: [audioFacts(1, 2, { codecName: 'flac', layout: null, bitRate: null, language: null })] }))).toBe('Audio 2 · FLAC')
    expect(streamHeading(3, null)).toBe('Audio 4')
  })

  it('builds one block per measured stream with its static sentences after the plan', () =>
  {
    const plan = jobPlan({ audio: [{ ...jobPlan().audio[0], messages: [{ key: 'mono-duplicated', params: {} }] }] })
    const blocks = loudnessBlocks({
      view: jobView('MM-0001', { audioPlan: [{ audioIndex: 0, mode: 'linear', gainDb: 2.9, requestedGainDb: 2.9, limitingDb: 0, predictedLufs: -18, unit: 'LKFS', status: 'measured' }] }),
      plan,
      media: mediaFacts(),
      measurement: measurement([{ measurement: streamMeasurement(), plan: gainPlan() }, { measurement: streamMeasurement(5), plan: null }])
    })
    expect(blocks[0]).toEqual({
      audioIndex: 0,
      heading: 'Audio 1 · English · 5.1(side) · AC-3 448 kb/s',
      measured: `${MINUS}20.9 LKFS integrated, 15.8 LU range, ${MINUS}7.1 dBTP true peak.`,
      plan: [
        `Gain +2.9 dB. Predicted true peak ${MINUS}4.2 dBTP, under the ${MINUS}2.0 dBTP ceiling for AC-3.`,
        'Mono duplicated into two identical channels, as Apple Podcasts asks; measured as stereo.'
      ]
    })
    expect(blocks[1]).toEqual({ audioIndex: 5, heading: 'Audio 6', measured: `${MINUS}20.9 LUFS integrated, 15.8 LU range, ${MINUS}7.1 dBTP true peak.`, plan: [] })
    expect(loudnessBlocks({ view: jobView('MM-0001'), plan: null, media: null, measurement: null })).toEqual([])
    expect(loudnessBlocks({ view: jobView('MM-0001', { recipe: { kind: 'convert' } as JobView['recipe'] }), plan: null, media: null, measurement: measurement([]) })).toEqual([])
    const boost = loudnessBlocks({ view: jobView('MM-0001', { recipe: { kind: 'boost' } as JobView['recipe'] }), plan: null, media: null, measurement: measurement([{ measurement: streamMeasurement(), plan: gainPlan() }]) })
    expect(boost[0].plan[0]).toMatch(/ceiling for \?\.$/)
  })
})

describe('plannedCommand', () =>
{
  const command = { argv: ['-i', 'in.wav', '-af', 'volume={gain-a0}dB', '-af', 'volume={gain-a1}dB', '{output}'], display: '', placeholders: ['{output}', '{gain-a0}', '{gain-a1}'] }

  it('keeps measurement placeholders until each stream is measured', () =>
  {
    expect(plannedCommand(command, [])).toEqual({ argv: ['ffmpeg', ...command.argv], placeholders: command.placeholders })
  })

  it('fills each measured stream gain with an ASCII minus and keeps the rest', () =>
  {
    const filled = plannedCommand(command, [gainPlan({ gainDb: -2.1 }), gainPlan({ audioIndex: 1, mode: 'passthrough', reason: 'silent' })])
    expect(filled.argv).toEqual(['ffmpeg', '-i', 'in.wav', '-af', 'volume=-2.1dB', '-af', 'volume={gain-a1}dB', '{output}'])
    expect(filled.placeholders).toEqual(['{output}', '{gain-a1}'])
  })

  it('fills a single stream plain gain placeholder and keeps a program already named', () =>
  {
    const single = { argv: ['C:\\ffmpeg\\bin\\ffmpeg.exe', '-af', 'volume=<gain>dB'], display: '', placeholders: ['<gain>'] }
    expect(plannedCommand(single, [gainPlan()])).toEqual({ argv: ['C:\\ffmpeg\\bin\\ffmpeg.exe', '-af', 'volume=2.9dB'], placeholders: [] })
    expect(plannedCommand(single, [gainPlan(), gainPlan({ audioIndex: 1 })]).placeholders).toEqual(['<gain>'])
    expect(plannedCommand({ argv: [], display: '', placeholders: [] }, [])).toEqual({ argv: ['ffmpeg'], placeholders: [] })
  })
})

function section(caption: string): HTMLElement
{
  return screen.getByRole('region', { name: caption })
}

describe('PlanTab, one job', () =>
{
  const loudCommand = { argv: ['-i', 'D:\\Rips\\MM-0001.mkv', '-af', 'volume={gain-a0}dB', '{output}'], display: '', placeholders: ['{output}', '{gain-a0}'] }

  it('renders nothing without jobs', () =>
  {
    const { container } = render(<PlanTab jobs={[]} policy={POLICY} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('waits for the probe', () =>
  {
    render(<PlanTab jobs={[jobView('MM-0001', { probe: 'pending' })]} policy={POLICY} />)
    expect(screen.getByText(PLAN_WORDS.probing)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.output })).toBeNull()
  })

  it('lays out the sections in order, selectable, for an unmeasured Normalize job', () =>
  {
    const view = jobView('MM-0001')
    const onMeasureNow = vi.fn()
    const { container } = render(
      <PlanTab
        jobs={[view]}
        detail={{ view, plan: null, media: mediaFacts(), measurement: null }}
        entries={[entry('MM-0001', { plan: jobPlan({ command: loudCommand }) })]}
        policy={POLICY}
        platform='win32'
        onMeasureNow={onMeasureNow}
      />
    )
    expect((container.firstChild as HTMLElement).className).toContain('select-text')
    const captions = [...container.querySelectorAll('h3')].map((heading) => heading.textContent?.replace(/(.+)\1/, '$1'))
    expect(captions).toEqual(['Output', 'Original', 'Container', 'Streams kept', 'Not kept', 'Encoder', 'Ceiling', 'Loudness', 'Issues'])
    expect(section(PLAN_CAPTIONS.output)).toHaveTextContent('D:\\Exports\\film.mp4')
    expect(section(PLAN_CAPTIONS.output)).toHaveTextContent(PLAN_WORDS.noFile)
    expect(section(PLAN_CAPTIONS.original)).toHaveTextContent('Not touched.')
    expect(section(PLAN_CAPTIONS.container)).toHaveTextContent('MP4, from MKV')
    expect(screen.getByLabelText(PLAN_CAPTIONS.kept)).toHaveTextContent('Audio 1')
    expect(screen.getByLabelText(PLAN_CAPTIONS.notKept)).toHaveTextContent('MP4 cannot hold bitmap subtitles.')
    expect(section(PLAN_CAPTIONS.encoder)).toHaveTextContent('Audio 1: AC-3 448 kb/s')
    expect(section(PLAN_CAPTIONS.ceiling)).toHaveTextContent(`Audio 1: ${MINUS}2.0 dBTP for AC-3 at 448 kb/s`)
    expect(section(PLAN_CAPTIONS.ceiling)).not.toHaveTextContent('Audio 2')
    expect(section(PLAN_CAPTIONS.loudness)).toHaveTextContent(PLAN_WORDS.measuredAtRun)
    expect(section(PLAN_CAPTIONS.issues)).toHaveTextContent(PLAN_WORDS.noIssues)
    fireEvent.click(screen.getByRole('button', { name: PLAN_WORDS.measureNow }))
    expect(onMeasureNow).toHaveBeenCalledWith('MM-0001')
  })

  it('discloses the planned command with placeholders until measured, quoted for the shell', () =>
  {
    const view = jobView('MM-0001')
    render(<PlanTab jobs={[view]} detail={{ view, plan: jobPlan({ command: loudCommand }), media: null, measurement: null }} policy={POLICY} platform='linux' />)
    const toggle = screen.getByRole('button', { name: PLAN_WORDS.showCommand })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: PLAN_WORDS.commandLabel })).toBeNull()
    fireEvent.click(toggle)
    const block = screen.getByRole('group', { name: PLAN_WORDS.commandLabel })
    expect(block).toHaveAttribute('data-state', 'planned')
    expect(block.querySelector('pre')).toHaveTextContent("ffmpeg -i 'D:\\Rips\\MM-0001.mkv' -af 'volume={gain-a0}dB' '{output}'")
    expect([...block.querySelectorAll('[data-part="placeholder"]')].map((part) => part.textContent)).toEqual(['{gain-a0}', '{output}'])
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: PLAN_WORDS.hideCommand }))
    expect(screen.queryByRole('group', { name: PLAN_WORDS.commandLabel })).toBeNull()
  })

  it('shows each measured stream with its plan and fills the gain into the command', () =>
  {
    const view = jobView('MM-0001')
    const notes = [{ key: 'meter-swr', params: {} }] as JobMeasurement['messages']
    render(
      <PlanTab
        jobs={[view]}
        detail={{ view, plan: jobPlan({ command: loudCommand }), media: mediaFacts(), measurement: measurement([{ measurement: streamMeasurement(), plan: gainPlan() }], notes) }}
        policy={POLICY}
        platform='win32'
      />
    )
    const loudness = section(PLAN_CAPTIONS.loudness)
    expect(loudness).toHaveTextContent('Audio 1 · English · 5.1(side) · AC-3 448 kb/s')
    expect(loudness).toHaveTextContent(`Measured${MINUS}20.9 LUFS integrated, 15.8 LU range, ${MINUS}7.1 dBTP true peak.`)
    expect(loudness).toHaveTextContent(`PlannedGain +2.9 dB. Predicted true peak ${MINUS}4.2 dBTP, under the ${MINUS}2.0 dBTP ceiling for AC-3.`)
    expect(loudness).toHaveTextContent('True peak measured with the swresample')
    expect(loudness.textContent).not.toMatch(/(^|[\s(])-\d/)
    expect(screen.queryByRole('button', { name: PLAN_WORDS.measureNow })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: PLAN_WORDS.showCommand }))
    const pre = screen.getByRole('group', { name: PLAN_WORDS.commandLabel }).querySelector('pre') as HTMLElement
    expect(pre).toHaveTextContent('ffmpeg -i D:\\Rips\\MM-0001.mkv -af volume=2.9dB {output}')
    expect([...pre.querySelectorAll('[data-part="placeholder"]')].map((part) => part.textContent)).toEqual(['{output}'])
  })

  it('marks Measure now busy while the job is measuring', () =>
  {
    const view = jobView('MM-0001', { analysis: 'running' })
    render(<PlanTab jobs={[view]} detail={{ view, plan: jobPlan(), media: null, measurement: null }} policy={POLICY} onMeasureNow={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Measuring loudness/ })).toBeInTheDocument()
  })

  it('lists the job issues blocking first with fixes and page actions scoped to the job', () =>
  {
    const view = jobView('MM-0001')
    const onFix = vi.fn()
    const onAction = vi.fn()
    const onSelect = vi.fn()
    const fix = { kind: 'set-container', container: 'mkv', scope: 'jobs' } as const
    const issues = [
      issue('streams-dropped', 'info', 'Not kept: 1 subtitle stream that .mp4 cannot hold (hdmv_pgs_subtitle).', fix),
      issue('destination-not-writable', 'error', 'molexMedia cannot write to D:\\Exports: the drive is not available.')
    ]
    render(<PlanTab jobs={[view]} entries={[entry('MM-0001', { status: 'blocked', issues })]} policy={POLICY} onFix={onFix} onAction={onAction} onSelect={onSelect} />)
    const items = section(PLAN_CAPTIONS.issues).querySelectorAll('li')
    expect([...items].map((item) => item.getAttribute('data-severity'))).toEqual(['error', 'info'])
    expect(items[0]).toHaveTextContent('Blocking: molexMedia cannot write to D:\\Exports: the drive is not available.')
    expect(screen.queryByRole('button', { name: PLAN_WORDS.select })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Change output' }))
    expect(onAction).toHaveBeenCalledWith('change-output', ['MM-0001'], issues[1])
    fireEvent.click(screen.getByRole('button', { name: 'Write MKV instead for 1 job' }))
    expect(onFix).toHaveBeenCalledWith(fix, ['MM-0001'], issues[0])
  })

  it('shows issues without buttons when the host offers no handlers, and a missing source without a plan', () =>
  {
    const view = jobView('MM-0001')
    render(<PlanTab jobs={[view]} entries={[entry('MM-0001', { status: 'blocked', plan: null, issues: [issue('source-missing', 'error', 'The file is no longer at D:\\Rips\\x.mkv.', { kind: 'remove', scope: 'jobs' })] })]} policy={POLICY} />)
    expect(section(PLAN_CAPTIONS.issues)).toHaveTextContent('The file is no longer at D:\\Rips\\x.mkv.')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.output })).toBeNull()
  })

  it('names the container change, video encoder, downgrades, and the stream notes of a Convert job', () =>
  {
    const view = jobView('MM-0002', { recipe: { kind: 'convert' } as JobView['recipe'] })
    const plan = jobPlan({
      output: { ...jobPlan().output, container: 'm4a', containerChanged: { from: 'wav', reason: 'AAC cannot be stored in .wav; the output is .m4a.' }, conflict: 'exists', resolution: 'rename', renamedTo: 'D:\\Exports\\film (2).m4a' },
      video: { encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: [], notes: ['NVENC cannot encode lossless; this job uses libx264.'], cpuFallback: null },
      audio: [{ ...jobPlan().audio[0], encoder: 'aac', bitrateKbps: 256, messages: [{ key: 'container-changed', params: { codec: 'aac', ext: 'wav', newExt: 'm4a' } }] }]
    })
    render(<PlanTab jobs={[view]} detail={{ view, plan, media: null, measurement: null }} policy={POLICY} />)
    expect(section(PLAN_CAPTIONS.output)).toHaveTextContent('A file with this name exists; this job writes film (2).m4a.')
    expect(section(PLAN_CAPTIONS.container)).toHaveTextContent('M4A, from MKV')
    expect(section(PLAN_CAPTIONS.container)).toHaveTextContent('AAC cannot be stored in .wav; the output is .m4a.')
    const encoder = section(PLAN_CAPTIONS.encoder)
    expect(encoder).toHaveTextContent('libx264, CPU')
    expect(encoder).toHaveTextContent('NVENC cannot encode lossless; this job uses libx264.')
    expect(encoder).toHaveTextContent('Audio 1: AAC 256 kb/s')
    expect(encoder).toHaveTextContent('AAC cannot be stored in .wav; the output is .m4a.')
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.ceiling })).toBeNull()
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.loudness })).toBeNull()
    expect(screen.queryByRole('button', { name: PLAN_WORDS.showCommand })).toBeNull()
  })

  it('names a GPU encode with its CPU fallback, a replaced original, and a plan without streams', () =>
  {
    const view = jobView('MM-0003', { recipe: { kind: 'compress' } as JobView['recipe'], media: { container: 'mp4' } as JobView['media'] })
    const plan = jobPlan({
      output: { ...jobPlan().output, resolution: 'replace-original' },
      streams: { kept: [], dropped: [], chapters: 'none' },
      audio: [],
      video:
      {
        encoder: 'hevc_nvenc', gpu: 'NVENC', lossless: 'not-requested', passes: 1, filters: [], notes: [],
        cpuFallback: { encoder: 'libx265', gpu: null, lossless: 'not-requested', passes: 1, filters: [], notes: [] }
      }
    })
    render(<PlanTab jobs={[view]} detail={{ view: jobView('MM-0009'), plan: null, media: null, measurement: null }} entries={[entry('MM-0003', { plan })]} policy={POLICY} platform='darwin' />)
    expect(section(PLAN_CAPTIONS.encoder)).toHaveTextContent('hevc_nvenc, GPU (NVENC)')
    expect(section(PLAN_CAPTIONS.encoder)).toHaveTextContent('CPU fallback: libx265, CPU')
    expect(section(PLAN_CAPTIONS.original)).toHaveTextContent('Goes to the Trash after the output verifies.')
    expect(section(PLAN_CAPTIONS.output).querySelectorAll('p')).toHaveLength(1)
    expect(section(PLAN_CAPTIONS.container).querySelector('p')).toHaveTextContent(/^MP4$/)
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.kept })).toBeNull()
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.notKept })).toBeNull()
  })

  it('leaves the Encoder out for a plan with no encode', () =>
  {
    const view = jobView('MM-0004', { recipe: { kind: 'extract' } as JobView['recipe'] })
    render(<PlanTab jobs={[view]} detail={{ view, plan: jobPlan({ audio: [] }), media: null, measurement: null }} policy={POLICY} />)
    expect(screen.queryByRole('region', { name: PLAN_CAPTIONS.encoder })).toBeNull()
  })
})

describe('PlanTab, several jobs', () =>
{
  const jobs = [jobView('MM-0001'), jobView('MM-0002'), jobView('MM-0003'), jobView('MM-0004'), jobView('MM-0005', { probe: 'pending' }), jobView('MM-0006')]

  it('counts the selection by readiness', () =>
  {
    const entries = [
      entry('MM-0001'),
      entry('MM-0002', { issues: [issue('path-long', 'warning', 'The output path is 270 characters; some programs cannot open paths over 260.')] }),
      entry('MM-0003', { status: 'blocked', issues: [issue('not-media', 'error', 'x.ts has no audio or video streams.')] }),
      entry('MM-0004', { status: 'will-skip' })
    ]
    expect(selectionCounts(jobs, entries)).toBe('6 jobs: 1 ready, 1 with warnings, 1 blocked, 1 will skip, 1 probing, 1 not planned yet.')
    expect(selectionCounts(jobs.slice(0, 2), entries)).toBe('2 jobs: 1 ready, 1 with warnings, 0 blocked.')
  })

  it('groups the selection issues by reason, blocking first, with the jobs each applies to', () =>
  {
    const shared = issue('trash-too-small', 'error', 'The Recycle Bin on D: has room for about 12 GB.', { kind: 'set-displaced', displaced: 'keep', scope: 'batch' })
    const groups = issueGroups([
      entry('MM-0001', { issues: [issue('path-long', 'warning', 'long'), shared] }),
      entry('MM-0002', { issues: [shared, shared] }),
      entry('MM-0003', { issues: [issue('path-long', 'warning', 'long')] })
    ])
    expect(groups.map((group) => [group.issue.code, group.jobIds])).toEqual([
      ['trash-too-small', ['MM-0001', 'MM-0002']],
      ['path-long', ['MM-0001', 'MM-0003']]
    ])
  })

  it('words the destination for each output policy', () =>
  {
    const two = [entry('MM-0001'), entry('MM-0002', { plan: jobPlan({ estimate: { outputBytes: 900_000_000, reserveBytes: 0, workSec: null, confidence: 'low' } }) })]
    expect(destinationText(two, POLICY)).toBe('Writes 2 new files to D:\\Exports, about 1.8 GB.')
    expect(destinationText([entry('MM-0001')], policy({ destination: { mode: 'next-to-source' } }))).toBe('Writes 1 new file next to its source, about 900 MB.')
    expect(destinationText(two, policy({ destination: { mode: 'next-to-source' } }))).toBe('Writes 2 new files next to their sources, about 1.8 GB.')
    const unknown = entry('MM-0003', { plan: jobPlan({ estimate: { outputBytes: null, reserveBytes: 0, workSec: null, confidence: 'low' } }) })
    expect(destinationText([...two, unknown], POLICY)).toBe('Writes 3 new files to D:\\Exports, about 1.8 GB; size unknown for 1 job.')
    expect(destinationText([unknown], POLICY)).toBe('Writes 1 new file to D:\\Exports, size unknown.')
    expect(destinationText([entry('MM-0001', { status: 'blocked' })], POLICY)).toBe('Writes no new files.')
    const replacing = (id: string): PlanEntry => entry(id, { plan: jobPlan({ output: { ...jobPlan().output, resolution: 'replace-original' } }) })
    const replace = policy({ destination: { mode: 'replace-originals' } })
    expect(destinationText([replacing('MM-0001'), replacing('MM-0002')], replace)).toBe('Replaces 2 originals in place, about 1.8 GB.')
    expect(destinationText([replacing('MM-0001'), replacing('MM-0002'), entry('MM-0003')], replace))
      .toBe('Replaces 2 originals in place, about 2.7 GB. 1 job writes beside its source.')
    expect(destinationText([replacing('MM-0001'), entry('MM-0002'), entry('MM-0003')], replace))
      .toBe('Replaces 1 original in place, about 2.7 GB. 2 jobs write beside their sources.')
    expect(destinationText([entry('MM-0003')], replace)).toBe('Writes 1 new file next to their sources, about 900 MB.')
  })

  it('states the originals affected and the existing files replaced, renamed, or skipped', () =>
  {
    const at = (id: string, resolution: JobPlan['output']['resolution']): PlanEntry => entry(id, { plan: jobPlan({ output: { ...jobPlan().output, resolution } }) })
    expect(originalsText([entry('MM-0001')], POLICY, 'win32')).toEqual(['Not touched.'])
    expect(originalsText([at('MM-0001', 'replace-original'), at('MM-0002', 'replace-original')], POLICY, 'win32'))
      .toEqual(['2 originals go to the Recycle Bin after their outputs verify.'])
    expect(originalsText([at('MM-0001', 'replace-original')], POLICY, 'darwin')).toEqual(['1 original goes to the Trash after its output verifies.'])
    expect(originalsText([at('MM-0001', 'replace-original'), at('MM-0002', 'replace-original')], policy({ displaced: 'keep' }), 'win32'))
      .toEqual(['2 originals are renamed to name (original).ext and replaced by their outputs.'])
    expect(originalsText([at('MM-0001', 'replace-original')], policy({ displaced: 'keep' }), 'win32'))
      .toEqual(['1 original is renamed to name (original).ext and replaced by its output.'])
    const mixed = [at('MM-0001', 'overwrite'), at('MM-0002', 'overwrite'), at('MM-0003', 'rename'), entry('MM-0004', { status: 'will-skip' })]
    expect(originalsText(mixed, POLICY, 'win32')).toEqual([
      'Not touched.',
      'Existing files: 2 go to the Recycle Bin and are replaced.',
      'Existing files: 1 kept; the new file is numbered (2).',
      'Existing files: 1 skipped; that job will not run.'
    ])
    expect(originalsText([at('MM-0001', 'overwrite'), at('MM-0002', 'rename'), at('MM-0003', 'rename'), entry('MM-0004', { status: 'will-skip' }), entry('MM-0005', { status: 'will-skip' })], policy({ displaced: 'keep' }), 'win32')).toEqual([
      'Not touched.',
      'Existing files: 1 stays as name (previous).ext and is replaced.',
      'Existing files: 2 kept; the new files are numbered (2).',
      'Existing files: 2 skipped; those jobs will not run.'
    ])
    expect(originalsText([at('MM-0001', 'overwrite')], POLICY, 'win32')[1]).toBe('Existing files: 1 goes to the Recycle Bin and is replaced.')
  })

  it('renders counts, issue groups with Select, the destination, and the originals affected', () =>
  {
    const onSelect = vi.fn()
    const onFix = vi.fn()
    const fix = { kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' } as const
    const collision = issue('intra-batch-collision', 'error', 'MM-0001 and MM-0002 would both write film.mp4.', fix)
    const entries = [entry('MM-0001', { status: 'blocked', issues: [collision] }), entry('MM-0002', { status: 'blocked', issues: [collision] }), entry('MM-0003'), entry('MM-0099')]
    const { container } = render(<PlanTab jobs={jobs.slice(0, 3)} entries={entries} policy={POLICY} platform='win32' onSelect={onSelect} onFix={onFix} />)
    expect((container.firstChild as HTMLElement).className).toContain('select-text')
    expect(screen.getByText('3 jobs: 1 ready, 0 with warnings, 2 blocked.')).toBeInTheDocument()
    const issues = section(PLAN_CAPTIONS.issues)
    expect(issues).toHaveTextContent('MM-0001 and MM-0002 would both write film.mp4. · 2 jobs')
    fireEvent.click(screen.getByRole('button', { name: 'Use Rename for this batch' }))
    expect(onFix).toHaveBeenCalledWith(fix, ['MM-0001', 'MM-0002'], collision)
    fireEvent.click(screen.getByRole('button', { name: PLAN_WORDS.select }))
    expect(onSelect).toHaveBeenCalledWith(['MM-0001', 'MM-0002'])
    expect(section(PLAN_CAPTIONS.output)).toHaveTextContent('Writes 1 new file to D:\\Exports, about 900 MB.')
    expect(section(PLAN_CAPTIONS.originals)).toHaveTextContent('Not touched.')
  })

  it('shows three issue groups, then the rest behind "Show more issues"', () =>
  {
    const entries = [entry('MM-0001', { issues: ['a', 'b', 'c', 'd', 'e'].map((message) => issue('path-long', 'warning', message)) }), entry('MM-0002')]
    render(<PlanTab jobs={jobs.slice(0, 2)} entries={entries} policy={POLICY} />)
    expect(section(PLAN_CAPTIONS.issues).querySelectorAll('li')).toHaveLength(3)
    const more = screen.getByRole('button', { name: 'Show 2 more issues' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(section(PLAN_CAPTIONS.issues).querySelectorAll('li')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer issues' }))
    expect(section(PLAN_CAPTIONS.issues).querySelectorAll('li')).toHaveLength(3)
  })
})

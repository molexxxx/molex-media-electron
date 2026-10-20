/**
 * The Convert, Compress, and Extract fields of the Recipe tab: each field draws the field model's state (one value,
 * "Mixed" with the distinct values and their counts, disabled with a reason, an error) and sends one patch per
 * gesture; options a container cannot hold explain themselves in the field's hint; Compress shows one file's size
 * budget; and the rarely changed fields sit behind a remembered "More settings" disclosure.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import
{
  audioStreamLabel,
  clockText,
  compressAudioKbps,
  recipeFields,
  valueKey,
  type FieldOption,
  type FieldState,
  type RecipeContext
} from '../../../src/renderer/src/stores/recipeFields'
import { formatCatalog } from '../../../src/shared/jobs/ids'
import { sizeBudget } from '../../../src/shared/jobs/limits'
import { DEFAULT_PINS } from '../../../src/shared/jobs/presets'
import type { CompressRecipe, ConvertRecipe, ExtractRecipe, Operation, Recipe } from '../../../src/shared/jobs/recipes'
import type { JobView, MediaSummary } from '../../../src/shared/jobs/types'
import { ConvertFields, FieldStack, RecipeField, fieldHint, optionNotes } from '../../../src/renderer/src/components/batch/inspector/fields/ConvertFields'
import { CompressFields } from '../../../src/renderer/src/components/batch/inspector/fields/CompressFields'
import { ExtractFields } from '../../../src/renderer/src/components/batch/inspector/fields/ExtractFields'

beforeEach(() =>
{
  window.localStorage.clear()
})

afterEach(() =>
{
  cleanup()
  vi.useRealTimers()
})

function option<T>(value: T, label: string, over: Partial<FieldOption<T>> = {}): FieldOption<T>
{
  return { key: valueKey(value), value, label, description: null, group: null, disabled: false, reason: null, note: null, ...over }
}

function state(over: Partial<FieldState> & Pick<FieldState, 'key' | 'label' | 'kind'>): FieldState
{
  return {
    value: null,
    mixed: false,
    distinct: [],
    text: '',
    mixedText: null,
    disabled: false,
    reason: null,
    hint: null,
    error: null,
    note: null,
    unit: null,
    range: null,
    options: null,
    nested: null,
    more: false,
    count: 1,
    edited: 0,
    lockedNote: null,
    ...over
  } as FieldState
}

function describedText(element: HTMLElement): string
{
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' | ')
}

const CODECS = state({
  key: 'videoCodec',
  label: 'Video codec',
  kind: 'select',
  value: 'libx264',
  text: 'H.264 (libx264)',
  options: [
    option('copy', 'Copy (no re-encode)'),
    option('libx264', 'H.264 (libx264)'),
    option('libx265', 'HEVC (libx265)'),
    option('libtheora', 'Theora', { disabled: true, reason: 'Theora: not in MP4' })
  ]
})

describe('select fields', () =>
{
  it('shows the shared value and sends one patch with the chosen option value', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={CODECS} onPatch={onPatch} />)
    const select = screen.getByRole('combobox', { name: 'Video codec' }) as HTMLSelectElement
    expect(select.value).toBe(valueKey('libx264'))
    fireEvent.change(select, { target: { value: valueKey('libx265') } })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoCodec', value: 'libx265' })
  })

  it('disables an option a container cannot hold and names the reason in the hint', () =>
  {
    render(<RecipeField field={CODECS} onPatch={vi.fn()} />)
    const theora = screen.getByRole('option', { name: 'Theora' }) as HTMLOptionElement
    expect(theora.disabled).toBe(true)
    const select = screen.getByRole('combobox', { name: 'Video codec' })
    expect(describedText(select)).toContain('Theora: not in MP4.')
    expect(fieldHint(CODECS)).toBe('Theora: not in MP4.')
  })

  it('reads Mixed with the distinct values and counts beneath', () =>
  {
    const onPatch = vi.fn()
    const mixed = { ...CODECS, mixed: true, text: 'Mixed', mixedText: 'H.264 (libx264) (3), HEVC (libx265) (1)' }
    render(<RecipeField field={mixed} onPatch={onPatch} />)
    const select = screen.getByRole('combobox', { name: 'Video codec' }) as HTMLSelectElement
    expect(select.selectedOptions[0].textContent).toBe('Mixed')
    expect(describedText(select)).toContain('H.264 (libx264) (3), HEVC (libx265) (1)')
    fireEvent.change(select, { target: { value: valueKey('libx264') } })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoCodec', value: 'libx264' })
  })

  it('is disabled with its reason and shows its error', () =>
  {
    const field = { ...CODECS, disabled: true, reason: 'Lossless keeps the source pixel format.' }
    const { unmount } = render(<RecipeField field={field} onPatch={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Video codec' }) as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(describedText(select)).toContain('Lossless keeps the source pixel format.')
    unmount()
    render(<RecipeField field={{ ...CODECS, error: 'Enter a value from 0 to 51.' }} onPatch={vi.fn()} />)
    const invalid = screen.getByRole('combobox', { name: 'Video codec' })
    expect(invalid.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Enter a value from 0 to 51.')).toBeTruthy()
  })

  it('sends object values such as a frame size unchanged', () =>
  {
    const onPatch = vi.fn()
    const size = state({
      key: 'size',
      label: 'Size',
      kind: 'select',
      value: null,
      text: 'Original',
      options: [option(null, 'Original'), option({ maxWidth: 1920, maxHeight: 1080 }, '1920 x 1080'), option({ maxWidth: 1280, maxHeight: 720 }, '1280 x 720')]
    })
    render(<RecipeField field={size} onPatch={onPatch} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Size' }), { target: { value: valueKey({ maxWidth: 1280, maxHeight: 720 }) } })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'size', value: { maxWidth: 1280, maxHeight: 720 } })
  })
})

const FIT = state({
  key: 'fit',
  label: 'Fit',
  kind: 'segmented',
  value: 'fit',
  text: 'Fit inside',
  hint: 'Keeps the display aspect and never upscales.',
  options: [option('fit', 'Fit inside'), option('pad', 'Pad to size'), option('crop', 'Crop to fill')]
})

describe('segmented fields', () =>
{
  it('checks the shared value and sends one patch for another segment, none for the checked one', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={FIT} onPatch={onPatch} />)
    const group = screen.getByRole('radiogroup', { name: 'Fit' })
    expect(describedText(group)).toContain('Keeps the display aspect and never upscales.')
    expect(screen.getByRole('radio', { name: 'Fit inside' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Fit inside' }))
    expect(onPatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Crop to fill' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'fit', value: 'crop' })
  })

  it('checks nothing while mixed, says Mixed in the caption, and lists the distinct values', () =>
  {
    const onPatch = vi.fn()
    const mixed = { ...FIT, mixed: true, text: 'Mixed', mixedText: 'Fit inside (2), Pad to size (1)' }
    render(<RecipeField field={mixed} onPatch={onPatch} />)
    const group = screen.getByRole('radiogroup', { name: 'Fit' })
    expect(screen.getAllByRole('radio').every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    const described = describedText(group)
    expect(described).toContain('Mixed')
    expect(described).toContain('Fit inside (2), Pad to size (1)')
    fireEvent.click(screen.getByRole('radio', { name: 'Fit inside' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'fit', value: 'fit' })
  })

  it('disables an option with its reason in the hint and the whole group with the field reason', () =>
  {
    const channels = state({
      key: 'channels',
      label: 'Channels',
      kind: 'segmented',
      value: 'keep',
      text: 'Keep',
      options: [option('keep', 'Keep'), option('stereo', 'Stereo'), option('mono', 'Mono', { disabled: true, reason: 'Fixed by Audiobook' })]
    })
    const { unmount } = render(<RecipeField field={channels} onPatch={vi.fn()} />)
    expect((screen.getByRole('radio', { name: 'Mono' }) as HTMLButtonElement).disabled).toBe(true)
    expect(describedText(screen.getByRole('radiogroup', { name: 'Channels' }))).toContain('Fixed by Audiobook.')
    unmount()
    const onPatch = vi.fn()
    render(<RecipeField field={{ ...channels, disabled: true, reason: 'Frozen when Batch 31 started. To change it, use Edit and retry.' }} onPatch={onPatch} />)
    expect(describedText(screen.getByRole('radiogroup', { name: 'Channels' }))).toContain('Frozen when Batch 31 started.')
    fireEvent.click(screen.getByRole('radio', { name: 'Stereo' }))
    expect(onPatch).not.toHaveBeenCalled()
  })
})

const BITRATE = state({
  key: 'videoBitrate',
  label: 'Video bitrate',
  kind: 'number',
  value: 4000,
  text: '4,000 kb/s',
  unit: 'kb/s',
  range: { min: 100, max: 200000, step: 100 },
  options: [option(null, 'Auto')]
})

describe('number fields', () =>
{
  it('commits a typed value once', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={BITRATE} onPatch={onPatch} />)
    const input = screen.getByRole('spinbutton', { name: 'Video bitrate' }) as HTMLInputElement
    expect(input.value).toBe('4000')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '6500' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoBitrate', value: 6500 })
  })

  it('sends one patch for a run of key steps', () =>
  {
    vi.useFakeTimers()
    const onPatch = vi.fn()
    render(<RecipeField field={BITRATE} onPatch={onPatch} />)
    const input = screen.getByRole('spinbutton', { name: 'Video bitrate' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(onPatch).not.toHaveBeenCalled()
    act(() =>
    {
      vi.advanceTimersByTime(600)
    })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoBitrate', value: 4300 })
  })

  it('offers the empty choice beside the number and sends it once', () =>
  {
    const onPatch = vi.fn()
    const { unmount } = render(<RecipeField field={BITRATE} onPatch={onPatch} />)
    const auto = screen.getByRole('button', { name: 'Auto' })
    expect(auto.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(auto)
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoBitrate', value: null })
    unmount()
    onPatch.mockClear()
    render(<RecipeField field={{ ...BITRATE, value: null, text: 'Auto' }} onPatch={onPatch} />)
    const pressed = screen.getByRole('button', { name: 'Auto' })
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('spinbutton', { name: 'Video bitrate' }) as HTMLInputElement).placeholder).toBe('Auto')
    fireEvent.click(pressed)
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('reads Mixed with the distinct values beneath and commits a typed value to every job', () =>
  {
    const onPatch = vi.fn()
    const mixed = { ...BITRATE, mixed: true, text: 'Mixed', mixedText: '4,000 kb/s (2), Auto (1)' }
    render(<RecipeField field={mixed} onPatch={onPatch} />)
    const input = screen.getByRole('spinbutton', { name: 'Video bitrate' }) as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Mixed')
    expect(input.getAttribute('aria-valuetext')).toBe('Mixed')
    expect(describedText(input)).toContain('4,000 kb/s (2), Auto (1)')
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '3000' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoBitrate', value: 3000 })
  })

  it('names CRF values and shows a value outside the range as an error', () =>
  {
    const crf = state({
      key: 'crf',
      label: 'CRF',
      kind: 'number',
      value: 58,
      text: 'CRF 58',
      range: { min: 0, max: 51, step: 1 },
      hint: '0 to 51 for x264 and x265, 0 to 63 for VP9 and AV1',
      error: 'Enter a value from 0 to 51.'
    })
    render(<RecipeField field={crf} onPatch={vi.fn()} />)
    const input = screen.getByRole('spinbutton', { name: 'CRF' })
    expect(input.getAttribute('aria-valuetext')).toBe('CRF 58')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Enter a value from 0 to 51.')).toBeTruthy()
    expect(describedText(input)).toContain('0 to 51 for x264 and x265, 0 to 63 for VP9 and AV1.')
  })
})

const SUBTITLES = state({ key: 'subtitles', label: 'Keep subtitles', kind: 'checkbox', value: true, text: 'On' })

describe('checkbox fields', () =>
{
  it('shows the shared value and sends one patch per activation', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={SUBTITLES} onPatch={onPatch} />)
    const box = screen.getByRole('checkbox', { name: 'Keep subtitles' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'subtitles', value: false })
  })

  it('is indeterminate while mixed and checks every job when activated', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={{ ...SUBTITLES, mixed: true, text: 'Mixed', mixedText: 'On (2), Off (1)' }} onPatch={onPatch} />)
    const box = screen.getByRole('checkbox', { name: 'Keep subtitles' }) as HTMLInputElement
    expect(box.indeterminate).toBe(true)
    expect(describedText(box)).toContain('On (2), Off (1)')
    fireEvent.click(box)
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'subtitles', value: true })
  })

  it('stays focusable with its reason when unavailable and ignores activation', () =>
  {
    const onPatch = vi.fn()
    const twoPass = state({ key: 'twoPass', label: 'Two-pass', kind: 'checkbox', value: false, text: 'Off', disabled: true, reason: 'Two-pass runs on the CPU only.' })
    render(<RecipeField field={twoPass} onPatch={onPatch} />)
    const box = screen.getByRole('checkbox', { name: 'Two-pass' })
    expect(box.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByText('Two-pass runs on the CPU only.').length).toBeGreaterThan(0)
    fireEvent.click(box)
    expect(onPatch).not.toHaveBeenCalled()
  })
})

const LANGUAGE = state({ key: 'streamLanguage', label: 'Language', kind: 'input', value: 'eng', text: 'English' })

describe('text and read-only fields', () =>
{
  it('commits a language once on Enter and not again on blur', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={LANGUAGE} onPatch={onPatch} />)
    const input = screen.getByRole('textbox', { name: 'Language' }) as HTMLInputElement
    expect(input.value).toBe('eng')
    fireEvent.change(input, { target: { value: ' fr ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'streamLanguage', value: 'fr' })
  })

  it('reverts on Escape, ignores an unchanged or empty entry, and commits on blur', () =>
  {
    const onPatch = vi.fn()
    render(<RecipeField field={LANGUAGE} onPatch={onPatch} />)
    const input = screen.getByRole('textbox', { name: 'Language' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'de' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('eng')
    fireEvent.change(input, { target: { value: 'eng' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.blur(input)
    expect(onPatch).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'ja' } })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'streamLanguage', value: 'ja' })
  })

  it('reads Mixed, shows an error, and sends a typed value to every job', () =>
  {
    const onPatch = vi.fn()
    const mixed = { ...LANGUAGE, mixed: true, text: 'Mixed', mixedText: 'English (2), French (1)', error: 'Enter a language code, such as eng or fr.' }
    render(<RecipeField field={mixed} onPatch={onPatch} />)
    const input = screen.getByRole('textbox', { name: 'Language' }) as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Mixed')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(describedText(input)).toContain('Enter a language code, such as eng or fr.')
    expect(describedText(input)).toContain('English (2), French (1)')
    fireEvent.change(input, { target: { value: 'eng' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledWith({ field: 'streamLanguage', value: 'eng' })
  })

  it('shows a value without a control as text', () =>
  {
    render(<RecipeField field={state({ key: 'container', label: 'Container', kind: 'text', value: 'mkv', text: 'MKV', note: 'Compress keeps the source container.' })} onPatch={vi.fn()} />)
    expect(screen.getByText('MKV')).toBeTruthy()
    expect(screen.getByText('Compress keeps the source container.')).toBeTruthy()
  })

  it('draws the field inside the checked option beneath its parent', () =>
  {
    const onPatch = vi.fn()
    const count = state({ key: 'loopCount', label: 'Plays', kind: 'number', value: 3, text: '3', range: { min: 2, max: 65536, step: 1 } })
    const loop = state({
      key: 'loop',
      label: 'Loop',
      kind: 'select',
      value: 3,
      text: 'Play 3 times',
      options: [option('infinite', 'Forever'), option(1, 'Play once'), option(3, 'Play 3 times')],
      nested: count
    })
    render(<RecipeField field={loop} onPatch={onPatch} />)
    const plays = screen.getByRole('spinbutton', { name: 'Plays' })
    fireEvent.focus(plays)
    fireEvent.change(plays, { target: { value: '5' } })
    fireEvent.keyDown(plays, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'loopCount', value: 5 })
    fireEvent.change(screen.getByRole('combobox', { name: 'Loop' }), { target: { value: valueKey('infinite') } })
    expect(onPatch).toHaveBeenLastCalledWith({ field: 'loop', value: 'infinite' })
  })
})

describe('consequence notes', () =>
{
  const audio = state({
    key: 'audio',
    label: 'Audio codec',
    kind: 'select',
    value: 'aac',
    text: 'AAC',
    options: [
      option('copy', 'Copy (no re-encode)'),
      option('aac', 'AAC'),
      option('mp3', 'MP3', { note: '3 of the selected jobs have 7.1 audio and would be blocked.' }),
      option('opus', 'Opus', { disabled: true, reason: 'Opus: not in MP4', note: 'Never shown.' })
    ]
  })

  it('names what choosing another option would block before anything is applied', () =>
  {
    expect(optionNotes(audio)).toEqual(['MP3: 3 of the selected jobs have 7.1 audio and would be blocked.'])
    render(<RecipeField field={audio} onPatch={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Audio codec' })
    expect(describedText(select)).toContain('MP3: 3 of the selected jobs have 7.1 audio and would be blocked.')
    expect(describedText(select)).toContain('Opus: not in MP4.')
    expect(screen.queryByText(/Never shown/)).toBeNull()
  })

  it('leaves out the current value, notes the current value shares, and a disabled field', () =>
  {
    expect(optionNotes({ ...audio, value: 'mp3' })).toEqual([])
    const shared = 'One job has no audio stream and would be blocked.'
    const same = { ...audio, options: (audio.options ?? []).map((entry) => entry.disabled ? entry : { ...entry, note: shared }) }
    expect(optionNotes(same)).toEqual([])
    expect(optionNotes({ ...audio, disabled: true, reason: 'Queued in Batch 31.' })).toEqual([])
  })
})

type AudioStream = MediaSummary['audio'][number]

let seq = 0

function stream(channels: number, over: Partial<AudioStream> = {}): AudioStream
{
  const layouts: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1(side)' }
  return { codec: 'aac', channels, layout: layouts[channels] ?? null, sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: 'eng', isDefault: false, ...over }
}

function media(over: Partial<MediaSummary> = {}): MediaSummary
{
  return {
    container: 'mp4',
    durationSec: 134,
    video: { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 30 },
    audio: [stream(2, { isDefault: true })],
    subtitles: 0,
    attachments: 0,
    chapters: 0,
    cover: false,
    ...over
  }
}

function job(recipe: Recipe, over: Partial<JobView> = {}): JobView
{
  seq += 1
  return {
    id: formatCatalog(seq),
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `C:/media/clip-${seq}.mp4`, name: `clip-${seq}.mp4`, ext: '.mp4', dir: 'C:/media', size: 1000, mtimeMs: 0, origin: 'files', subdir: '' },
    recipe,
    recipeLabel: '',
    state: 'pending',
    reason: null,
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: media(),
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
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: seq,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  } as JobView
}

function ctx(over: Partial<RecipeContext> = {}): RecipeContext
{
  return { presets: { user: [], pins: { ...DEFAULT_PINS }, recent: [] }, output: { kind: 'same-as-source' }, albumIds: [], ...over }
}

function fieldsOf(jobs: JobView[], op: Operation, context: RecipeContext = ctx()): FieldState[]
{
  return recipeFields(jobs, op, context)
}

const CONVERT: ConvertRecipe =
{
  kind: 'convert',
  presetId: null,
  userPreset: null,
  container: 'mp4',
  video: { encoder: 'libx264', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' },
  audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 160 },
  channels: 'keep',
  subtitles: 'keep'
}

const COMPRESS: CompressRecipe =
{
  kind: 'compress',
  presetId: null,
  userPreset: null,
  target: { mode: 'size', targetBytes: 25_000_000, twoPass: true },
  encoder: 'libx264',
  speed: 'medium',
  pixelFormat: 'source',
  tune: null,
  fit: null,
  audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 96 },
  container: 'source'
}

const EXTRACT_AUDIO: ExtractRecipe =
{
  kind: 'extract',
  presetId: null,
  userPreset: null,
  mode: 'audio',
  stream: { by: 'default' },
  audio: { kind: 'codec', codec: 'opus', kbpsPerPair: 128 },
  container: 'ogg',
  sampleRate: null,
  channels: 'keep',
  range: null
}

function caption(name: string): HTMLElement | null
{
  return screen.queryByText(name, { selector: 'label, span, p, div' })
}

describe('ConvertFields', () =>
{
  it('draws the model fields, the rare ones behind a remembered More settings', () =>
  {
    const onPatch = vi.fn()
    const fields = fieldsOf([job(CONVERT)], 'convert')
    const first = render(<ConvertFields fields={fields} onPatch={onPatch} />)
    expect(screen.getByRole('combobox', { name: 'Container' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Video codec' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Pixel format' })).toBeNull()
    const more = screen.getByRole('button', { name: 'More settings' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(screen.getByRole('combobox', { name: 'Pixel format' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Channels' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fewer settings' }).getAttribute('aria-expanded')).toBe('true')
    first.unmount()

    const second = render(<ConvertFields fields={fields} onPatch={onPatch} />)
    expect(screen.getByRole('combobox', { name: 'Pixel format' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fewer settings' }))
    expect(screen.queryByRole('combobox', { name: 'Pixel format' })).toBeNull()
    second.unmount()

    render(<ConvertFields fields={fields} onPatch={onPatch} />)
    expect(screen.queryByRole('combobox', { name: 'Pixel format' })).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('sends the model value of the chosen option', () =>
  {
    const onPatch = vi.fn()
    render(<ConvertFields fields={fieldsOf([job(CONVERT)], 'convert')} onPatch={onPatch} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Video codec' }), { target: { value: valueKey('libx265') } })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'videoCodec', value: 'libx265' })
  })

  it('shows a rare field with an error outside More settings', () =>
  {
    const fps = state({ key: 'fps', label: 'Frame rate', kind: 'number', value: 500, text: '500 fps', error: 'Enter a value from 1 to 240.' })
    render(<FieldStack fields={[fps]} onPatch={vi.fn()} scope="convert" more={new Set(['fps'])} />)
    expect(screen.getByRole('spinbutton', { name: 'Frame rate' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More settings' })).toBeNull()
  })

  it('still opens and closes when the browser refuses storage', () =>
  {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() =>
    {
      throw new Error('denied')
    })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() =>
    {
      throw new Error('denied')
    })
    try
    {
      const fps = state({ key: 'fps', label: 'Frame rate', kind: 'number', value: 30, text: '30 fps' })
      render(<FieldStack fields={[fps]} onPatch={vi.fn()} scope="convert" more={new Set(['fps'])} />)
      fireEvent.click(screen.getByRole('button', { name: 'More settings' }))
      expect(screen.getByRole('spinbutton', { name: 'Frame rate' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Fewer settings' }))
      expect(screen.queryByRole('spinbutton', { name: 'Frame rate' })).toBeNull()
    }
    finally
    {
      read.mockRestore()
      write.mockRestore()
    }
  })

  it('groups options the model groups', () =>
  {
    const fps = state({
      key: 'fps',
      label: 'Frame rate',
      kind: 'select',
      value: 30,
      text: '30 fps',
      options: [option(null, 'Keep source'), option(24, '24 fps', { group: 'Film' }), option(25, '25 fps', { group: 'Film' }), option(30, '30 fps', { group: 'Video' })]
    })
    render(<RecipeField field={fps} onPatch={vi.fn()} />)
    const groups = [...document.querySelectorAll('optgroup')].map((group) => [group.label, group.querySelectorAll('option').length])
    expect(groups).toEqual([['Film', 2], ['Video', 1]])
  })

  it('keeps a field the model marks as rare behind More settings', () =>
  {
    const allowance = state({ key: 'allowance', label: 'Peak limiting allowance', kind: 'number', value: 1, text: '1.0 dB', more: true })
    render(<FieldStack fields={[allowance]} onPatch={vi.fn()} scope="gain" more={new Set()} />)
    expect(screen.queryByRole('spinbutton', { name: 'Peak limiting allowance' })).toBeNull()
    expect(caption('Peak limiting allowance')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More settings' }))
    expect(screen.getByRole('spinbutton', { name: 'Peak limiting allowance' })).toBeTruthy()
  })
})

describe('CompressFields', () =>
{
  it('states this file\'s budget from the shared size budget for one job', () =>
  {
    const one = job(COMPRESS)
    const onPatch = vi.fn()
    render(<CompressFields fields={fieldsOf([one], 'compress')} onPatch={onPatch} />)
    const size = screen.getByRole('spinbutton', { name: 'Target size' }) as HTMLInputElement
    expect(size.value).toBe('25')
    const budget = sizeBudget(25_000_000, 134, compressAudioKbps(COMPRESS, one.media as MediaSummary))
    expect(budget).not.toBeNull()
    const text = `For this ${clockText(134)} file: video about ${budget?.videoKbps.toLocaleString('en-US')} kb/s, audio ${budget?.audioKbps.toLocaleString('en-US')} kb/s.`
    expect(describedText(size)).toContain(text)
    expect(describedText(size)).toContain('1 MB is 1,000,000 bytes.')
    fireEvent.focus(size)
    fireEvent.change(size, { target: { value: '8' } })
    fireEvent.keyDown(size, { key: 'Enter' })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'targetSize', value: 8 })
  })

  it('says each file\'s bitrate follows its duration for several jobs', () =>
  {
    render(<CompressFields fields={fieldsOf([job(COMPRESS), job(COMPRESS, { media: media({ durationSec: 600 }) })], 'compress')} onPatch={vi.fn()} />)
    expect(describedText(screen.getByRole('spinbutton', { name: 'Target size' }))).toContain('Each file\'s bitrate follows its duration; see Plan.')
  })

  it('switches mode with one patch and keeps audio behind its own More settings', () =>
  {
    const onPatch = vi.fn()
    render(<CompressFields fields={fieldsOf([job(COMPRESS)], 'compress')} onPatch={onPatch} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Quality' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ field: 'compressMode', value: 'quality' })
    expect(screen.getByRole('combobox', { name: 'Encoder' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Audio codec' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More settings' }))
    expect(screen.getByRole('combobox', { name: 'Audio codec' })).toBeTruthy()
    expect(window.localStorage.length).toBe(1)
  })
})

describe('ExtractFields', () =>
{
  it('lists the file\'s real streams for one job and rules for several', () =>
  {
    const streams = [stream(2, { isDefault: true }), stream(6, { codec: 'ac3', bitrateKbps: 640 })]
    const one = job(EXTRACT_AUDIO, { media: media({ audio: streams }) })
    const first = render(<ExtractFields fields={fieldsOf([one], 'extract')} onPatch={vi.fn()} />)
    expect(screen.getByRole('option', { name: audioStreamLabel(streams[1], 1) })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Stream number' })).toBeNull()
    first.unmount()

    render(<ExtractFields fields={fieldsOf([job(EXTRACT_AUDIO), job(EXTRACT_AUDIO)], 'extract')} onPatch={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Stream' }) as HTMLSelectElement
    const labels = [...select.options].map((entry) => entry.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Default stream', 'First stream in a language', 'Stream number']))
  })

  it('shows the trim only in modes that honor it, with the keyframe note for copy', () =>
  {
    const subtitles: ExtractRecipe = { kind: 'extract', presetId: null, userPreset: null, mode: 'subtitles', stream: { by: 'default' }, format: 'srt' }
    const first = render(<ExtractFields fields={fieldsOf([job(subtitles)], 'extract')} onPatch={vi.fn()} />)
    expect(screen.queryByRole('spinbutton', { name: 'Start' })).toBeNull()
    first.unmount()

    const clip: ExtractRecipe = { kind: 'extract', presetId: null, userPreset: null, mode: 'video', container: 'mp4', reencode: null, range: { startSec: 30, durationSec: 10 } }
    render(<ExtractFields fields={fieldsOf([job(clip)], 'extract', ctx({ keyframeIntervalSec: 4.8 }))} onPatch={vi.fn()} />)
    const start = screen.getByRole('spinbutton', { name: 'Start' })
    expect(describedText(start)).toContain('Copy cuts at keyframes; the clip can start up to 4.8 s early. Re-encode for an exact cut.')
    expect(screen.getByRole('spinbutton', { name: 'Duration' })).toBeTruthy()
  })

  it('names why a sample rate cannot be chosen in the hint', () =>
  {
    render(<ExtractFields fields={fieldsOf([job(EXTRACT_AUDIO)], 'extract')} onPatch={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'More settings' }))
    const rate = screen.getByRole('combobox', { name: 'Sample rate' })
    const disabled = [...(rate as HTMLSelectElement).options].filter((entry) => entry.disabled && entry.value !== '')
    expect(disabled.length).toBeGreaterThan(0)
    expect(describedText(rate)).toMatch(/48 kHz/)
  })

  it('draws the GIF play count inside its loop choice', () =>
  {
    const gif: ExtractRecipe = { kind: 'extract', presetId: null, userPreset: null, mode: 'gif', fps: 15, width: 480, dither: 'sierra2_4a', plays: 3, range: null }
    const onPatch = vi.fn()
    render(<ExtractFields fields={fieldsOf([job(gif)], 'extract')} onPatch={onPatch} />)
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More settings' }))
    expect(screen.getByRole('combobox', { name: 'Loop' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Dither' })).toBeTruthy()
  })
})

/**
 * The inspector's recipe field model: aggregation over the editable selected jobs (value, mixed, distinct values
 * with counts, disabled with a reason, error), locked jobs left out, one-field patches, whole-recipe operation and
 * preset assignments, consequence notes through the shared stream rules, and the Normalize and Gain field rules.
 */
import { describe, it, expect } from 'vitest'
import { applyLoudnessPreset, applyGainPreset } from '../../src/shared/audio/presets'
import type { EncoderPolicy } from '../../src/shared/audio/types'
import type { StreamFacts } from '../../src/shared/jobs/applicability'
import { audioCodecLabel, containerLabel } from '../../src/shared/jobs/describe'
import { formatCatalog, formatRunId, type RunId } from '../../src/shared/jobs/ids'
import { COMPRESS_PRESETS, DEFAULT_PINS, applyPreset } from '../../src/shared/jobs/presets'
import type { CompressRecipe, ConvertRecipe, Operation, Recipe } from '../../src/shared/jobs/recipes'
import type { JobView, MediaSummary, UserPreset } from '../../src/shared/jobs/types'
import
{
  applyFieldPatch,
  audioStreamLabel,
  bitmapReason,
  chooseOperation,
  choosePreset,
  clockText,
  compressAudioKbps,
  consequenceNotes,
  distinctText,
  distinctValues,
  editField,
  fieldError,
  fieldKeys,
  footerText,
  formatNumber,
  formatSigned,
  jobLock,
  jobSizeBudget,
  lockReason,
  nextAlbumId,
  operationField,
  operationStart,
  presetChoiceRecipe,
  presetField,
  presetKey,
  rangeError,
  recipeFields,
  resetToPreset,
  splitSelection,
  valueKey,
  type FieldPatch,
  type FieldState,
  type OperationField,
  type PresetField,
  type RecipeContext
} from '../../src/renderer/src/stores/recipeFields'

const MINUS = '\u2212'
const R31: RunId = formatRunId(31)
const SAME: EncoderPolicy = { kind: 'same-as-source' }

let seq = 0

type AudioStream = MediaSummary['audio'][number]

function stream(channels: number, over: Partial<AudioStream> = {}): AudioStream
{
  const layouts: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1(side)', 8: '7.1' }
  return { codec: 'aac', channels, layout: layouts[channels] ?? null, sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: 'eng', isDefault: false, ...over }
}

function media(over: Partial<MediaSummary> = {}): MediaSummary
{
  return {
    container: 'mp4',
    durationSec: 134,
    video: { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 30 },
    audio: [stream(2)],
    subtitles: 0,
    attachments: 0,
    chapters: 0,
    cover: false,
    ...over
  }
}

function audioOnly(channels = 2, over: Partial<MediaSummary> = {}): MediaSummary
{
  return media({ container: 'flac', video: null, audio: [stream(channels, { codec: 'flac', bitrateKbps: null })], ...over })
}

function job(recipe: Recipe, over: Partial<JobView> = {}): JobView
{
  seq += 1
  return {
    id: formatCatalog(seq),
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `C:/media/file-${seq}.mp4`, name: `file-${seq}.mp4`, ext: '.mp4', dir: 'C:/media', size: 1000, mtimeMs: 0, origin: 'files', subdir: '' },
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
    previewed: false,
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

function locked(recipe: Recipe, state: JobView['state'] = 'done', over: Partial<JobView> = {}): JobView
{
  return job(recipe, { state, runId: R31, ...over })
}

function many(count: number, recipe: () => Recipe, over: Partial<JobView> = {}): JobView[]
{
  return Array.from({ length: count }, () => job(recipe(), over))
}

function ctx(over: Partial<RecipeContext> = {}): RecipeContext
{
  return { presets: { user: [], pins: { ...DEFAULT_PINS }, recent: [] }, output: SAME, albumIds: [], ...over }
}

function normalize(id: Parameters<typeof applyLoudnessPreset>[0] = 'streaming-r128s2'): Recipe
{
  return applyLoudnessPreset(id, SAME)
}

function preset(id: string): Recipe
{
  return applyPreset(id, SAME) as Recipe
}

function field(states: FieldState[], key: FieldState['key']): FieldState
{
  const found = states.find((state) => state.key === key)
  if (!found)
  {
    throw new Error(`no field ${key}; have ${states.map((state) => state.key).join(', ')}`)
  }
  return found
}

function edit(recipe: Recipe, patch: FieldPatch, context = ctx()): Recipe
{
  const next = applyFieldPatch(recipe, patch, context)
  if (next === null)
  {
    throw new Error(`patch ${patch.field} did not apply`)
  }
  return next
}

describe('locks and the selection', () =>
{
  it('edits only jobs that are not in a batch', () =>
  {
    expect(jobLock({ state: 'pending' })).toBe('editable')
    expect(jobLock({ state: 'queued' })).toBe('queued')
    expect(jobLock({ state: 'encoding' })).toBe('running')
    expect(jobLock({ state: 'held' })).toBe('running')
    expect(jobLock({ state: 'done' })).toBe('finished')
    expect(jobLock({ state: 'interrupted' })).toBe('finished')
    const a = job(normalize())
    const b = locked(normalize(), 'queued')
    const c = job(normalize())
    expect(splitSelection([a, b, c])).toEqual({ editable: [a, c], locked: [b] })
  })

  it('says why a locked job keeps its settings', () =>
  {
    expect(lockReason({ state: 'pending', runId: null })).toBeNull()
    expect(lockReason({ state: 'done', runId: R31 })).toEqual({ text: 'Frozen when Batch 31 started. To change it, use Edit and retry.', action: null })
    expect(lockReason({ state: 'queued', runId: R31 })).toEqual({ text: 'Queued in Batch 31. Take it out of the batch to edit it.', action: 'Take out of Batch 31' })
    expect(lockReason({ state: 'encoding', runId: R31 })?.text).toBe('Frozen when Batch 31 started.')
    expect(lockReason({ state: 'failed', runId: null })?.text).toBe('Frozen when the batch started. To change it, use Edit and retry.')
  })

  it('words the footer for editable and locked jobs', () =>
  {
    expect(footerText(12, 0)).toBe('Changes apply to 12 selected jobs.')
    expect(footerText(1, 0)).toBe('Changes apply to 1 selected job.')
    expect(footerText(8, 4)).toBe('Changes apply to 8 jobs not in a batch. 4 queued, running, or finished jobs keep their settings.')
    expect(footerText(1, 1)).toBe('Changes apply to 1 job not in a batch. 1 queued, running, or finished job keeps its settings.')
  })
})

describe('values and numbers', () =>
{
  it('keys equal values equally whatever their key order', () =>
  {
    expect(valueKey({ a: 1, b: [1, { c: null }] })).toBe(valueKey({ b: [1, { c: null }], a: 1 }))
    expect(valueKey(undefined)).toBe('undefined')
    expect(valueKey('x')).toBe('"x"')
  })

  it('counts distinct values, most common first', () =>
  {
    const distinct = distinctValues([2, 1, 1, 1, 2, 1, 1, 1, 3], (value) => value.toFixed(1))
    expect(distinct.map((entry) => [entry.value, entry.count])).toEqual([[1, 6], [2, 2], [3, 1]])
    expect(distinctText(distinct)).toBe('1.0 (6), 2.0 (2), 3.0 (1)')
  })

  it('renders negative numbers with U+2212 and signs gains', () =>
  {
    expect(formatNumber(-14, 1)).toBe(`${MINUS}14.0`)
    expect(formatNumber(-0.01, 1)).toBe('0.0')
    expect(formatSigned(1, 1)).toBe('+1.0')
    expect(formatSigned(-2.5, 1)).toBe(`${MINUS}2.5`)
    expect(formatSigned(0, 1)).toBe('0.0')
    expect(formatSigned(0.01, 1)).toBe('0.0')
  })

  it('writes durations as clock times', () =>
  {
    expect(clockText(134)).toBe('2:14')
    expect(clockText(3723)).toBe('1:02:03')
    expect(clockText(0.5)).toBe('0:00.5')
  })

  it('states a range error with the unit', () =>
  {
    expect(rangeError(-3, { min: -60, max: -5, step: 0.5 }, 'LUFS')).toBe(`Enter ${MINUS}60 to ${MINUS}5 LUFS.`)
    expect(rangeError(-20, { min: -60, max: -5, step: 0.5 }, 'LUFS')).toBeNull()
    expect(rangeError(0.5, { min: 1, max: null, step: 1 }, 'MB')).toBe('Enter 1 MB or more.')
    expect(rangeError(Number.NaN, { min: 1, max: 2, step: 1 }, null)).toBe('Enter 1 to 2.')
  })

  it('takes the next free album letter', () =>
  {
    expect(nextAlbumId([])).toBe('A')
    expect(nextAlbumId(['A', 'B'])).toBe('C')
    expect(nextAlbumId(Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)))).toBe('AA')
  })
})

describe('Normalize fields', () =>
{
  it('shows a fixed preset target read-only with its standard', () =>
  {
    const states = recipeFields([job(normalize('ebu-r128')), job(normalize('ebu-r128'))], 'normalize', ctx())
    const target = field(states, 'target')
    expect(target).toMatchObject({ label: 'Target, integrated', kind: 'range', value: -23, mixed: false, text: `${MINUS}23.0 LUFS`, unit: 'LUFS', disabled: true, range: null })
    expect(target.reason).toBe('Fixed by EBU R 128. Choose Custom to set your own.')
    expect(field(states, 'truePeak')).toMatchObject({ disabled: true, text: `${MINUS}1.0 dBTP`, reason: 'Fixed by EBU R 128. Choose Custom to set your own.' })
  })

  it('edits the target inside a preset range and Custom inside the audio limits', () =>
  {
    const streaming = field(recipeFields([job(normalize())], 'normalize', ctx()), 'target')
    expect(streaming).toMatchObject({ disabled: false, reason: null, range: { min: -20, max: -16, step: 0.5 } })
    const custom = recipeFields([job(normalize('custom'))], 'normalize', ctx())
    expect(field(custom, 'target').range).toEqual({ min: -60, max: -5, step: 0.5 })
    expect(field(custom, 'truePeak')).toMatchObject({ disabled: false, range: { min: -9, max: 0, step: 0.1 } })
    const both = field(recipeFields([job(normalize()), job(normalize('night'))], 'normalize', ctx()), 'target')
    expect(both.range).toEqual({ min: -20, max: -16, step: 0.5 })
  })

  it('names every standard that fixes a field and lists the distinct values', () =>
  {
    const jobs = [job(normalize('ebu-r128')), job(normalize('atsc-a85')), job(normalize('ebu-r128')), job(normalize('custom'))]
    const target = field(recipeFields(jobs, 'normalize', ctx()), 'target')
    expect(target.mixed).toBe(true)
    expect(target.text).toBe('Mixed')
    expect(target.value).toBe(-23)
    expect(target.reason).toBe('Fixed by EBU R 128 and ATSC A/85. Choose Custom to set your own.')
    const custom = applyLoudnessPreset('custom', SAME).target.integratedLufs
    expect(target.mixedText).toBe(`${MINUS}23.0 LUFS (2), ${MINUS}24.0 LKFS (1), ${formatNumber(custom, 1)} LUFS (1)`)
  })

  it('reports a value outside the range as the field error', () =>
  {
    const recipe = normalize('custom') as Extract<Recipe, { kind: 'normalize' }>
    const out = { ...recipe, target: { ...recipe.target, integratedLufs: -70 } }
    expect(field(recipeFields([job(out)], 'normalize', ctx()), 'target').error).toBe(`Enter ${MINUS}60 to ${MINUS}5 LUFS.`)
    expect(fieldError(out, { field: 'target', value: -20 })).toBeNull()
    expect(fieldError(out, { field: 'target', value: -4 })).toBe(`Enter ${MINUS}60 to ${MINUS}5 LUFS.`)
    expect(fieldError(out, { field: 'gain', value: 1 })).toBeNull()
  })

  it('fixes mono for every preset but Custom, with the shared hints', () =>
  {
    const ebu = field(recipeFields([job(normalize('ebu-r128'))], 'normalize', ctx()), 'mono')
    expect(ebu).toMatchObject({ kind: 'segmented', value: 'one-channel', text: 'One channel', disabled: true, reason: 'Fixed by EBU R 128. Choose Custom to set your own.' })
    const custom = field(recipeFields([job(normalize('custom'))], 'normalize', ctx()), 'mono')
    expect(custom.disabled).toBe(false)
    expect(custom.options?.map((option) => [option.label, option.description])).toEqual([
      ['One channel', 'Measures a mono file as one channel, as ITU-R BS.1770-5 does. Players reproduce it 3 dB lower on each of two speakers.'],
      ['Two speakers', 'Measures a mono file as if played at full level on both speakers, 3 dB louder. An app convention, not a standard.']
    ])
    const apple = field(recipeFields([job(normalize('apple-podcasts'))], 'normalize', ctx()), 'mono')
    expect(apple).toMatchObject({ kind: 'text', value: 'duplicate', text: 'Duplicated into two identical channels (Apple Podcasts)', disabled: true })
    expect(applyFieldPatch(normalize('custom'), { field: 'mono', value: 'duplicate' }, ctx())).toEqual(normalize('custom'))
    expect(applyFieldPatch(normalize('ebu-r128'), { field: 'mono', value: 'two-speakers' }, ctx())).toBeNull()
  })

  it('carries the limiting allowance inside the peak-limit policy', () =>
  {
    const limit = field(recipeFields([job(normalize('spotify'))], 'normalize', ctx()), 'policy')
    expect(limit).toMatchObject({ kind: 'radio', value: 'peak-limit', text: 'Allow peak limiting up to 1.0 dB' })
    expect(limit.options?.map((option) => option.label)).toEqual(['Stop at the reachable level', 'Allow peak limiting up to 1.0 dB', 'Reduce dynamics first (not a standard)'])
    expect(limit.options?.[0].description).toBe('Applies only the gain the peaks allow, without limiting. The result is quieter than the target, and Review and the stamp say by how much.')
    expect(limit.nested).toMatchObject({ key: 'allowance', value: 1, disabled: false, range: { min: 0, max: 3, step: 0.5 }, unit: 'dB' })
    const stop = field(recipeFields([job(normalize('ebu-r128'))], 'normalize', ctx()), 'policy')
    expect(stop.nested).toMatchObject({ key: 'allowance', disabled: true, reason: null })
    const mixed = field(recipeFields([job(normalize('ebu-r128')), job(normalize('spotify'))], 'normalize', ctx()), 'policy')
    expect(mixed.mixed).toBe(true)
    expect(mixed.nested?.disabled).toBe(true)
    expect(fieldKeys('normalize')).not.toContain('allowance')
    expect(edit(normalize('spotify'), { field: 'allowance', value: 2 })).toMatchObject({ policy: 'peak-limit', maxLimitingDb: 2 })
  })

  it('sets the compressor with the reduce-dynamics policy and drops it after', () =>
  {
    const custom = normalize('custom')
    const reduced = edit(custom, { field: 'policy', value: 'reduce-dynamics' })
    expect(reduced).toMatchObject({ policy: 'reduce-dynamics', dynamics: { ratio: 3 } })
    expect(edit(reduced, { field: 'policy', value: 'stop-at-reachable' })).toMatchObject({ policy: 'stop-at-reachable', dynamics: null })
    const night = normalize('night') as Extract<Recipe, { kind: 'normalize' }>
    expect(edit(night, { field: 'policy', value: 'peak-limit' })).toMatchObject({ policy: 'peak-limit', dynamics: night.dynamics })
    expect(edit(night, { field: 'policy', value: 'reduce-dynamics' })).toEqual(night)
  })

  it('offers the short-form limit where the preset has the rule', () =>
  {
    const ebu = field(recipeFields([job(normalize('ebu-r128'))], 'normalize', ctx()), 'shortForm')
    expect(ebu).toMatchObject({ kind: 'segmented', value: 'auto', text: 'Automatic' })
    expect(ebu.options?.map((option) => option.label)).toEqual(['Automatic', 'Always', 'Never'])
    expect(ebu.hint).toBe('Automatic applies to files of 120 s or less: maximum short-term loudness at most the target plus 5 LU.')
    const aes = field(recipeFields([job(normalize('aes-streaming'))], 'normalize', ctx()), 'shortForm')
    expect(aes.hint).toBe('Automatic applies to files of 60 s or less: maximum short-term loudness at most the target plus 5 LU.')
    expect(field(recipeFields([job(normalize('custom'))], 'normalize', ctx()), 'shortForm').text).toBe('Never')
    const both = field(recipeFields([job(normalize('aes-streaming')), job(normalize('ebu-r128'))], 'normalize', ctx()), 'shortForm')
    expect(both.hint).toBe('Automatic applies to files of 60 s or 120 s or less: maximum short-term loudness at most the target plus 5 LU.')
    expect(recipeFields([job(normalize('spotify'))], 'normalize', ctx()).map((state) => state.key)).not.toContain('shortForm')
    expect(edit(normalize('ebu-r128'), { field: 'shortForm', value: 'on' })).toMatchObject({ shortForm: { mode: 'on', rule: { autoMaxDurationSec: 120 } } })
  })

  it('offers the album checkbox for album presets and two or more jobs', () =>
  {
    const two = recipeFields([job(normalize()), job(normalize())], 'normalize', ctx())
    expect(field(two, 'album')).toMatchObject({ label: 'Normalize the 2 selected jobs as an album', kind: 'checkbox', value: false })
    expect(recipeFields([job(normalize())], 'normalize', ctx()).map((state) => state.key)).not.toContain('album')
    expect(recipeFields([job(normalize('ebu-r128')), job(normalize('ebu-r128'))], 'normalize', ctx()).map((state) => state.key)).not.toContain('album')
    expect(edit(normalize(), { field: 'album', value: true }, ctx({ albumIds: ['A'] }))).toMatchObject({ albumGroupId: 'B' })
    const grouped = { ...normalize(), albumGroupId: 'A' } as Recipe
    expect(edit(grouped, { field: 'album', value: false })).toMatchObject({ albumGroupId: null })
    expect(field(recipeFields([job(grouped), job(grouped)], 'normalize', ctx()), 'album')).toMatchObject({ value: true, text: 'Album', edited: 0 })
  })

  it('keeps the cinematic checkbox behind More settings', () =>
  {
    const film = field(recipeFields([job(normalize('film-r128s4'))], 'normalize', ctx()), 'cinematic')
    expect(film).toMatchObject({ more: true, value: true, text: 'On' })
    expect(film.hint).toBe('Reports a center-channel loudness estimate and the loudness-to-dialogue ratio for sources with a center channel. Changes no processing.')
    expect(field(recipeFields([job(normalize())], 'normalize', ctx()), 'cinematic').text).toBe('Off')
    expect(edit(normalize(), { field: 'cinematic', value: true })).toMatchObject({ cinematic: true })
  })

  it('lists the downmix choices with the standard hint', () =>
  {
    const downmix = field(recipeFields([job(normalize())], 'normalize', ctx()), 'downmix')
    expect(downmix.options?.map((option) => option.label)).toEqual(['Keep layout', 'Stereo', 'Stereo, dialog emphasis (not a standard)'])
    expect(downmix.options?.[1].description).toBe('Uses the stream\'s own downmix levels when it carries them, else ITU-R BS.775-4; the plan names which.')
    expect(edit(normalize(), { field: 'downmix', value: 'dialog' })).toMatchObject({ downmix: 'dialog' })
    expect(edit({ ...normalize(), downmix: 'standard' } as Recipe, { field: 'downmix', value: 'keep' })).toMatchObject({ downmix: null })
  })

  it('offers the output codecs and a bitrate for lossy ones', () =>
  {
    const states = recipeFields([job(normalize())], 'normalize', ctx())
    expect(field(states, 'output').options?.map((option) => option.label)).toEqual(
      ['Same as source (recommended)', 'AAC', 'MP3', 'Opus', 'Vorbis', 'FLAC', 'ALAC', 'AC-3', 'E-AC-3', 'PCM'])
    expect(states.map((state) => state.key)).not.toContain('bitrate')
    const aac = edit(normalize(), { field: 'output', value: 'aac' })
    expect(aac).toMatchObject({ output: { kind: 'codec', codec: 'aac', kbpsPerPair: 192 } })
    const bitrate = field(recipeFields([job(aac)], 'normalize', ctx()), 'bitrate')
    expect(bitrate).toMatchObject({ value: 192, text: '192 kb/s', unit: 'kb/s' })
    expect(bitrate.options?.map((option) => option.value)).toEqual([128, 160, 192, 224, 256, 320])
    const mp3 = edit(edit(aac, { field: 'bitrate', value: 256 }), { field: 'output', value: 'mp3' })
    expect(mp3).toMatchObject({ output: { codec: 'mp3', kbpsPerPair: 256 } })
    const ac3 = edit(mp3, { field: 'output', value: 'ac3' })
    expect(ac3).toMatchObject({ output: { codec: 'ac3', kbpsPerPair: 448 / 3 } })
    const surround = field(recipeFields([job(ac3)], 'normalize', ctx()), 'bitrate')
    expect(surround.text).toBe('448 kb/s at 5.1')
    expect(surround.options?.map((option) => option.label)).toEqual(['384 kb/s at 5.1', '448 kb/s at 5.1', '640 kb/s at 5.1'])
    expect(edit(ac3, { field: 'output', value: 'eac3' })).toMatchObject({ output: { codec: 'eac3', kbpsPerPair: 448 / 3 } })
    expect(edit(ac3, { field: 'output', value: 'flac' })).toMatchObject({ output: { codec: 'flac', kbpsPerPair: null } })
    expect(edit(ac3, { field: 'output', value: 'same-as-source' })).toMatchObject({ output: { kind: 'same-as-source' } })
    const odd = field(recipeFields([job(edit(aac, { field: 'bitrate', value: 100 }))], 'normalize', ctx()), 'bitrate')
    expect(odd.options?.map((option) => option.value)).toEqual([100, 128, 160, 192, 224, 256, 320])
  })

  it('says before commit which jobs a codec would block', () =>
  {
    const surround = media({ audio: [stream(6)] })
    const jobs = [job(normalize(), { media: surround }), job(normalize(), { media: surround }), job(normalize(), { media: surround }), job(normalize())]
    const output = field(recipeFields(jobs, 'normalize', ctx()), 'output')
    expect(output.options?.find((option) => option.value === 'mp3')?.note).toBe('MP3 holds at most 2 channels. 3 of the selected jobs have 5.1 audio and would be blocked.')
    expect(output.options?.find((option) => option.value === 'aac')?.note).toBeNull()
    const downmixed = jobs.map((entry) => ({ ...entry, recipe: { ...entry.recipe, downmix: 'standard' } as Recipe }))
    expect(field(recipeFields(downmixed, 'normalize', ctx()), 'output').options?.find((option) => option.value === 'mp3')?.note).toBeNull()
  })

  it('aggregates editable jobs only, so an edit never reads Mixed because of a locked job', () =>
  {
    const keep = edit(normalize(), { field: 'target', value: -16 })
    const jobs = [job(normalize()), job(normalize()), locked(keep, 'done'), job(normalize())]
    const before = field(recipeFields(jobs, 'normalize', ctx()), 'target')
    expect(before).toMatchObject({ mixed: false, value: -18, count: 3, lockedNote: `1 locked job keeps ${MINUS}16.0 LUFS.` })
    const after = jobs.map((entry) => entry.state === 'pending' ? { ...entry, recipe: edit(entry.recipe, { field: 'target', value: -17 }) } : entry)
    const target = field(recipeFields(after, 'normalize', ctx()), 'target')
    expect(target).toMatchObject({ mixed: false, value: -17, text: `${MINUS}17.0 LUFS`, edited: 3, lockedNote: `1 locked job keeps ${MINUS}16.0 LUFS.` })
    const many = [...after, locked(keep, 'queued'), locked(normalize('night'), 'encoding')]
    expect(field(recipeFields(many, 'normalize', ctx()), 'target').lockedNote).toBe(`3 locked jobs keep ${MINUS}16.0 LUFS (2), ${MINUS}18.0 LUFS (1).`)
  })

  it('shows locked jobs read-only with the reason when nothing is editable', () =>
  {
    const finished = field(recipeFields([locked(normalize(), 'done')], 'normalize', ctx()), 'target')
    expect(finished).toMatchObject({ disabled: true, reason: 'Frozen when Batch 31 started. To change it, use Edit and retry.', lockedNote: null })
    const queued = field(recipeFields([locked(normalize(), 'queued'), locked(normalize(), 'queued')], 'normalize', ctx()), 'policy')
    expect(queued.reason).toBe('Queued in Batch 31. Take it out of the batch to edit it.')
    expect(queued.options?.every((option) => option.note === null)).toBe(true)
    const both = field(recipeFields([locked(normalize(), 'queued'), locked(normalize(), 'done')], 'normalize', ctx()), 'target')
    expect(both.reason).toBe('2 queued, running, or finished jobs keep their settings.')
  })
})

describe('Gain fields', () =>
{
  const lift = applyGainPreset('gentle-lift', SAME)

  it('reads gain in signed dB with the Gain ranges', () =>
  {
    const states = recipeFields([job(lift), job(applyGainPreset('tone-down', SAME))], 'boost', ctx())
    expect(states.map((state) => state.key)).toEqual(['gain', 'highpass', 'truePeak', 'allowance', 'mono', 'output'])
    const gain = field(states, 'gain')
    expect(gain).toMatchObject({ kind: 'range', mixed: true, range: { min: -20, max: 12, step: 0.5 }, unit: 'dB' })
    expect(gain.mixedText).toBe(`+1.0 dB (1), ${MINUS}2.5 dB (1)`)
    expect(field(states, 'highpass').options?.map((option) => option.label)).toEqual(['Off', '20 Hz', '60 Hz', '80 Hz', '100 Hz'])
    expect(field(states, 'truePeak')).toMatchObject({ text: `${MINUS}1.0 dBTP`, range: { min: -9, max: -1, step: 0.1 }, disabled: false })
    expect(field(states, 'allowance')).toMatchObject({ text: '3.0 dB', range: { min: 0, max: 6, step: 0.5 } })
    expect(field(states, 'mono')).toMatchObject({ disabled: false, text: 'Two speakers' })
  })

  it('edits each Gain field alone', () =>
  {
    expect(edit(lift, { field: 'gain', value: 4.5 })).toEqual({ ...lift, gainDb: 4.5 })
    expect(edit(lift, { field: 'highpass', value: 80 })).toEqual({ ...lift, highpassHz: 80 })
    expect(edit(lift, { field: 'truePeak', value: -2 })).toEqual({ ...lift, maxTruePeakDbtp: -2 })
    expect(edit(lift, { field: 'allowance', value: 1 })).toEqual({ ...lift, maxLimitingDb: 1 })
    expect(edit(lift, { field: 'mono', value: 'one-channel' })).toEqual({ ...lift, mono: 'one-channel' })
    expect(edit(lift, { field: 'mono', value: 'duplicate' })).toEqual(lift)
    expect(applyFieldPatch(lift, { field: 'target', value: -14 }, ctx())).toBeNull()
  })

  it('notes that the ceiling varies when outputs differ', () =>
  {
    const mp3 = edit(lift, { field: 'output', value: 'mp3' })
    expect(field(recipeFields([job(lift), job(mp3)], 'boost', ctx()), 'truePeak').note).toBe('Varies with the output codec. See Output for each job.')
    expect(field(recipeFields([job(mp3), job(mp3)], 'boost', ctx()), 'truePeak').note).toBeNull()
    const sources = [job(lift), job(lift, { media: media({ audio: [stream(2, { codec: 'ac3' })] }) })]
    expect(field(recipeFields(sources, 'boost', ctx()), 'truePeak').note).toBe('Varies with the output codec. See Output for each job.')
    expect(field(recipeFields([job(lift)], 'boost', ctx()), 'truePeak').note).toBeNull()
  })
})

describe('every operation', () =>
{
  const cases: Array<[Operation, () => Recipe, FieldPatch]> = [
    ['normalize', () => normalize(), { field: 'target', value: -17 }],
    ['boost', () => applyGainPreset('gentle-lift', SAME), { field: 'gain', value: 4 }],
    ['convert', () => preset('mp4-h264'), { field: 'videoBitrate', value: 8000 }],
    ['compress', () => preset('web-1080p'), { field: 'crf', value: 30 }],
    ['extract', () => preset('gif-720'), { field: 'gifFps', value: 24 }]
  ]

  it.each(cases)('aggregates %s fields over the editable jobs only', (op, recipe, patch) =>
  {
    const edited = edit(recipe(), patch)
    const jobs = [job(recipe()), job(recipe()), locked(edited, 'done')]
    const before = field(recipeFields(jobs, op, ctx()), patch.field)
    expect(before).toMatchObject({ mixed: false, mixedText: null, count: 2, distinct: [{ count: 2 }], disabled: false, reason: null, error: null, edited: 0 })
    expect(before.lockedNote).toMatch(/^1 locked job keeps .+\.$/)
    const result = editField(jobs, patch, ctx())
    expect(result.assignments.map((entry) => entry.jobId)).toEqual([jobs[0].id, jobs[1].id])
    expect(result.locked).toEqual([jobs[2].id])
    const after = jobs.map((entry) => ({ ...entry, recipe: result.assignments.find((assigned) => assigned.jobId === entry.id)?.recipe ?? entry.recipe }))
    expect(field(recipeFields(after, op, ctx()), patch.field)).toMatchObject({ mixed: false, value: patch.value, count: 2, edited: 2, lockedNote: null })
    const frozen = field(recipeFields([locked(recipe(), 'queued')], op, ctx()), patch.field)
    expect(frozen).toMatchObject({ disabled: true, reason: 'Queued in Batch 31. Take it out of the batch to edit it.' })
    const both = field(recipeFields([job(recipe()), job(edited)], op, ctx()), patch.field)
    expect(both).toMatchObject({ mixed: true, text: 'Mixed', edited: 1 })
    expect(both.distinct.map((entry) => entry.count)).toEqual([1, 1])
  })
})

describe('field edits over the selection', () =>
{
  it('sets one field on every editable job and keeps every other field', () =>
  {
    const custom = normalize('custom') as Extract<Recipe, { kind: 'normalize' }>
    const loud = { ...custom, target: { ...custom.target, integratedLufs: -10 } }
    const a = job(custom)
    const b = job(loud)
    const fixed = job(normalize('ebu-r128'))
    const frozen = locked(custom, 'done')
    const result = editField([a, b, fixed, frozen], { field: 'truePeak', value: -2 }, ctx())
    expect(result.assignments.map((entry) => entry.jobId)).toEqual([a.id, b.id])
    expect(result.assignments[0].recipe).toEqual({ ...custom, target: { ...custom.target, maxTruePeakDbtp: -2 } })
    expect(result.assignments[1].recipe).toEqual({ ...loud, target: { ...loud.target, maxTruePeakDbtp: -2 } })
    expect(result).toMatchObject({ unchanged: [fixed.id], invalid: [], locked: [frozen.id], notes: [] })
  })

  it('leaves jobs the value does not fit and jobs it does not change', () =>
  {
    const streaming = job(normalize())
    const custom = job(normalize('custom'))
    const result = editField([streaming, custom], { field: 'target', value: -30 }, ctx())
    expect(result.invalid).toEqual([streaming.id])
    expect(result.assignments.map((entry) => entry.jobId)).toEqual([custom.id])
    const same = editField([streaming], { field: 'target', value: -18 }, ctx())
    expect(same).toMatchObject({ assignments: [], unchanged: [streaming.id] })
    const other = editField([streaming, job(preset('web-1080p'))], { field: 'gain', value: 2 }, ctx())
    expect(other.assignments).toEqual([])
    expect(other.unchanged).toHaveLength(2)
  })

  it('gives every job of an album edit the same new letter', () =>
  {
    const jobs = [job(normalize()), job(normalize()), job(normalize())]
    const result = editField(jobs, { field: 'album', value: true }, ctx({ albumIds: ['A', 'B'] }))
    expect(result.assignments.map((entry) => (entry.recipe as { albumGroupId: string | null }).albumGroupId)).toEqual(['C', 'C', 'C'])
  })

  it('states what the new recipes would block', () =>
  {
    const surround = media({ audio: [stream(6)] })
    const jobs = [job(normalize(), { media: surround }), job(normalize(), { media: surround }), job(normalize())]
    const result = editField(jobs, { field: 'output', value: 'mp3' }, ctx())
    expect(result.assignments).toHaveLength(3)
    expect(result.notes).toEqual([{ code: 'too-many-channels', severity: 'error', count: 2, text: 'MP3 holds at most 2 channels. 2 of the selected jobs have 5.1 audio and would be blocked.' }])
  })
})

describe('operation choice', () =>
{
  it('reads a mixed selection with counts and narrowing choices', () =>
  {
    const jobs = [...many(8, () => normalize()), ...many(4, () => preset('web-1080p')), locked(preset('mp4-h264'), 'done')]
    const op = operationField(jobs, ctx()) as OperationField
    expect(op).toMatchObject({ label: 'Operation', mixed: true, value: 'normalize', text: 'Mixed: 8 Normalize, 4 Compress', count: 12, disabled: false, reason: null })
    expect(op.prompt).toBe('These jobs use different operations. Choose one operation for all 12, or narrow the selection:')
    expect(op.selectOnly.map((entry) => entry.label)).toEqual(['Select only Normalize (8)', 'Select only Compress (4)'])
    expect(op.selectOnly[1]).toMatchObject({ op: 'compress', count: 4, jobIds: jobs.slice(8, 12).map((entry) => entry.id) })
    expect(op.options.map((option) => option.label)).toEqual(['Convert', 'Normalize', 'Gain', 'Compress', 'Extract'])
  })

  it('says before commit how many jobs an operation would block', () =>
  {
    const jobs = [...many(30, () => normalize()), ...many(8, () => normalize(), { media: audioOnly() })]
    const op = operationField(jobs, ctx()) as OperationField
    expect(op).toMatchObject({ mixed: false, text: 'Normalize', prompt: null, selectOnly: [] })
    expect(op.options.find((option) => option.value === 'compress')?.note).toBe('8 of 38 have no video stream; Compress needs one, so they would be blocked.')
    expect(op.options.find((option) => option.value === 'convert')?.note).toBe('8 of 38 have no video stream; their outputs will be audio only.')
    expect(op.options.find((option) => option.value === 'normalize')?.note).toBeNull()
  })

  it('gives every editable job the starting recipe of the operation as a whole recipe', () =>
  {
    const edited = edit(normalize(), { field: 'target', value: -16 })
    const a = job(edited)
    const b = job(preset('web-1080p'), { media: audioOnly() })
    const frozen = locked(preset('mp4-h264'), 'encoding')
    const result = chooseOperation([a, b, frozen], 'normalize', ctx())
    expect(result.assignments.map((entry) => entry.jobId)).toEqual([a.id, b.id])
    expect(result.assignments.every((entry) => valueKey(entry.recipe) === valueKey(normalize()))).toBe(true)
    expect(result).toMatchObject({ unchanged: [], invalid: [], locked: [frozen.id], notes: [] })
    expect(chooseOperation([job(normalize())], 'normalize', ctx()).unchanged).toHaveLength(1)
    const compress = chooseOperation([a, b], 'compress', ctx())
    expect(compress.assignments[0].recipe).toEqual(preset('web-1080p'))
    expect(compress.notes).toEqual([{ code: 'no-video-stream', severity: 'error', count: 1, text: '1 of 2 has no video stream; Compress needs one, so it would be blocked.' }])
  })

  it('starts Normalize from its standard preset, with no global loudness settings', () =>
  {
    const result = chooseOperation([job(preset('web-1080p'))], 'normalize', ctx())
    expect(result.assignments[0].recipe).toEqual(normalize('streaming-r128s2'))
    expect(operationStart('normalize', ctx())).toEqual(normalize('streaming-r128s2'))
    expect(operationStart('boost', ctx())).toEqual(applyGainPreset('gentle-lift', SAME))
  })

  it('is read-only for a locked selection and absent for an empty one', () =>
  {
    expect(operationField([], ctx())).toBeNull()
    const op = operationField([locked(normalize(), 'queued')], ctx()) as OperationField
    expect(op).toMatchObject({ disabled: true, reason: 'Queued in Batch 31. Take it out of the batch to edit it.', count: 1 })
    expect(op.options.every((option) => option.note === null)).toBe(true)
  })
})

describe('preset choice', () =>
{
  const AAC: EncoderPolicy = { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }

  function userPreset(id: string, name: string, recipe: Recipe): UserPreset
  {
    return { id, name, recipe: { ...recipe, userPreset: null } as Recipe, createdAt: 0, updatedAt: 0 }
  }

  it('groups the Normalize presets with pins, recent recipes, and the user presets', () =>
  {
    const edited = edit(normalize(), { field: 'target', value: -16 })
    const voice = userPreset('user-voice', 'Voice', normalize('custom'))
    const context = ctx({ presets: { user: [voice], pins: { ...DEFAULT_PINS }, recent: [edited, preset('web-1080p'), normalize('ebu-r128')] } })
    const state = presetField([job(normalize())], 'normalize', context) as PresetField
    expect(state).toMatchObject({ label: 'Preset', value: 'streaming-r128s2', mixed: false, text: 'Streaming (EBU R 128 s2)', edited: 0, reset: null, disabled: false, count: 1 })
    expect([...new Set(state.options.map((option) => option.group))]).toEqual(['Pinned', 'Recently used', 'Standards', 'Not a standard', 'Custom', 'Your presets'])
    expect(state.options.filter((option) => option.group === 'Pinned').map((option) => [option.label, option.description, option.value])).toEqual([
      [`EBU R 128 (${MINUS}23 LUFS)`, 'Alt+1', 'ebu-r128'],
      [`Podcast (Apple Podcasts), ${MINUS}16 LKFS`, 'Alt+2', 'apple-podcasts'],
      [`Music streaming (Spotify reference), ${MINUS}14 LUFS`, 'Alt+3', 'spotify']
    ])
    expect(state.options.filter((option) => option.group === 'Recently used').map((option) => [option.key, option.label]))
      .toEqual([['recent:0', 'Streaming (EBU R 128 s2), edited'], ['recent:2', 'EBU R 128']])
    expect(state.options.find((option) => option.key === 'streaming-r128s2')).toMatchObject({ label: `Streaming (EBU R 128 s2), ${MINUS}18 LUFS`, group: 'Standards', note: null })
    expect(state.options.find((option) => option.key === 'night')?.group).toBe('Not a standard')
    expect(state.options.find((option) => option.key === 'custom')).toMatchObject({ label: 'Custom', group: 'Custom', disabled: false })
    expect(state.options.find((option) => option.group === 'Your presets')).toMatchObject({ key: 'user-voice', value: 'user-voice', label: 'Voice' })
    expect(new Set(state.options.map((option) => option.key)).size).toBe(state.options.length)
  })

  it('labels Gain presets with their values and media presets with their descriptions', () =>
  {
    const gain = presetField([job(applyGainPreset('gentle-lift', SAME))], 'boost', ctx()) as PresetField
    expect(gain.options.filter((option) => option.group === 'App presets').map((option) => option.label)).toEqual([
      'Gentle lift +1.0 dB', 'Quiet recording +3.5 dB, 60 Hz high-pass', 'Voice clarity +2.5 dB, 80 Hz high-pass',
      'Phone audio +5.0 dB, 100 Hz high-pass', 'Louder +6.0 dB', `Tone down ${MINUS}2.5 dB`
    ])
    expect(gain.options[0]).toMatchObject({ group: 'Pinned', description: 'Alt+4' })
    const web = COMPRESS_PRESETS.find((entry) => entry.id === 'web-1080p')
    const compress = presetField([job(preset('web-1080p'))], 'compress', ctx()) as PresetField
    expect(compress.text).toBe(web?.label)
    expect(compress.options.find((option) => option.key === 'web-1080p')?.description).toBe(web?.description)
    expect(compress.options.find((option) => option.group === 'Pinned')).toMatchObject({ value: 'web-1080p', description: 'Alt+6' })
    expect(compress.options.some((option) => option.key === 'custom')).toBe(false)
  })

  it('reads a mixed or edited selection and offers the reset', () =>
  {
    const edited = edit(normalize(), { field: 'target', value: -16 })
    const mixed = presetField([job(normalize()), job(edited), job(normalize('ebu-r128')), locked(normalize('night'))], 'normalize', ctx()) as PresetField
    expect(mixed).toMatchObject({ mixed: true, value: 'streaming-r128s2', text: 'Mixed: 2 presets', edited: 1, reset: null, count: 3 })
    expect(distinctText(mixed.distinct)).toBe('Streaming (EBU R 128 s2) (2), EBU R 128 (1)')
    const one = presetField([job(normalize()), job(edited)], 'normalize', ctx()) as PresetField
    expect(one).toMatchObject({ text: 'Streaming (EBU R 128 s2), edited', edited: 1, reset: 'Reset to Streaming (EBU R 128 s2)' })
    expect(presetField([job(normalize())], 'compress', ctx())).toBeNull()
  })

  it('shows a preset no list holds as a disabled option', () =>
  {
    const mine = userPreset('user-web', 'My web', preset('web-1080p'))
    const applied = applyPreset('user-web', SAME, [mine]) as Recipe
    expect(presetKey(applied)).toBe('user-web')
    const kept = presetField([job(applied)], 'compress', ctx({ presets: { user: [mine], pins: {}, recent: [] } })) as PresetField
    expect(kept).toMatchObject({ value: 'user-web', text: 'My web' })
    expect(kept.options.find((option) => option.key === 'user-web')).toMatchObject({ group: 'Your presets', disabled: false })
    const gone = presetField([job(applied)], 'compress', ctx()) as PresetField
    expect(gone.text).toBe('Custom (from deleted preset My web)')
    expect(gone.options.find((option) => option.key === 'user-web')).toMatchObject({ group: null, disabled: true, note: null })
    const loose = { ...preset('web-1080p'), presetId: null } as Recipe
    expect(presetKey(loose)).toBe('custom')
    expect((presetField([job(loose)], 'compress', ctx()) as PresetField).options.find((option) => option.key === 'custom')).toMatchObject({ label: 'Custom', disabled: true })
  })

  it('says before commit what a preset would block', () =>
  {
    const jobs = [...many(30, () => preset('audio-mp3-320')), ...many(8, () => preset('audio-mp3-320'), { media: audioOnly() })]
    const state = presetField(jobs, 'extract', ctx()) as PresetField
    expect(state.options.find((option) => option.group === 'Video')?.note).toBe('8 of 38 have no video stream; Extract video needs one, so they would be blocked.')
    expect(state.options.find((option) => option.key === 'audio-mp3-320')?.note).toBeNull()
    const frozen = presetField([locked(preset('audio-mp3-320'), 'queued')], 'extract', ctx()) as PresetField
    expect(frozen).toMatchObject({ disabled: true, reason: 'Queued in Batch 31. Take it out of the batch to edit it.', reset: null })
    expect(frozen.options.every((option) => option.note === null)).toBe(true)
  })

  it('assigns the whole recipe of the chosen preset', () =>
  {
    const edited = edit(normalize('custom'), { field: 'target', value: -30 })
    const a = job(edited)
    const b = job(preset('web-1080p'))
    const frozen = locked(normalize())
    const result = choosePreset([a, b, frozen], 'normalize', 'spotify', ctx({ output: AAC }))
    expect(result.assignments.map((entry) => entry.recipe)).toEqual([applyLoudnessPreset('spotify', AAC), applyLoudnessPreset('spotify', AAC)])
    expect(result).toMatchObject({ unchanged: [], invalid: [], locked: [frozen.id] })
    const custom = choosePreset([b], 'normalize', 'custom', ctx())
    expect(custom.assignments[0].recipe).toEqual(applyLoudnessPreset('custom', SAME))
    const freed = choosePreset([job(applyLoudnessPreset('ebu-r128', AAC))], 'normalize', 'custom', ctx())
    expect(freed.assignments[0].recipe).toEqual({ ...applyLoudnessPreset('ebu-r128', AAC), presetId: 'custom', userPreset: null })
    expect(choosePreset([b], 'boost', 'custom', ctx()).assignments[0].recipe).toEqual({ ...applyGainPreset('gentle-lift', SAME), presetId: 'custom' })
    const recent = choosePreset([b], 'normalize', 'recent:0', ctx({ presets: { user: [], pins: {}, recent: [edited] } }))
    expect(recent.assignments[0].recipe).toEqual(edited)
    expect(recent.assignments[0].recipe).not.toBe(edited)
    expect(choosePreset([a, frozen], 'normalize', 'nothing', ctx())).toMatchObject({ assignments: [], invalid: [a.id], locked: [frozen.id] })
    expect(choosePreset([a], 'normalize', 'recent:5', ctx()).invalid).toEqual([a.id])
    expect(presetChoiceRecipe('custom', 'convert', ctx())).toBeNull()
    const twice = choosePreset([job(applyLoudnessPreset('spotify', SAME))], 'normalize', 'spotify', ctx())
    expect(twice.unchanged).toHaveLength(1)
  })

  it('resets edited jobs to their preset, keeping the preset they name and the album', () =>
  {
    const grouped = { ...edit(normalize(), { field: 'target', value: -16 }), albumGroupId: 'A' } as Recipe
    const a = job(grouped)
    const plain = job(normalize())
    const custom = job(normalize('custom'))
    const result = resetToPreset([a, plain, custom], ctx())
    expect(result.assignments).toEqual([{ jobId: a.id, recipe: { ...normalize(), albumGroupId: 'A' } }])
    expect(result.unchanged).toEqual([plain.id, custom.id])
    const mine = userPreset('user-web', 'My web', preset('web-1080p'))
    const applied = applyPreset('user-web', SAME, [mine]) as Recipe
    const tuned = edit(applied, { field: 'maxSize', value: null })
    expect(tuned).not.toEqual(applied)
    const reset = resetToPreset([job(tuned)], ctx({ presets: { user: [mine], pins: {}, recent: [] } }))
    expect(reset.assignments[0].recipe).toEqual(applied)
  })

  it('pins a user preset under its own name', () =>
  {
    const voice = userPreset('user-voice', 'Voice', normalize('custom'))
    const state = presetField([job(normalize())], 'normalize', ctx({ presets: { user: [voice], pins: { 7: 'user-voice' }, recent: [] } })) as PresetField
    expect(state.options.filter((option) => option.group === 'Pinned').map((option) => [option.key, option.label, option.description])).toEqual([
      ['pinned:user-voice', 'Voice', 'Alt+7']
    ])
  })
})

describe('Convert fields', () =>
{
  const mp4 = (): ConvertRecipe => preset('mp4-h264') as ConvertRecipe

  it('disables the video codecs the container cannot hold, with the reason', () =>
  {
    const codecs = (...recipes: Recipe[]): FieldState['options'] => field(recipeFields(recipes.map((recipe) => job(recipe)), 'convert', ctx()), 'videoCodec').options
    const inMp4 = codecs(mp4()) ?? []
    expect(inMp4.filter((option) => option.disabled).map((option) => [option.value, option.reason])).toEqual([
      ['prores_ks', 'MP4 cannot hold ProRes.'],
      ['utvideo', 'MP4 cannot hold UT Video.'],
      ['libtheora', 'MP4 cannot hold Theora.'],
      ['wmv2', 'MP4 cannot hold WMV2.']
    ])
    expect(inMp4.find((option) => option.value === 'ffv1')).toMatchObject({ disabled: false, reason: null })
    const webm = { ...mp4(), container: 'webm' } as Recipe
    const inWebm = codecs(webm) ?? []
    expect(inWebm.filter((option) => !option.disabled).map((option) => option.value)).toEqual(['copy', 'libvpx-vp9', 'libaom-av1', 'libsvtav1'])
    expect(inWebm.find((option) => option.value === 'libx264')?.reason).toBe('WebM cannot hold H.264.')
    const mixed = codecs(mp4(), webm) ?? []
    expect(mixed.filter((option) => !option.disabled).map((option) => option.value)).toEqual(['copy', 'libvpx-vp9', 'libaom-av1', 'libsvtav1'])
    expect(mixed.find((option) => option.value === 'libtheora')?.reason).toBe('MP4 cannot hold Theora.')
    expect(mixed.find((option) => option.value === 'libx264')?.reason).toBe('WebM cannot hold H.264.')
    expect(codecs({ ...mp4(), container: 'mkv' } as Recipe)?.some((option) => option.disabled)).toBe(false)
    expect(codecs({ ...mp4(), container: 'mka' } as Recipe)?.some((option) => option.disabled)).toBe(false)
  })

  it('lists the video and audio fields of a video output', () =>
  {
    const states = recipeFields([job(mp4())], 'convert', ctx())
    expect(states.map((state) => state.key)).toEqual(['container', 'videoCodec', 'videoBitrate', 'size', 'fps', 'pixelFormat', 'audio', 'audioBitrate', 'channels', 'subtitles'])
    expect(field(states, 'container')).toMatchObject({ value: 'mp4', text: containerLabel('mp4') })
    expect(field(states, 'container').options?.map((option) => option.value)).toEqual(['mp4', 'mkv', 'webm', 'mp3', 'mov', 'ts', 'wav', 'flac', 'm4a', 'ogg', 'ac3'])
    expect(field(states, 'videoCodec')).toMatchObject({ value: 'libx264', text: 'H.264 (libx264)' })
    expect(field(states, 'videoCodec').options).toHaveLength(13)
    expect(field(states, 'videoBitrate')).toMatchObject({ kind: 'number', value: 5000, text: '5,000 kb/s', unit: 'kb/s', range: { min: 100, max: 200000, step: 100 } })
    expect(field(states, 'videoBitrate').options?.map((option) => option.label)).toEqual(['Auto'])
    expect(field(states, 'size')).toMatchObject({ value: null, text: 'Original' })
    expect(field(states, 'size').options?.map((option) => option.label)).toEqual(['Original', '3840x2160', '2560x1440', '1920x1080', '1280x720', '854x480', '640x360'])
    expect(field(states, 'fps')).toMatchObject({ value: null, text: 'Original', unit: 'fps', range: { min: 1, max: 240, step: 1 } })
    expect(field(states, 'fps').options?.map((option) => option.label)).toEqual(['Original', '24 fps', '25 fps', '30 fps', '50 fps', '60 fps'])
    expect(field(states, 'pixelFormat')).toMatchObject({ value: 'yuv420p', text: '8-bit 4:2:0' })
    expect(field(states, 'pixelFormat').options?.map((option) => option.label)).toEqual(['Keep source', '8-bit 4:2:0', '10-bit 4:2:0'])
    expect(field(states, 'audio')).toMatchObject({ value: 'aac', text: 'AAC' })
    expect(field(states, 'audio').options?.map((option) => option.label)).toEqual(['Copy (no re-encode)', 'AAC', 'MP3', 'Opus', 'Vorbis', 'FLAC', 'ALAC', 'AC-3', 'E-AC-3', 'PCM'])
    expect(field(states, 'audioBitrate')).toMatchObject({ label: 'Audio bitrate', value: 256, text: '256 kb/s' })
    expect(field(states, 'channels')).toMatchObject({ value: 'keep', text: 'Keep' })
    expect(field(states, 'channels').options?.map((option) => option.label)).toEqual(['Keep', 'Stereo', 'Mono'])
    expect(field(states, 'subtitles')).toMatchObject({ kind: 'checkbox', value: true, text: 'Kept' })
  })

  it('drops the video fields for an audio-only output and offers WMA only for Windows Media', () =>
  {
    expect(recipeFields([job(preset('mp3-320'))], 'convert', ctx()).map((state) => state.key)).toEqual(['container', 'audio', 'audioBitrate', 'channels', 'subtitles'])
    const wmv = { ...mp4(), container: 'wmv' }
    const states = recipeFields([job(wmv)], 'convert', ctx())
    expect(field(states, 'audio').options?.at(-1)).toMatchObject({ value: 'wmav2', label: 'WMA (wmav2)' })
    expect(field(states, 'container').options?.at(-1)).toMatchObject({ value: 'wmv', label: containerLabel('wmv') })
    expect(field(recipeFields([job(mp4())], 'convert', ctx()), 'audio').options?.some((option) => option.value === 'wmav2')).toBe(false)
    const same = { ...mp4(), audio: { kind: 'same-as-source' } } as Recipe
    expect(field(recipeFields([job(same)], 'convert', ctx()), 'audio').text).toBe('Same as source')
  })

  it('edits each video field alone and clears what copied video cannot carry', () =>
  {
    const base = mp4()
    const video = base.video as NonNullable<ConvertRecipe['video']>
    expect(edit(base, { field: 'container', value: 'mkv' })).toEqual({ ...base, container: 'mkv' })
    const copied = edit(base, { field: 'videoCodec', value: 'copy' })
    expect(copied).toEqual({ ...base, video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } })
    expect(recipeFields([job(copied)], 'convert', ctx()).map((state) => state.key)).toEqual(['container', 'videoCodec', 'audio', 'audioBitrate', 'channels', 'subtitles'])
    expect(field(recipeFields([job(copied)], 'convert', ctx()), 'videoCodec').text).toBe('Copy (no re-encode)')
    expect(edit(base, { field: 'videoCodec', value: 'ffv1' })).toEqual({ ...base, video: { ...video, encoder: 'ffv1', bitrateKbps: null } })
    expect(recipeFields([job(edit(base, { field: 'videoCodec', value: 'ffv1' }))], 'convert', ctx()).map((state) => state.key)).not.toContain('videoBitrate')
    expect(edit(base, { field: 'videoCodec', value: 'libx265' })).toEqual({ ...base, video: { ...video, encoder: 'libx265' } })
    expect(edit(base, { field: 'videoBitrate', value: 8000 })).toEqual({ ...base, video: { ...video, bitrateKbps: 8000 } })
    const auto = edit(base, { field: 'videoBitrate', value: null })
    expect(auto).toEqual({ ...base, video: { ...video, bitrateKbps: null } })
    expect(field(recipeFields([job(auto)], 'convert', ctx()), 'videoBitrate').text).toBe('Auto')
    expect(edit(base, { field: 'fps', value: 30 })).toEqual({ ...base, video: { ...video, fps: 30 } })
    expect(edit(base, { field: 'pixelFormat', value: 'yuv420p10le' })).toEqual({ ...base, video: { ...video, pixelFormat: 'yuv420p10le' } })
    expect(applyFieldPatch(copied, { field: 'fps', value: 30 }, ctx())).toBeNull()
    expect(applyFieldPatch(preset('mp3-320'), { field: 'videoCodec', value: 'libx264' }, ctx())).toBeNull()
    expect(fieldError(base, { field: 'videoBitrate', value: 50 })).toBe('Enter 100 to 200000 kb/s.')
    const tuned = field(recipeFields([job(edit(base, { field: 'videoBitrate', value: 8000 })), job(base)], 'convert', ctx()), 'videoBitrate')
    expect(tuned).toMatchObject({ mixed: true, mixedText: '8,000 kb/s (1), 5,000 kb/s (1)', edited: 1 })
  })

  it('caps the frame size and offers the fit while a size is set', () =>
  {
    const base = mp4()
    const hd = edit(base, { field: 'size', value: { maxWidth: 1280, maxHeight: 720 } }) as ConvertRecipe
    expect(hd.video?.fit).toEqual({ maxWidth: 1280, maxHeight: 720, mode: 'fit' })
    const states = recipeFields([job(hd)], 'convert', ctx())
    expect(field(states, 'size')).toMatchObject({ value: { maxWidth: 1280, maxHeight: 720 }, text: '1280x720' })
    expect(field(states, 'fit')).toMatchObject({ kind: 'segmented', value: 'fit', text: 'Fit inside', hint: 'Keeps the display aspect and never upscales.' })
    expect(field(states, 'fit').options?.map((option) => option.label)).toEqual(['Fit inside', 'Pad to size', 'Crop to fill'])
    const padded = edit(hd, { field: 'fit', value: 'pad' }) as ConvertRecipe
    expect(padded.video?.fit).toEqual({ maxWidth: 1280, maxHeight: 720, mode: 'pad' })
    expect((edit(padded, { field: 'size', value: { maxWidth: 1920, maxHeight: 1080 } }) as ConvertRecipe).video?.fit).toEqual({ maxWidth: 1920, maxHeight: 1080, mode: 'pad' })
    expect((edit(padded, { field: 'size', value: null }) as ConvertRecipe).video?.fit).toBeNull()
    const tall = { ...base, video: { ...base.video, fit: { maxWidth: null, maxHeight: 900, mode: 'fit' } } } as Recipe
    const wide = { ...base, video: { ...base.video, fit: { maxWidth: 1000, maxHeight: null, mode: 'crop' } } } as Recipe
    const size = field(recipeFields([job(tall), job(wide), job(wide)], 'convert', ctx()), 'size')
    expect(size).toMatchObject({ mixed: true, mixedText: '1000 px wide (2), 900p (1)' })
    expect(size.options?.slice(-2).map((option) => option.label)).toEqual(['900p', '1000 px wide'])
    expect(field(recipeFields([job(tall), job(wide)], 'convert', ctx()), 'fit')).toMatchObject({ mixed: true, mixedText: 'Fit inside (1), Crop to fill (1)' })
    expect(fieldError(base, { field: 'size', value: { maxWidth: 8, maxHeight: 720 } })).toBe('Enter 16 to 7680 px.')
    expect(fieldError(base, { field: 'size', value: { maxWidth: null, maxHeight: 720 } })).toBeNull()
    expect(fieldError(base, { field: 'size', value: null })).toBeNull()
    const huge = job(base)
    expect(editField([huge], { field: 'size', value: { maxWidth: 9000, maxHeight: null } }, ctx())).toMatchObject({ assignments: [], invalid: [huge.id] })
  })

  it('lists the frame rates with any other in use', () =>
  {
    const base = mp4()
    const film = { ...base, video: { ...base.video, fps: 23.976 } } as Recipe
    const fps = field(recipeFields([job(film)], 'convert', ctx()), 'fps')
    expect(fps).toMatchObject({ value: 23.976, text: '23.976 fps' })
    expect(fps.options?.at(-1)?.label).toBe('23.976 fps')
    expect(fieldError(base, { field: 'fps', value: 500 })).toBe('Enter 1 to 240 fps.')
  })

  it('edits the audio codec, bitrate, channels, and subtitles alone', () =>
  {
    const base = mp4()
    expect(edit(base, { field: 'audio', value: 'copy' })).toEqual({ ...base, audio: { kind: 'copy' } })
    expect(edit(base, { field: 'audio', value: 'mp3' })).toEqual({ ...base, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 256 } })
    expect(edit(base, { field: 'audio', value: 'flac' })).toEqual({ ...base, audio: { kind: 'codec', codec: 'flac', kbpsPerPair: null } })
    expect(edit(base, { field: 'audioBitrate', value: 320 })).toEqual({ ...base, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 320 } })
    expect(edit(base, { field: 'channels', value: 'stereo' })).toEqual({ ...base, channels: 'stereo' })
    const dropped = edit(base, { field: 'subtitles', value: false })
    expect(dropped).toEqual({ ...base, subtitles: 'drop' })
    expect(field(recipeFields([job(dropped)], 'convert', ctx()), 'subtitles').text).toBe('Dropped')
  })

  it('says before commit which channel choices a codec would block', () =>
  {
    const surround = media({ audio: [stream(6)] })
    const jobs = [job(preset('mp3-320'), { media: surround }), job(preset('mp3-320'))]
    const channels = field(recipeFields(jobs, 'convert', ctx()), 'channels')
    expect(channels.options?.find((option) => option.value === 'keep')?.note).toBe('MP3 holds at most 2 channels. 1 of the selected jobs has 5.1 audio and would be blocked.')
    expect(channels.options?.find((option) => option.value === 'stereo')?.note).toBeNull()
    const single = job(mp4(), { media: surround })
    const audio = field(recipeFields([single], 'convert', ctx()), 'audio')
    expect(audio.options?.find((option) => option.value === 'mp3')?.note).toMatch(/ It would be blocked\.$/)
    expect(audio.options?.find((option) => option.value === 'aac')?.note).toBeNull()
  })
})

describe('Compress fields', () =>
{
  it('reads a CRF preset with its encoder, speed, size cap, and tunes', () =>
  {
    const states = recipeFields([job(preset('web-1080p'))], 'compress', ctx())
    expect(states.map((state) => state.key)).toEqual(['compressMode', 'quality', 'crf', 'encoder', 'speed', 'maxSize', 'pixelFormat', 'tune', 'audio', 'audioBitrate'])
    expect(field(states, 'compressMode')).toMatchObject({ kind: 'segmented', value: 'quality', text: 'Quality' })
    expect(field(states, 'compressMode').options?.map((option) => option.label)).toEqual(['Quality', 'Target size'])
    expect(field(states, 'quality')).toMatchObject({ value: 'custom', text: 'Custom' })
    expect(field(states, 'quality').options?.map((option) => [option.label, option.disabled])).toEqual([['Lossless', false], ['High', false], ['Medium', false], ['Low', false], ['Custom', false]])
    expect(field(states, 'crf')).toMatchObject({ kind: 'number', value: 23, text: 'CRF 23', range: { min: 0, max: 51, step: 1 }, hint: '0 to 51 for x264 and x265, 0 to 63 for VP9 and AV1' })
    expect(field(states, 'encoder')).toMatchObject({ value: 'libx264', text: 'H.264 (libx264)' })
    expect(field(states, 'encoder').options?.map((option) => option.label)).toEqual(['H.264 (libx264)', 'HEVC (libx265)', 'AV1 (SVT-AV1)', 'AV1 (libaom)', 'VP9 (libvpx-vp9)'])
    expect(field(states, 'speed')).toMatchObject({ value: 'medium', text: 'Medium' })
    expect(field(states, 'speed').options?.map((option) => option.label)).toEqual(['Very fast', 'Fast', 'Medium', 'Slow', 'Very slow'])
    expect(field(states, 'maxSize')).toMatchObject({ value: { maxWidth: null, maxHeight: 1080, mode: 'fit' }, text: '1080p' })
    expect(field(states, 'maxSize').hint).toBe('Applies to the picture as displayed, so portrait video is capped like landscape.')
    expect(field(states, 'maxSize').options?.map((option) => option.label)).toEqual(['Original', '2160p', '1440p', '1080p', '720p', '480p'])
    expect(field(states, 'pixelFormat')).toMatchObject({ value: 'yuv420p', disabled: false, reason: null })
    expect(field(states, 'tune')).toMatchObject({ value: null, text: 'None' })
    expect(field(states, 'tune').options?.map((option) => option.label)).toEqual(['None', 'Film', 'Animation', 'Grain', 'Fast decode', 'Zero latency'])
    expect(field(states, 'audioBitrate')).toMatchObject({ value: 192, text: '192 kb/s' })
  })

  it('keeps lossless and SVT-AV1 apart and the pixel format of lossless output', () =>
  {
    const lossless = edit(preset('web-1080p'), { field: 'quality', value: 'lossless' })
    expect(lossless).toMatchObject({ target: { mode: 'quality', tier: 'lossless' } })
    const states = recipeFields([job(lossless)], 'compress', ctx())
    expect(states.map((state) => state.key)).not.toContain('crf')
    expect(field(states, 'quality')).toMatchObject({ value: 'lossless', text: 'Lossless' })
    expect(field(states, 'encoder').options?.find((option) => option.value === 'libsvtav1')).toMatchObject({ disabled: true, reason: 'SVT-AV1 has no lossless mode.' })
    expect(field(states, 'pixelFormat')).toMatchObject({ disabled: true, reason: 'Lossless keeps the source pixel format.' })
    expect(applyFieldPatch(lossless, { field: 'pixelFormat', value: 'yuv420p10le' }, ctx())).toBeNull()
    expect(edit(preset('web-1080p'), { field: 'pixelFormat', value: 'yuv420p10le' })).toMatchObject({ pixelFormat: 'yuv420p10le' })
    const svt = edit(preset('web-1080p'), { field: 'encoder', value: 'libsvtav1' })
    expect(fieldError(svt, { field: 'quality', value: 'lossless' })).toBe('SVT-AV1 has no lossless mode.')
    expect(field(recipeFields([job(svt)], 'compress', ctx()), 'quality').options?.[0]).toMatchObject({ value: 'lossless', disabled: true, reason: 'SVT-AV1 has no lossless mode.' })
    const blocked = job(svt)
    expect(editField([blocked], { field: 'quality', value: 'lossless' }, ctx())).toMatchObject({ assignments: [], invalid: [blocked.id] })
  })

  it('switches between quality tiers, a custom CRF, and a size target', () =>
  {
    const web = preset('web-1080p')
    const high = edit(web, { field: 'quality', value: 'high' })
    expect(high).toMatchObject({ target: { mode: 'quality', tier: 'high' } })
    expect(field(recipeFields([job(high)], 'compress', ctx()), 'quality').text).toBe('High')
    expect(edit(high, { field: 'quality', value: 'custom' })).toMatchObject({ target: { mode: 'crf', crf: 23 } })
    expect(edit({ ...high, encoder: 'libx265' } as Recipe, { field: 'quality', value: 'custom' })).toMatchObject({ target: { mode: 'crf', crf: 28 } })
    expect(edit({ ...high, encoder: 'mpeg4' } as Recipe, { field: 'quality', value: 'custom' })).toMatchObject({ target: { mode: 'crf', crf: 23 } })
    expect(edit(web, { field: 'quality', value: 'custom' })).toEqual(web)
    expect(edit(web, { field: 'crf', value: 30 })).toMatchObject({ target: { mode: 'crf', crf: 30 } })
    expect(fieldError(web, { field: 'crf', value: 60 })).toBe('Enter 0 to 51.')
    const sized = edit(web, { field: 'compressMode', value: 'size' })
    expect(sized).toMatchObject({ target: { mode: 'size', targetBytes: 25_000_000, twoPass: true } })
    expect(field(recipeFields([job(sized)], 'compress', ctx()), 'compressMode').text).toBe('Target size')
    expect(edit(sized, { field: 'compressMode', value: 'size' })).toEqual(sized)
    expect(edit(sized, { field: 'compressMode', value: 'quality' })).toMatchObject({ target: { mode: 'quality', tier: 'medium' } })
    expect(edit(web, { field: 'compressMode', value: 'quality' })).toEqual(web)
    const odd = { ...web, encoder: 'mpeg4' } as Recipe
    const states = recipeFields([job(odd)], 'compress', ctx())
    expect(field(states, 'crf').range).toBeNull()
    expect(field(states, 'encoder').options?.at(-1)).toMatchObject({ value: 'mpeg4', label: 'MPEG-4' })
    expect(edit(odd, { field: 'encoder', value: 'libx264' })).toMatchObject({ target: { mode: 'crf', crf: 23 } })
  })

  it('states the size budget of one file and the size target in megabytes', () =>
  {
    const target = preset('target-25mb')
    const states = recipeFields([job(target)], 'compress', ctx())
    expect(states.map((state) => state.key)).toEqual(['compressMode', 'targetSize', 'twoPass', 'encoder', 'speed', 'maxSize', 'pixelFormat', 'tune', 'audio', 'audioBitrate'])
    const size = field(states, 'targetSize')
    expect(size).toMatchObject({ value: 25, text: '25 MB', unit: 'MB', range: { min: 1, max: null, step: 1 } })
    expect(size.hint).toBe('1 MB is 1,000,000 bytes. The encode aims a little under the target, and the output must not exceed it.')
    expect(size.note).toBe('For this 2:14 file: video about 1,351 kb/s, audio 96 kb/s.')
    expect(field(states, 'twoPass')).toMatchObject({ kind: 'checkbox', value: true, text: 'On' })
    expect(field(recipeFields([job(target), job(target)], 'compress', ctx()), 'targetSize').note).toBe('Each file\'s bitrate follows its duration; see Plan.')
    expect(field(recipeFields([job(target, { media: null })], 'compress', ctx()), 'targetSize').note).toBeNull()
    expect(field(recipeFields([job(target, { media: media({ durationSec: null }) })], 'compress', ctx()), 'targetSize').note).toBeNull()
    expect(edit(target, { field: 'targetSize', value: 2.5 })).toMatchObject({ target: { mode: 'size', targetBytes: 2_500_000, twoPass: true } })
    const onePass = edit(target, { field: 'twoPass', value: false })
    expect(onePass).toMatchObject({ target: { mode: 'size', targetBytes: 25_000_000, twoPass: false } })
    expect(field(recipeFields([job(onePass)], 'compress', ctx()), 'twoPass').text).toBe('Off')
    expect(fieldError(target, { field: 'targetSize', value: 0.5 })).toBe('Enter 1 MB or more.')
    expect(edit(target, { field: 'encoder', value: 'libx265' })).toMatchObject({ target: (target as CompressRecipe).target })
  })

  it('budgets each audio stream from the chosen bitrate or the source', () =>
  {
    const target = preset('target-25mb') as CompressRecipe
    const surround = media({ audio: [stream(6), stream(2, { bitrateKbps: null })] })
    expect(compressAudioKbps(target, surround)).toEqual([288, 96])
    expect(compressAudioKbps({ ...target, audio: { kind: 'copy' } }, surround)).toEqual([192, 0])
    expect(jobSizeBudget(target, null)).toBeNull()
    expect(jobSizeBudget(preset('web-1080p') as CompressRecipe, surround)).toBeNull()
    expect(jobSizeBudget(target, media({ durationSec: null }))).toBeNull()
    expect(jobSizeBudget(target, media())).toMatchObject({ videoKbps: 1351, audioKbps: 96, fits: true })
  })

  it('keeps the CRF inside the new encoder\'s range and only the tunes the encoder accepts', () =>
  {
    const film = preset('x264-master')
    expect(edit(film, { field: 'encoder', value: 'libx265' })).toMatchObject({ encoder: 'libx265', target: { mode: 'crf', crf: 18 }, tune: null })
    const grain = preset('film-grain')
    expect(edit(grain, { field: 'encoder', value: 'libx264' })).toMatchObject({ encoder: 'libx264', tune: 'grain' })
    expect(edit(grain, { field: 'encoder', value: 'libsvtav1' })).toMatchObject({ encoder: 'libsvtav1', tune: null })
    const vp9 = { ...preset('web-1080p'), encoder: 'libvpx-vp9', target: { mode: 'crf', crf: 60 } } as Recipe
    expect(edit(vp9, { field: 'encoder', value: 'libx264' })).toMatchObject({ target: { mode: 'crf', crf: 51 } })
    expect(fieldError(grain, { field: 'tune', value: 'film' })).toBe('HEVC (libx265) has no film tune.')
    expect(fieldError(grain, { field: 'tune', value: null })).toBeNull()
    const both = field(recipeFields([job(film), job(grain)], 'compress', ctx()), 'tune')
    expect(both).toMatchObject({ mixed: true, mixedText: 'Film (1), Grain (1)' })
    expect(both.options?.map((option) => option.label)).toEqual(['None', 'Animation', 'Grain', 'Fast decode', 'Zero latency'])
    expect(recipeFields([job(preset('av1-streaming'))], 'compress', ctx()).map((state) => state.key)).not.toContain('tune')
    const stale = { ...preset('av1-streaming'), tune: 'grain' } as Recipe
    expect(field(recipeFields([job(stale)], 'compress', ctx()), 'tune')).toMatchObject({ value: 'grain', error: 'AV1 (libaom) has no grain tune.' })
    expect(edit(film, { field: 'tune', value: 'zerolatency' })).toMatchObject({ tune: 'zerolatency' })
    expect(edit(film, { field: 'speed', value: 'veryfast' })).toMatchObject({ speed: 'veryfast' })
  })

  it('caps the displayed size with any other cap in use', () =>
  {
    const web = preset('web-1080p')
    expect(edit(web, { field: 'maxSize', value: null })).toMatchObject({ fit: null })
    expect(edit(web, { field: 'maxSize', value: { maxWidth: null, maxHeight: 720, mode: 'fit' } })).toMatchObject({ fit: { maxWidth: null, maxHeight: 720, mode: 'fit' } })
    const boxed = { ...web, fit: { maxWidth: 1280, maxHeight: 720, mode: 'pad' } } as Recipe
    const sized = field(recipeFields([job(boxed), job(preset('master'))], 'compress', ctx()), 'maxSize')
    expect(sized).toMatchObject({ mixed: true, mixedText: '1280x720 (1), Original (1)' })
    expect(sized.options?.at(-1)).toMatchObject({ label: '1280x720' })
    expect(field(recipeFields([job(preset('master'))], 'compress', ctx()), 'maxSize').text).toBe('Original')
  })

  it('says under the encoder which container the output keeps', () =>
  {
    const web = preset('web-1080p')
    expect(field(recipeFields([job(web)], 'compress', ctx()), 'encoder').note)
      .toBe('Compress keeps the source container (.mp4) unless it cannot hold the encode; then the output is .mkv and Plan says why.')
    const mov = (entry: JobView): JobView => ({ ...entry, source: { ...entry.source, name: 'clip.MOV', ext: 'MOV' } })
    expect(field(recipeFields([job(web), job(web)], 'compress', ctx()), 'encoder').note).toMatch(/^Compress keeps the source container \(\.mp4\) /)
    expect(field(recipeFields([mov(job(web))], 'compress', ctx()), 'encoder').note).toMatch(/^Compress keeps the source container \(\.mov\) /)
    expect(field(recipeFields([job(web), mov(job(web))], 'compress', ctx()), 'encoder').note)
      .toBe('Compress keeps each source container unless it cannot hold the encode; then the output is .mkv and Plan says why.')
    expect(field(recipeFields([job({ ...web, container: 'mkv' } as Recipe)], 'compress', ctx()), 'encoder').note).toBeNull()
  })

  it('says when a source container cannot hold the encoder and the output moves to .mkv', () =>
  {
    const web = preset('web-1080p') as CompressRecipe
    const av1 = { ...web, encoder: 'libaom-av1' } as Recipe
    const from = (entry: JobView, ext: string): JobView => ({ ...entry, source: { ...entry.source, name: `clip.${ext}`, ext: `.${ext}` } })
    const note = (...jobs: JobView[]): string | null => field(recipeFields(jobs, 'compress', ctx()), 'encoder').note
    expect(note(from(job(web), 'webm')))
      .toBe('Compress keeps the source container (.webm) unless it cannot hold the encode. WebM cannot hold H.264, so the output is .mkv.')
    expect(note(from(job(web), 'webm'), job(web)))
      .toBe('Compress keeps each source container unless it cannot hold the encode. WebM cannot hold H.264, so 1 of the 2 jobs writes .mkv.')
    expect(note(from(job(web), 'webm'), from(job(web), 'webm'), job(web)))
      .toBe('Compress keeps each source container unless it cannot hold the encode. WebM cannot hold H.264, so 2 of the 3 jobs write .mkv.')
    expect(note(from(job(web), 'webm'), from(job(av1), 'mov')))
      .toBe('Compress keeps each source container unless it cannot hold the encode. All 2 jobs write .mkv; Plan says why.')
    expect(note(from(job(web), 'webm'), from(job(av1), 'mov'), job(web)))
      .toBe('Compress keeps each source container unless it cannot hold the encode. 2 of the 3 jobs write .mkv; Plan says why.')
    expect(note(from(job(web), 'divx')))
      .toBe('Compress keeps the source container (.divx) unless it cannot hold the encode. FFmpeg cannot write DIVX files, so the output is .mkv.')
    expect(note(from(job({ ...web, encoder: 'libx265' } as Recipe), 'flv')))
      .toBe('Compress keeps the source container (.flv) unless it cannot hold the encode; then the output is .mkv and Plan says why.')
  })
})

describe('Extract fields', () =>
{
  it('reads an audio extract with its format, bitrate, rate, channels, stream, and range', () =>
  {
    const states = recipeFields([job(preset('audio-mp3-320'))], 'extract', ctx())
    expect(states.map((state) => state.key)).toEqual(['extractMode', 'audioFormat', 'audioBitrate', 'sampleRate', 'channels', 'stream', 'start', 'duration'])
    expect(field(states, 'extractMode')).toMatchObject({ kind: 'segmented', value: 'audio', text: 'Audio' })
    expect(field(states, 'extractMode').options?.map((option) => option.label)).toEqual(['Audio', 'Video', 'GIF', 'Frames', 'Subtitles'])
    expect(field(states, 'audioFormat')).toMatchObject({ value: 'mp3', text: 'MP3' })
    expect(field(states, 'audioFormat').options?.map((option) => option.label)).toEqual(['MP3', 'AAC (M4A)', 'Opus', 'Vorbis (OGG)', 'FLAC', 'WAV', 'AIFF', 'Copy (no re-encode)'])
    expect(field(states, 'audioBitrate')).toMatchObject({ label: 'Bitrate', value: 320, text: '320 kb/s' })
    expect(field(states, 'sampleRate')).toMatchObject({ value: null, text: 'Original' })
    expect(field(states, 'sampleRate').options?.map((option) => [option.label, option.reason])).toEqual([
      ['Original', null], ['44.1 kHz', null], ['48 kHz', null], ['96 kHz', 'MP3 encodes at 48 kHz at most.']
    ])
    expect(field(states, 'channels')).toMatchObject({ value: 'keep', text: 'Original' })
    expect(field(states, 'channels').options?.map((option) => option.label)).toEqual(['Original', 'Mono', 'Stereo'])
    expect(field(states, 'stream')).toMatchObject({ value: { by: 'default' }, text: 'Default stream', nested: null })
    expect(field(states, 'stream').options?.map((option) => option.label)).toEqual(['Default stream', 'Audio 1 · English · AAC stereo · 192 kb/s'])
    expect(field(states, 'start')).toMatchObject({ value: 0, text: '0:00', unit: 's', range: { min: 0, max: null, step: 0.1 }, note: null })
    expect(field(states, 'duration')).toMatchObject({ value: null, text: 'To the end', range: { min: 0.01, max: null, step: 0.1 } })
    expect(field(states, 'duration').options?.map((option) => option.label)).toEqual(['To the end'])
  })

  it('labels source streams with language, format, bitrate, and default', () =>
  {
    expect(audioStreamLabel(stream(6, { codec: 'ac3', bitrateKbps: 640, isDefault: true }), 1)).toBe('Audio 2 · English · AC-3 5.1(side) · 640 kb/s · default')
    expect(audioStreamLabel(stream(2, { codec: 'pcm_s16le', language: 'und', bitrateKbps: null }), 0)).toBe('Audio 1 · PCM stereo')
    expect(audioStreamLabel(stream(3, { codec: 'weird', language: null }), 2)).toBe('Audio 3 · WEIRD · 192 kb/s')
    expect(audioStreamLabel(stream(2, { language: 'x1' }), 0)).toBe('Audio 1 · x1 · AAC stereo · 192 kb/s')
    expect(audioStreamLabel(stream(2, { language: '' }), 0)).toBe('Audio 1 · AAC stereo · 192 kb/s')
  })

  it('switches the audio format with its container and keeps or sets the bitrate', () =>
  {
    const mp3 = preset('audio-mp3-320')
    expect(edit(mp3, { field: 'audioFormat', value: 'aac' })).toMatchObject({ container: 'm4a', audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 320 } })
    const flac = edit(mp3, { field: 'audioFormat', value: 'flac' })
    expect(flac).toMatchObject({ container: 'flac', audio: { kind: 'codec', codec: 'flac', kbpsPerPair: null } })
    expect(recipeFields([job(flac)], 'extract', ctx()).map((state) => state.key)).not.toContain('audioBitrate')
    expect(edit(flac, { field: 'audioFormat', value: 'opus' })).toMatchObject({ container: 'opus', audio: { codec: 'opus', kbpsPerPair: 128 } })
    expect(edit(flac, { field: 'audioFormat', value: 'vorbis' })).toMatchObject({ container: 'ogg', audio: { codec: 'vorbis', kbpsPerPair: 192 } })
    expect(edit(mp3, { field: 'audioFormat', value: 'copy' })).toMatchObject({ container: 'mka', audio: { kind: 'copy' } })
    expect(edit(mp3, { field: 'audioFormat', value: 'wav' })).toMatchObject({ container: 'wav', audio: { codec: 'pcm', kbpsPerPair: null } })
    const aiff = edit(mp3, { field: 'audioFormat', value: 'aiff' })
    expect(aiff).toMatchObject({ container: 'aiff', audio: { codec: 'pcm' } })
    expect(field(recipeFields([job(aiff)], 'extract', ctx()), 'audioFormat').text).toBe('AIFF')
    expect(field(recipeFields([job({ ...aiff, container: 'aif' } as Recipe)], 'extract', ctx()), 'audioFormat').value).toBe('aiff')
    expect(field(recipeFields([job(edit(mp3, { field: 'audioFormat', value: 'copy' }))], 'extract', ctx()), 'audioFormat').value).toBe('copy')
    expect(edit(mp3, { field: 'audioFormat', value: null })).toEqual(mp3)
    const podcast = preset('audio-podcast')
    expect(edit(podcast, { field: 'audioFormat', value: 'opus' })).toMatchObject({ audio: { codec: 'opus', kbpsPerPair: 192 }, sampleRate: null })
    expect(edit(podcast, { field: 'audioFormat', value: 'aac' })).toMatchObject({ sampleRate: 44100 })
    const alac = { ...mp3, container: 'm4a', audio: { kind: 'codec', codec: 'alac', kbpsPerPair: null } } as Recipe
    expect(field(recipeFields([job(alac)], 'extract', ctx()), 'audioFormat')).toMatchObject({ value: null, text: audioCodecLabel('alac') })
    const same = { ...mp3, audio: { kind: 'same-as-source' } } as Recipe
    expect(field(recipeFields([job(same)], 'extract', ctx()), 'audioFormat')).toMatchObject({ value: null, text: 'Same as source' })
  })

  it('refuses the sample rates an encoder cannot write', () =>
  {
    const opus = preset('audio-opus-128')
    const rate = field(recipeFields([job(opus)], 'extract', ctx()), 'sampleRate')
    expect(rate.options?.filter((option) => option.disabled).map((option) => [option.label, option.reason])).toEqual([
      ['44.1 kHz', 'Opus encodes at 48 kHz only.'], ['96 kHz', 'Opus encodes at 48 kHz only.']
    ])
    expect(fieldError(opus, { field: 'sampleRate', value: 44100 })).toBe('Opus encodes at 48 kHz only.')
    expect(fieldError(opus, { field: 'sampleRate', value: null })).toBeNull()
    expect(edit(opus, { field: 'sampleRate', value: 48000 })).toMatchObject({ sampleRate: 48000 })
    expect(field(recipeFields([job(edit(opus, { field: 'sampleRate', value: 48000 }))], 'extract', ctx()), 'sampleRate').text).toBe('48 kHz')
    expect(field(recipeFields([job({ ...opus, sampleRate: 44100 } as Recipe)], 'extract', ctx()), 'sampleRate').error).toBe('Opus encodes at 48 kHz only.')
    const copy = edit(opus, { field: 'audioFormat', value: 'copy' })
    expect(field(recipeFields([job(copy)], 'extract', ctx()), 'sampleRate').options?.every((option) => !option.disabled)).toBe(true)
    expect(edit(opus, { field: 'channels', value: 'mono' })).toMatchObject({ channels: 'mono' })
  })

  it('lists one job\'s own streams and generic picks for several jobs', () =>
  {
    const two = media({ audio: [stream(2, { isDefault: true }), stream(6, { codec: 'ac3', language: 'fre', bitrateKbps: 448 })] })
    const one = field(recipeFields([job(preset('audio-mp3-320'), { media: two })], 'extract', ctx()), 'stream')
    expect(one.options?.map((option) => [option.label, option.value])).toEqual([
      ['Default stream', { by: 'default' }],
      ['Audio 1 · English · AAC stereo · 192 kb/s · default', { by: 'ordinal', ordinal: 1 }],
      ['Audio 2 · French · AC-3 5.1(side) · 448 kb/s', { by: 'ordinal', ordinal: 2 }]
    ])
    const several = field(recipeFields([job(preset('audio-mp3-320')), job(preset('audio-mp3-320'))], 'extract', ctx()), 'stream')
    expect(several.options?.map((option) => [option.label, option.value])).toEqual([
      ['Default stream', { by: 'default' }],
      ['First stream in a language', { by: 'language', language: 'eng' }],
      ['Stream number', { by: 'ordinal', ordinal: 1 }]
    ])
    const unnamed = media({ audio: [stream(2, { language: 'und' }), stream(2, { language: 'spa' })] })
    const spanish = field(recipeFields([job(preset('audio-mp3-320'), { media: unnamed }), job(preset('audio-mp3-320'))], 'extract', ctx()), 'stream')
    expect(spanish.options?.[1].value).toEqual({ by: 'language', language: 'spa' })
    const unknown = field(recipeFields([job(preset('audio-mp3-320'), { media: null }), job(preset('audio-mp3-320'))], 'extract', ctx()), 'stream')
    expect(unknown.options?.[1].value).toEqual({ by: 'language', language: 'eng' })
    const silent = field(recipeFields([job(preset('audio-mp3-320'), { media: media({ audio: [stream(2, { language: null })] }) })], 'extract', ctx()), 'stream')
    expect(silent.options?.map((option) => option.label)).toEqual(['Default stream', 'Audio 1 · AAC stereo · 192 kb/s'])
  })

  it('edits the language or number inside the stream pick', () =>
  {
    const base = preset('audio-mp3-320')
    const french = edit(base, { field: 'stream', value: { by: 'language', language: 'fre' } })
    const state = field(recipeFields([job(french), job(french)], 'extract', ctx()), 'stream')
    expect(state).toMatchObject({ value: { by: 'language', language: 'fre' }, text: 'First stream in French' })
    expect(state.nested).toMatchObject({ key: 'streamLanguage', kind: 'input', value: 'fre', text: 'French', disabled: false })
    expect(state.options?.[1].note).toBe('No audio stream in French. 2 of the selected jobs would be blocked.')
    expect(state.options?.[0].note).toBeNull()
    expect(edit(french, { field: 'streamLanguage', value: ' de ' })).toMatchObject({ stream: { by: 'language', language: 'de' } })
    expect(fieldError(french, { field: 'streamLanguage', value: 'not a code' })).toBe('Enter a language code, such as eng or fr.')
    expect(fieldError(french, { field: 'streamLanguage', value: 'pt-BR' })).toBeNull()
    const second = edit(base, { field: 'stream', value: { by: 'ordinal', ordinal: 2 } })
    const numbered = field(recipeFields([job(second), job(second)], 'extract', ctx()), 'stream')
    expect(numbered).toMatchObject({ text: 'Stream 2' })
    expect(numbered.nested).toMatchObject({ key: 'streamOrdinal', value: 2, text: 'Stream 2', range: { min: 1, max: 64, step: 1 } })
    expect(numbered.options?.[2]).toMatchObject({ value: { by: 'ordinal', ordinal: 2 }, note: 'No audio stream 2. 2 of the selected jobs would be blocked.' })
    expect(edit(second, { field: 'streamOrdinal', value: 3 })).toMatchObject({ stream: { by: 'ordinal', ordinal: 3 } })
    expect(fieldError(second, { field: 'streamOrdinal', value: 65 })).toBe('Enter 1 to 64.')
    const mixed = field(recipeFields([job(second), job(french)], 'extract', ctx()), 'stream')
    expect(mixed).toMatchObject({ mixed: true, nested: null })
    expect(mixed.options?.slice(1).map((option) => option.value)).toEqual([{ by: 'language', language: 'fre' }, { by: 'ordinal', ordinal: 2 }])
    expect(applyFieldPatch(base, { field: 'streamOrdinal', value: 2 }, ctx())).toBeNull()
    const one = job(base)
    expect(editField([one], { field: 'stream', value: { by: 'language', language: 'fre' } }, ctx()).notes).toEqual([
      { code: 'stream-not-found', severity: 'error', count: 1, text: `${one.source.name} has no audio stream in fre. It would be blocked.` }
    ])
  })

  it('lists one job\'s subtitle streams from the probe and refuses bitmap ones', () =>
  {
    const subs = preset('subs-srt')
    const probed = job(subs, { media: media({ subtitles: 2 }) })
    const facts: StreamFacts = {
      video: true,
      audio: [{ channels: 2, language: 'eng', isDefault: true }],
      subtitles: [{ codec: 'hdmv_pgs_subtitle', bitmap: true, language: 'eng' }, { codec: 'subrip', bitmap: false, language: null }],
      subtitleCount: 2
    }
    const states = recipeFields([probed], 'extract', ctx({ facts: { [probed.id]: facts } }))
    expect(states.map((state) => state.key)).toEqual(['extractMode', 'stream', 'subtitleFormat'])
    const pick = field(states, 'stream')
    expect(pick.options?.map((option) => [option.label, option.reason])).toEqual([
      ['Default stream', null],
      ['Subtitle 1 · English · PGS', 'Bitmap subtitles (PGS) cannot become text subtitles.'],
      ['Subtitle 2 · SRT', null]
    ])
    expect(pick.options?.[0].note).toBe(`Stream 1 of ${probed.source.name} is a bitmap subtitle (hdmv_pgs_subtitle); it cannot become SRT. It would be blocked.`)
    expect(pick.options?.[2].note).toBeNull()
    expect(field(states, 'subtitleFormat')).toMatchObject({ value: 'srt', text: 'SRT' })
    expect(field(states, 'subtitleFormat').options?.map((option) => option.label)).toEqual(['SRT', 'WebVTT', 'ASS'])
    expect(edit(subs, { field: 'subtitleFormat', value: 'vtt' })).toMatchObject({ format: 'vtt' })
    const unprobed = field(recipeFields([job(subs)], 'extract', ctx()), 'stream')
    expect(unprobed.options?.map((option) => option.label)).toEqual(['Default stream', 'First stream in a language', 'Stream number'])
    const none = field(recipeFields([probed], 'extract', ctx({ facts: { [probed.id]: { ...facts, subtitles: [], subtitleCount: 0 } } })), 'stream')
    expect(none.options?.map((option) => option.label)).toEqual(['Default stream', 'First stream in a language', 'Stream number'])
  })

  it('disables a re-encode the container cannot hold, with the reason', () =>
  {
    const copy = preset('video-silent-copy')
    const reencoded = edit(copy, { field: 'videoCopy', value: 'reencode' })
    const states = recipeFields([job(reencoded)], 'extract', ctx())
    expect(field(states, 'container').options?.some((option) => option.disabled)).toBe(false)
    expect(field(states, 'videoCopy').options?.some((option) => option.disabled)).toBe(false)
    const odd = recipeFields([job({ ...reencoded, container: 'ogv' } as Recipe)], 'extract', ctx())
    expect(field(odd, 'container').options?.map((option) => [option.value, option.reason])).toEqual([
      ['mp4', null],
      ['mkv', null],
      ['mov', null],
      ['webm', null],
      ['ogv', 'OGV cannot hold H.264.']
    ])
    expect(field(odd, 'videoCopy').options?.map((option) => option.reason)).toEqual([null, 'OGV cannot hold H.264.'])
    const copied = recipeFields([job({ ...copy, container: 'ogv' } as Recipe)], 'extract', ctx())
    expect(field(copied, 'container').options?.some((option) => option.disabled)).toBe(false)
    expect(field(copied, 'videoCopy').options?.map((option) => option.reason)).toEqual([null, 'OGV cannot hold H.264.'])
  })

  it('reads a video extract and re-encodes in the container\'s codec', () =>
  {
    const copy = preset('video-silent-copy')
    const states = recipeFields([job(copy)], 'extract', ctx())
    expect(states.map((state) => state.key)).toEqual(['extractMode', 'container', 'videoCopy', 'start', 'duration'])
    expect(field(states, 'container').options?.map((option) => option.value)).toEqual(['mp4', 'mkv', 'mov', 'webm'])
    expect(field(states, 'videoCopy')).toMatchObject({ value: 'copy', text: 'Copy (cuts at keyframes)' })
    expect(field(states, 'videoCopy').options?.map((option) => option.label)).toEqual(['Copy (cuts at keyframes)', 'Re-encode'])
    const reencoded = edit(copy, { field: 'videoCopy', value: 'reencode' })
    expect(reencoded).toMatchObject({ reencode: { encoder: 'libx264', crf: 20 } })
    expect(field(recipeFields([job(reencoded)], 'extract', ctx()), 'videoCopy').text).toBe('Re-encode')
    expect(edit(reencoded, { field: 'videoCopy', value: 'reencode' })).toEqual(reencoded)
    expect(edit(reencoded, { field: 'videoCopy', value: 'copy' })).toMatchObject({ reencode: null })
    expect(field(recipeFields([job(reencoded)], 'extract', ctx()), 'crf')).toMatchObject({ value: 20, text: 'CRF 20', range: { min: 0, max: 51, step: 1 } })
    expect(edit(reencoded, { field: 'crf', value: 26 })).toMatchObject({ reencode: { encoder: 'libx264', crf: 26 } })
    const webm = edit(reencoded, { field: 'container', value: 'webm' })
    expect(webm).toMatchObject({ container: 'webm', reencode: { encoder: 'libvpx-vp9', crf: 20 } })
    expect(field(recipeFields([job(webm)], 'extract', ctx()), 'crf').range).toEqual({ min: 0, max: 63, step: 1 })
    expect(edit({ ...webm, reencode: { encoder: 'libvpx-vp9', crf: 60 } } as Recipe, { field: 'container', value: 'mkv' })).toMatchObject({ reencode: { encoder: 'libx264', crf: 51 } })
    expect(edit(copy, { field: 'container', value: 'mov' })).toMatchObject({ container: 'mov', reencode: null })
    expect(edit(edit(copy, { field: 'container', value: 'webm' }), { field: 'videoCopy', value: 'reencode' })).toMatchObject({ reencode: { encoder: 'libvpx-vp9', crf: 20 } })
    expect(field(recipeFields([job({ ...copy, container: 'avi' } as Recipe)], 'extract', ctx()), 'container').options?.at(-1)?.value).toBe('avi')
  })

  it('warns that a copied clip starts at a keyframe and edits the range', () =>
  {
    const copy = preset('video-silent-copy')
    const late = edit(copy, { field: 'start', value: 12.5 })
    expect(late).toMatchObject({ range: { startSec: 12.5, durationSec: null } })
    const start = field(recipeFields([job(late)], 'extract', ctx({ keyframeIntervalSec: 2 })), 'start')
    expect(start).toMatchObject({ value: 12.5, text: '0:12.5', note: 'Copy cuts at keyframes; the clip can start up to 2 s early. Re-encode for an exact cut.' })
    expect(field(recipeFields([job(late)], 'extract', ctx()), 'start').note).toBeNull()
    expect(field(recipeFields([job(late)], 'extract', ctx({ keyframeIntervalSec: 0 })), 'start').note).toBeNull()
    expect(field(recipeFields([job(late), job(late)], 'extract', ctx({ keyframeIntervalSec: 2 })), 'start').note).toBeNull()
    expect(field(recipeFields([job(edit(late, { field: 'videoCopy', value: 'reencode' }))], 'extract', ctx({ keyframeIntervalSec: 2 })), 'start').note).toBeNull()
    expect(field(recipeFields([job(copy)], 'extract', ctx({ keyframeIntervalSec: 2 })), 'start').note).toBeNull()
    const clip = edit(late, { field: 'duration', value: 30 })
    expect(clip).toMatchObject({ range: { startSec: 12.5, durationSec: 30 } })
    expect(field(recipeFields([job(clip)], 'extract', ctx()), 'duration')).toMatchObject({ value: 30, text: '0:30' })
    expect(edit(edit(clip, { field: 'start', value: 0 }), { field: 'duration', value: null })).toMatchObject({ range: null })
    expect(edit(copy, { field: 'duration', value: 5 })).toMatchObject({ range: { startSec: 0, durationSec: 5 } })
    expect(fieldError(clip, { field: 'duration', value: 0 })).toBe('Enter 0.01 s or more.')
    expect(fieldError(clip, { field: 'start', value: -1 })).toBe('Enter 0 s or more.')
    expect(applyFieldPatch(preset('subs-srt'), { field: 'start', value: 3 }, ctx())).toBeNull()
  })

  it('reads a GIF with its width, rate, dither, and plays', () =>
  {
    const gif = preset('gif-720')
    const states = recipeFields([job(gif)], 'extract', ctx())
    expect(states.map((state) => state.key)).toEqual(['extractMode', 'gifWidth', 'gifFps', 'dither', 'loop', 'start', 'duration'])
    expect(field(states, 'gifWidth')).toMatchObject({ value: 720, text: '720 px', unit: 'px', range: { min: 1, max: 3840, step: 1 } })
    expect(field(states, 'gifWidth').options?.map((option) => option.label)).toEqual(['Source width'])
    expect(field(states, 'gifFps')).toMatchObject({ value: 15, text: '15 fps', unit: 'fps', range: { min: 1, max: 60, step: 1 } })
    expect(field(states, 'dither')).toMatchObject({ value: 'sierra2_4a', text: 'Sierra 2-4A' })
    expect(field(states, 'dither').options?.map((option) => option.label)).toEqual(['Sierra 2-4A', 'Bayer', 'Floyd-Steinberg', 'None'])
    const loop = field(states, 'loop')
    expect(loop).toMatchObject({ value: 'infinite', text: 'Forever', nested: null })
    expect(loop.options?.map((option) => option.label)).toEqual(['Forever', 'Play once', 'Play 2 times'])
    const thrice = edit(gif, { field: 'loop', value: 3 })
    const counted = field(recipeFields([job(thrice)], 'extract', ctx()), 'loop')
    expect(counted).toMatchObject({ value: 3, text: 'Play 3 times' })
    expect(counted.options?.map((option) => option.label)).toEqual(['Forever', 'Play once', 'Play 3 times'])
    expect(counted.nested).toMatchObject({ key: 'loopCount', value: 3, text: '3 times', disabled: false, range: { min: 2, max: 65536, step: 1 } })
    expect(edit(thrice, { field: 'loopCount', value: 5 })).toMatchObject({ plays: 5 })
    const once = edit(gif, { field: 'loop', value: 1 })
    expect(once).toMatchObject({ plays: 1 })
    expect(field(recipeFields([job(once)], 'extract', ctx()), 'loop').text).toBe('Play once')
    const source = edit(gif, { field: 'gifWidth', value: null })
    expect(source).toMatchObject({ width: null })
    expect(field(recipeFields([job(source)], 'extract', ctx()), 'gifWidth').text).toBe('Source width')
    expect(edit(gif, { field: 'gifFps', value: 24 })).toMatchObject({ fps: 24 })
    expect(edit(gif, { field: 'dither', value: 'none' })).toMatchObject({ dither: 'none' })
    expect(fieldError(gif, { field: 'gifFps', value: 61 })).toBe('Enter 1 to 60 fps.')
  })

  it('reads frame sampling with its amount and the JPEG quality', () =>
  {
    const every = preset('frames-every-sec')
    const states = recipeFields([job(every)], 'extract', ctx())
    expect(states.map((state) => state.key)).toEqual(['extractMode', 'sampling', 'frameFormat', 'start', 'duration'])
    const sampling = field(states, 'sampling')
    expect(sampling).toMatchObject({ value: { by: 'interval', seconds: 1 }, text: 'Every 1 second' })
    expect(sampling.options?.map((option) => option.label)).toEqual(['Every 1 second', '1 per second', '50 evenly spaced', 'One thumbnail'])
    expect(sampling.nested).toMatchObject({ key: 'samplingValue', value: 1, text: 'Every 1 second', unit: 's', range: { min: 0.05, max: null, step: 0.05 }, disabled: false })
    expect(field(states, 'frameFormat')).toMatchObject({ value: 'png', text: 'PNG' })
    expect(field(states, 'frameFormat').options?.map((option) => option.label)).toEqual(['PNG', 'JPEG', 'WebP'])
    const two = edit(every, { field: 'samplingValue', value: 2 })
    expect(two).toMatchObject({ sampling: { by: 'interval', seconds: 2 } })
    expect(field(recipeFields([job(two)], 'extract', ctx()), 'sampling').text).toBe('Every 2 seconds')
    const perSecond = edit(every, { field: 'sampling', value: { by: 'fps', fps: 0.5 } })
    expect(field(recipeFields([job(perSecond)], 'extract', ctx()), 'sampling').nested).toMatchObject({
      value: 0.5, text: '0.5 per second', unit: 'per second', range: { min: 0.01, max: null, step: 0.01 }
    })
    expect(edit(perSecond, { field: 'samplingValue', value: 2 })).toMatchObject({ sampling: { by: 'fps', fps: 2 } })
    const fifty = preset('frames-50-even')
    expect(field(recipeFields([job(fifty)], 'extract', ctx()), 'sampling').nested).toMatchObject({
      value: 50, text: '50 evenly spaced', unit: 'frames', range: { min: 1, max: 1000, step: 1 }
    })
    expect(edit(fifty, { field: 'samplingValue', value: 20 })).toMatchObject({ sampling: { by: 'count', count: 20 } })
    expect(field(recipeFields([job(fifty)], 'extract', ctx()), 'jpgQuality')).toMatchObject({ value: 4, text: '4', range: { min: 2, max: 31, step: 1 }, hint: '2 is best, 31 is smallest.' })
    const thumb = preset('frames-thumb')
    expect(field(recipeFields([job(thumb)], 'extract', ctx()), 'sampling')).toMatchObject({ text: 'One thumbnail', nested: null })
    expect(applyFieldPatch(thumb, { field: 'samplingValue', value: 3 }, ctx())).toBeNull()
    expect(edit(every, { field: 'frameFormat', value: 'jpg' })).toMatchObject({ format: 'jpg', jpgQuality: 3 })
    expect(edit(fifty, { field: 'frameFormat', value: 'jpg' })).toMatchObject({ jpgQuality: 4 })
    expect(edit(fifty, { field: 'frameFormat', value: 'webp' })).toMatchObject({ format: 'webp', jpgQuality: null })
    expect(edit(fifty, { field: 'jpgQuality', value: 2 })).toMatchObject({ jpgQuality: 2 })
    const mixed = field(recipeFields([job(every), job(fifty)], 'extract', ctx()), 'sampling')
    expect(mixed).toMatchObject({ mixed: true, nested: { disabled: true, mixed: true } })
    expect(mixed.options?.map((option) => option.label)).toEqual(['Every 1 second', '1 per second', '50 evenly spaced', 'One thumbnail'])
  })

  it('starts a new mode from its first preset and keeps the range', () =>
  {
    const clip = edit(preset('audio-mp3-320'), { field: 'start', value: 5 })
    expect(edit(clip, { field: 'extractMode', value: 'gif' })).toEqual({ ...preset('gif-720'), range: { startSec: 5, durationSec: null } })
    expect(edit(clip, { field: 'extractMode', value: 'subtitles' })).toEqual(preset('subs-srt'))
    expect(edit(preset('subs-srt'), { field: 'extractMode', value: 'frames' })).toEqual(preset('frames-thumb'))
    expect(edit(clip, { field: 'extractMode', value: 'audio' })).toEqual(clip)
    const jobs = [job(preset('audio-mp3-320')), job(preset('audio-mp3-320'), { media: audioOnly() })]
    const mode = field(recipeFields(jobs, 'extract', ctx()), 'extractMode')
    expect(mode.options?.find((option) => option.value === 'video')?.note).toBe('1 of 2 has no video stream; Extract video needs one, so it would be blocked.')
    expect(mode.options?.find((option) => option.value === 'audio')?.note).toBeNull()
  })
})

describe('consequence notes', () =>
{
  it('counts subtitle, stream, and channel rules over several jobs', () =>
  {
    const subs = preset('subs-srt')
    const a = job(subs)
    const b = job(subs)
    const unprobed = job(subs, { media: null })
    const pgs: StreamFacts = { video: true, audio: [], subtitles: [{ codec: 'hdmv_pgs_subtitle', bitmap: true, language: 'eng' }], subtitleCount: 1 }
    expect(consequenceNotes([a, b, unprobed], (entry) => entry.recipe, { facts: { [a.id]: pgs, [b.id]: pgs } })).toEqual([
      { code: 'subtitle-bitmap', severity: 'error', count: 2, text: 'Bitmap subtitles (PGS) cannot become text subtitles. 2 of the selected jobs would be blocked.' }
    ])
    expect(consequenceNotes([a, b], (entry) => entry.recipe)).toEqual([
      { code: 'stream-not-found', severity: 'error', count: 2, text: 'No subtitle stream. 2 of the selected jobs would be blocked.' }
    ])
    expect(consequenceNotes([a, b], () => null)).toEqual([])
    const surround = media({ audio: [stream(6), stream(8)] })
    const mp3 = edit(normalize(), { field: 'output', value: 'mp3' })
    const silent = media({ audio: [] })
    const notes = consequenceNotes([job(mp3, { media: surround }), job(mp3, { media: silent }), job(mp3)], (entry) => entry.recipe)
    expect(notes.map((note) => [note.code, note.count])).toEqual([['no-audio-stream', 1], ['too-many-channels', 1]])
    expect(notes[0].text).toBe('1 of 3 has no audio stream; Normalize needs one, so it would be blocked.')
    expect(notes[1].text).toBe('MP3 holds at most 2 channels. 1 of the selected jobs has 5.1 audio and would be blocked.')
  })

  it('names bitmap subtitle codecs', () =>
  {
    expect(bitmapReason('hdmv_pgs_subtitle')).toBe('Bitmap subtitles (PGS) cannot become text subtitles.')
    expect(bitmapReason('dvd_subtitle')).toBe('Bitmap subtitles (DVD) cannot become text subtitles.')
    expect(bitmapReason('weird')).toBe('Bitmap subtitles (WEIRD) cannot become text subtitles.')
  })
})

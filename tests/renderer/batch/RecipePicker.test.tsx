/**
 * The recipe picker: its grouped catalog, the query filter across groups, the applicability footer worded from the
 * shared stream rules, Enter and Shift+Enter, Escape returning focus to the table, and the pinned keys.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BatchActionsContext } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import type { BatchActions } from '../../../src/renderer/src/stores/batchActions'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'
import
{
  RecipePicker,
  applicabilityLines,
  applyRecipe,
  blockedJobs,
  blockedNote,
  matchesQuery,
  noMatchText,
  pickerLabel,
  pinChord,
  pinnedEntry,
  recipeCatalog,
  runPinChord,
  scopeText,
  type PickerJob,
  type RecipeActions,
  type RecipePickerHandle
} from '../../../src/renderer/src/components/batch/toolbar/RecipePicker'
import { DEFAULT_PINS, applyPreset } from '../../../src/shared/jobs/presets'
import type { MediaSummary, PresetState, UserPreset } from '../../../src/shared/jobs/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'

const SAME = { kind: 'same-as-source' } as const

function state(over: Partial<PresetState> = {}): PresetState
{
  return { user: [], pins: { ...DEFAULT_PINS }, recent: [], ...over }
}

const VIDEO: NonNullable<MediaSummary['video']> = { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 25 }

function audio(channels = 2): MediaSummary['audio'][number]
{
  return { codec: 'aac', channels, layout: null, sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: null, isDefault: true }
}

function media(over: Partial<MediaSummary> = {}): MediaSummary
{
  return { container: 'mkv', durationSec: 60, video: VIDEO, audio: [audio()], subtitles: 0, attachments: 0, chapters: 0, cover: false, ...over }
}

function job(n: number, over: Partial<PickerJob> = {}): PickerJob
{
  return { id: `MM-${String(n).padStart(4, '0')}` as PickerJob['id'], state: 'pending', media: media(), ...over }
}

/** 38 selected jobs: 30 with video, then 8 audio-only sources. */
function selection(): PickerJob[]
{
  return Array.from({ length: 38 }, (_, index) => job(301 + index, index < 30 ? {} : { media: media({ video: null }) }))
}

function recipe(id: string): Recipe
{
  return applyPreset(id, SAME) as Recipe
}

function fakeActions(): RecipeActions & { assignRecipes: ReturnType<typeof vi.fn>; duplicate: ReturnType<typeof vi.fn> }
{
  return {
    assignRecipes: vi.fn(async () => ({ status: 'ok' })),
    duplicate: vi.fn(async () => ({ status: 'ok' }))
  } as unknown as RecipeActions & { assignRecipes: ReturnType<typeof vi.fn>; duplicate: ReturnType<typeof vi.fn> }
}

function userPreset(id: string, name: string, presetId: string): UserPreset
{
  return { id, name, recipe: applyPreset(presetId, SAME) as Recipe, createdAt: 0, updatedAt: 0 }
}

function visible(query: string, presets: PresetState = state()): Array<{ group: string; labels: string[] }>
{
  const catalog = recipeCatalog(presets)
  return catalog.groups
    .map((group) => ({
      group: group.label,
      labels: group.options.filter((option) => matchesQuery(catalog.entries.get(option.id)?.search ?? '', query)).map((option) => option.label)
    }))
    .filter((group) => group.labels.length > 0)
}

afterEach(() =>
{
  cleanup()
})

describe('recipeCatalog', () =>
{
  it('groups Pinned, Recently used, each operation, then Your presets', () =>
  {
    const recent = [applyPreset('web-1080p', SAME) as Recipe]
    const catalog = recipeCatalog(state({ recent, user: [userPreset('user-1', 'Talks', 'audio-mp3-320')] }))
    expect(catalog.groups.map((group) => group.label)).toEqual(
      ['Pinned', 'Recently used', 'Convert', 'Normalize', 'Gain', 'Compress', 'Extract', 'Your presets'])
  })

  it('lists the pinned presets with their keys and the operation in each label', () =>
  {
    const pinned = recipeCatalog(state()).groups[0]
    expect(pinned.options.map((option) => option.shortcut)).toEqual(
      ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9'])
    expect(pinned.options[5].label).toBe('Compress · Web 1080p')
    expect(pinned.options[8].label).toBe('Extract · Subtitles to SRT')
  })

  it('describes each option from its values', () =>
  {
    const catalog = recipeCatalog(state())
    const web = catalog.entries.get('preset:web-1080p')
    expect(web?.option.description).toBeTruthy()
    expect(web?.option.shortcut).toBe('Alt+6')
    expect(web?.preset).toBe('Web 1080p')
  })
})

describe('matchesQuery', () =>
{
  it('finds "web" in Pinned, Convert, and Compress', () =>
  {
    const groups = visible('web')
    expect(groups.map((group) => group.group)).toEqual(expect.arrayContaining(['Pinned', 'Compress']))
    expect(groups.find((group) => group.group === 'Pinned')?.labels).toEqual(['Compress · Web 1080p'])
  })

  it('finds "-14" in the loudness targets', () =>
  {
    const groups = visible('-14')
    expect(groups.map((group) => group.group)).toContain('Normalize')
  })

  it('finds "srt" in Pinned and Extract only', () =>
  {
    const groups = visible('srt')
    expect(groups).toEqual([
      { group: 'Pinned', labels: ['Extract · Subtitles to SRT'] },
      { group: 'Extract', labels: ['Extract · Subtitles to SRT'] }
    ])
  })
})

describe('applicabilityLines', () =>
{
  it('blocks Compress on sources without a video stream, in the shared rule words', () =>
  {
    expect(applicabilityLines(recipe('web-1080p'), selection()).map((line) => [line.severity, line.text])).toEqual([
      ['error', '8 of 38 have no video stream; Compress needs one, so they would be blocked.']
    ])
  })

  it('notes a Convert with a video encoder as audio only instead of blocking', () =>
  {
    expect(applicabilityLines(recipe('mp4-h264'), selection()).map((line) => [line.severity, line.text])).toEqual([
      ['info', '8 of 38 have no video stream; their outputs will be audio only.']
    ])
  })

  it('names a single selected job and uses the singular', () =>
  {
    expect(applicabilityLines(recipe('web-1080p'), [job(137, { media: media({ video: null }) })])[0].text)
      .toBe('MM-0137 has no video stream; Compress needs one, so it would be blocked.')
    expect(applicabilityLines(recipe('web-1080p'), [job(1), job(2, { media: media({ video: null }) })])[0].text)
      .toBe('1 of 2 has no video stream; Compress needs one, so it would be blocked.')
  })

  it('counts the locked jobs that keep their settings, and leaves them out of the stream counts', () =>
  {
    const jobs = [
      ...selection().slice(0, 34),
      job(901, { state: 'queued', media: media({ video: null }) }),
      job(902, { state: 'encoding' }),
      job(903, { state: 'done' }),
      job(904, { state: 'failed' })
    ]
    expect(applicabilityLines(recipe('web-1080p'), jobs).map((line) => line.text)).toEqual([
      '4 of 38 have no video stream; Compress needs one, so they would be blocked.',
      '4 of 38 are queued, running, or finished; they keep their settings.'
    ])
    expect(applicabilityLines(recipe('web-1080p'), [job(1), job(2, { state: 'queued' })]).at(-1)?.text)
      .toBe('1 of 2 is queued, running, or finished; it keeps its settings.')
  })

  it('skips jobs whose probe has not finished', () =>
  {
    expect(applicabilityLines(recipe('web-1080p'), [job(1, { media: null }), job(2)])).toEqual([])
  })

  it('blocks audio operations on sources without an audio stream', () =>
  {
    const silent = [job(1, { media: media({ audio: [] }) }), job(2)]
    const lines = applicabilityLines(recipe('audio-mp3-320'), silent)
    expect(lines.map((line) => line.code)).toEqual(['no-audio-stream'])
    expect(lines[0].text).toMatch(/^1 of 2 has no audio stream; .+ needs one, so it would be blocked\.$/)
  })

  it('blocks sources with more channels than the codec holds', () =>
  {
    const surround = [job(1, { media: media({ audio: [audio(6)] }) }), job(2), job(3, { media: media({ audio: [audio(8)] }) })]
    const lines = applicabilityLines(recipe('audio-mp3-320'), surround)
    expect(lines.map((line) => line.text)).toContain('2 of 3 have more channels than MP3 holds; they would be blocked.')
  })

  it('counts a source once when several of its streams meet the same rule', () =>
  {
    const wide = [job(1, { media: media({ audio: [audio(10), audio(12)] }) }), job(2)]
    const lines = applicabilityLines(recipe('mp4-h264'), wide)
    expect(lines.map((line) => [line.code, line.count])).toEqual([['too-many-channels', 1]])
    expect(lines[0].text).toBe('1 of 2 has more channels than AAC holds; it would be blocked.')
    expect(blockedNote(recipe('mp4-h264'), wide)).toBe('1 is now blocked: AAC holds at most 8 channels.')
  })

  it('blocks subtitle extraction from sources without subtitles', () =>
  {
    const lines = applicabilityLines(recipe('subs-srt'), [job(1), job(2, { media: media({ subtitles: 2 }) })])
    expect(lines.map((line) => [line.code, line.count])).toEqual([['stream-not-found', 1]])
    expect(lines[0].text).toMatch(/^1 of 2 has no subtitle stream; .+ needs one, so it would be blocked\.$/)
  })
})

describe('scope and label', () =>
{
  it('names the selection in the popover label', () =>
  {
    expect(pickerLabel(selection())).toBe('Set operation for 38 selected jobs')
    expect(pickerLabel([job(137)])).toBe('Set operation for MM-0137')
    expect(pickerLabel([])).toBe('Set operation')
  })

  it('states the jobs Enter changes', () =>
  {
    expect(scopeText(selection())).toBe('Applies to the 38 selected jobs.')
    expect(scopeText([job(137)])).toBe('Applies to MM-0137.')
    expect(scopeText([job(1), job(2, { state: 'queued' }), job(3)])).toBe('Applies to 2 of the 3 selected jobs.')
    expect(scopeText([job(1, { state: 'done' }), job(2, { state: 'queued' })]))
      .toBe('These jobs keep their settings: they are queued, running, or finished.')
    expect(scopeText([job(137, { state: 'done' })])).toBe('MM-0137 keeps its settings: it is queued, running, or finished.')
    expect(scopeText([])).toBe('Select jobs in the table to set their operation.')
  })

  it('names the query when nothing matches', () =>
  {
    expect(noMatchText('zzz')).toBe('Nothing matches “zzz”.')
  })
})

describe('blockedNote', () =>
{
  it('says how many jobs the change blocks and why', () =>
  {
    expect(blockedJobs(recipe('web-1080p'), selection())).toBe(8)
    expect(blockedNote(recipe('web-1080p'), selection())).toBe('8 are now blocked: Compress needs a video stream.')
    expect(blockedNote(recipe('web-1080p'), [job(1), job(2, { media: media({ video: null }) })]))
      .toBe('1 is now blocked: Compress needs a video stream.')
  })

  it('is null when nothing is blocked, including a note-only rule', () =>
  {
    expect(blockedNote(recipe('mp4-h264'), selection())).toBeNull()
  })
})

describe('applyRecipe', () =>
{
  it('gives every editable selected job a whole copy of the recipe with the applied toast', async () =>
  {
    const actions = fakeActions()
    const entry = recipeCatalog(state()).entries.get('preset:web-1080p')
    const jobs = [...selection(), job(999, { state: 'queued' })]
    await expect(applyRecipe(actions, jobs, entry!, false)).resolves.toEqual({ kind: 'applied', count: 38 })
    const [assignments, options] = actions.assignRecipes.mock.calls[0]
    expect(assignments).toHaveLength(38)
    expect(assignments.map((item: { jobId: string }) => item.jobId)).not.toContain('MM-0999')
    expect(assignments[0].recipe).toEqual(entry!.recipe)
    expect(assignments[0].recipe).not.toBe(assignments[1].recipe)
    expect(options).toEqual({ toast: { kind: 'applied', preset: 'Web 1080p', note: '8 are now blocked: Compress needs a video stream.' } })
    expect(actions.duplicate).not.toHaveBeenCalled()
  })

  it('adds a second job for each editable source instead when asked', async () =>
  {
    const actions = fakeActions()
    const entry = recipeCatalog(state()).entries.get('pin:7')
    await expect(applyRecipe(actions, [job(1), job(2), job(3, { state: 'done' })], entry!, true)).resolves.toEqual({ kind: 'added', count: 2 })
    expect(actions.duplicate).toHaveBeenCalledWith(['MM-0001', 'MM-0002'], { recipe: entry!.recipe, preset: entry!.preset })
    expect(actions.assignRecipes).not.toHaveBeenCalled()
  })

  it('changes nothing when every selected job is locked or nothing is selected', async () =>
  {
    const actions = fakeActions()
    const entry = recipeCatalog(state()).entries.get('pin:1')!
    await expect(applyRecipe(actions, [job(1, { state: 'queued' }), job(2, { state: 'verifying' })], entry, false)).resolves.toEqual({
      kind: 'none',
      status: 'These jobs keep their settings: they are queued, running, or finished.'
    })
    await expect(applyRecipe(actions, [], entry, true)).resolves.toEqual({ kind: 'none', status: 'Select jobs in the table to set their operation.' })
    expect(actions.assignRecipes).not.toHaveBeenCalled()
    expect(actions.duplicate).not.toHaveBeenCalled()
  })
})

describe('pinned keys', () =>
{
  const chord = (code: string, over: Partial<Parameters<typeof pinChord>[0]> = {}): Parameters<typeof pinChord>[0] =>
    ({ code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...over })

  it('reads Alt and Alt+Shift with a digit by key position', () =>
  {
    expect(pinChord(chord('Digit6'))).toEqual({ key: '6', add: false })
    expect(pinChord(chord('Digit1', { shiftKey: true }))).toEqual({ key: '1', add: true })
    expect(pinChord(chord('Digit9'))).toEqual({ key: '9', add: false })
  })

  it('never binds bare digits, zero, letters, or chords with Ctrl or Meta', () =>
  {
    expect(pinChord(chord('Digit6', { altKey: false }))).toBeNull()
    expect(pinChord(chord('Digit0'))).toBeNull()
    expect(pinChord(chord('KeyA'))).toBeNull()
    expect(pinChord(chord('Numpad6'))).toBeNull()
    expect(pinChord(chord('Digit6', { ctrlKey: true }))).toBeNull()
    expect(pinChord(chord('Digit6', { metaKey: true }))).toBeNull()
  })

  it('finds the entry pinned to a key, and none for an empty pin', () =>
  {
    expect(pinnedEntry(state(), '6')?.option.label).toBe('Compress · Web 1080p')
    const pins = { ...DEFAULT_PINS }
    delete pins['4']
    expect(pinnedEntry(state({ pins }), '4')).toBeNull()
  })

  it('applies the pinned recipe, or adds second jobs with Alt+Shift', async () =>
  {
    const actions = fakeActions()
    await expect(runPinChord(actions, state(), selection(), { key: '6', add: false }, 'win32')).resolves.toEqual({ kind: 'applied', count: 38 })
    expect(actions.assignRecipes.mock.calls[0][1].toast.preset).toBe('Web 1080p')
    await expect(runPinChord(actions, state(), [job(1)], { key: '7', add: true }, 'win32')).resolves.toEqual({ kind: 'added', count: 1 })
    expect(actions.duplicate.mock.calls[0][0]).toEqual(['MM-0001'])
  })

  it('says when nothing is pinned to the key, in the platform words', async () =>
  {
    const actions = fakeActions()
    const pins = { ...DEFAULT_PINS }
    delete pins['4']
    const empty = await runPinChord(actions, state({ pins }), selection(), { key: '4', add: false }, 'win32')
    expect(empty).toEqual({ kind: 'none', status: 'Nothing is pinned to Alt+4. Pin a preset from the preset menu.' })
    const mac = await runPinChord(actions, state({ pins }), selection(), { key: '4', add: false }, 'darwin')
    expect(mac.kind === 'none' && mac.status).toMatch(/^Nothing is pinned to Option.?4\. Pin a preset from the preset menu\.$/)
    expect(actions.assignRecipes).not.toHaveBeenCalled()
  })

  it('keeps the recipes of a selection that is all locked', async () =>
  {
    const actions = fakeActions()
    await expect(runPinChord(actions, state(), [job(1, { state: 'done' })], { key: '1', add: false }, 'win32')).resolves.toEqual({
      kind: 'none',
      status: 'These jobs keep their settings: they are queued, running, or finished.'
    })
  })
})

interface Rendered
{
  actions: ReturnType<typeof fakeActions>
  ref: React.RefObject<RecipePickerHandle | null>
  trigger: HTMLElement
  table: HTMLElement
}

function renderPicker(jobs: PickerJob[], presets: PresetState = state()): Rendered
{
  const actions = fakeActions()
  const ref = React.createRef<RecipePickerHandle>()
  render(
    <PlatformProvider platform="win32">
      <BatchActionsContext.Provider value={actions as unknown as BatchActions}>
        <div role="grid" aria-label="Jobs" tabIndex={0} data-testid="table" />
        <RecipePicker ref={ref} jobs={jobs} presets={presets} returnFocus={() => screen.getByTestId('table')} />
      </BatchActionsContext.Provider>
    </PlatformProvider>
  )
  return { actions, ref, trigger: screen.getByRole('button', { name: 'Set operation' }), table: screen.getByTestId('table') }
}

function open(trigger: HTMLElement): HTMLInputElement
{
  fireEvent.click(trigger)
  return screen.getByRole('combobox', { hidden: true }) as HTMLInputElement
}

function type(input: HTMLInputElement, value: string): void
{
  fireEvent.change(input, { target: { value } })
}

function footer(input: HTMLInputElement): string
{
  return document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent ?? ''
}

function shownGroups(): Array<{ group: string; labels: string[] }>
{
  return screen.queryAllByRole('group', { hidden: true }).map((group) => ({
    group: document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
    labels: within(group).getAllByRole('option', { hidden: true }).map((option) => document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent ?? '')
  }))
}

function highlighted(input: HTMLInputElement): string
{
  const option = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
  return document.getElementById(option?.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''
}

describe('RecipePicker', () =>
{
  it('opens from the Set operation button, named for the selection, with the search placeholder', () =>
  {
    const { trigger } = renderPicker(selection())
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Control+K')
    const input = open(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-label')).toBe('Set operation for 38 selected jobs')
    expect(input.placeholder).toBe('Type an operation, preset, codec, or target')
    expect(document.activeElement).toBe(input)
    expect(shownGroups().map((group) => group.group)).toEqual(['Pinned', 'Convert', 'Normalize', 'Gain', 'Compress', 'Extract'])
  })

  it('filters every group as the user types', () =>
  {
    const input = open(renderPicker(selection()).trigger)
    type(input, 'srt')
    expect(shownGroups()).toEqual([
      { group: 'Pinned', labels: ['Extract · Subtitles to SRT'] },
      { group: 'Extract', labels: ['Extract · Subtitles to SRT'] }
    ])
    type(input, '-14')
    expect(shownGroups().map((group) => group.group)).toContain('Normalize')
    type(input, 'web')
    expect(shownGroups().find((group) => group.group === 'Pinned')?.labels).toEqual(['Compress · Web 1080p'])
  })

  it('states the scope and the highlighted recipe’s applicability in the footer', () =>
  {
    const input = open(renderPicker(selection()).trigger)
    type(input, 'web 1080p')
    expect(highlighted(input)).toBe('Compress · Web 1080p')
    const text = footer(input)
    expect(text).toContain('Applies to the 38 selected jobs.')
    expect(text).toContain('8 of 38 have no video stream; Compress needs one, so they would be blocked.')
    expect(text).toContain('Enter applies. Shift+Enter adds a second job for each source.')
    type(input, 'mp4 h264')
    expect(footer(input)).toContain('8 of 38 have no video stream; their outputs will be audio only.')
    expect(footer(input)).not.toContain('would be blocked')
  })

  it('follows the highlight with Up and Down', () =>
  {
    const input = open(renderPicker(selection()).trigger)
    const first = highlighted(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted(input)).not.toBe(first)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(highlighted(input)).toBe(first)
  })

  it('names the query when nothing matches', () =>
  {
    const input = open(renderPicker(selection()).trigger)
    type(input, 'zzz')
    expect(shownGroups()).toEqual([])
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('Nothing matches “zzz”.')
  })

  it('applies the highlighted recipe on Enter and returns focus to the table', () =>
  {
    const { actions, trigger, table } = renderPicker(selection())
    const input = open(trigger)
    type(input, 'web 1080p')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(actions.assignRecipes).toHaveBeenCalledTimes(1)
    const [assignments, options] = actions.assignRecipes.mock.calls[0]
    expect(assignments).toHaveLength(38)
    expect(options.toast).toEqual({ kind: 'applied', preset: 'Web 1080p', note: '8 are now blocked: Compress needs a video stream.' })
    expect(actions.duplicate).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(table)
  })

  it('adds a second job for each source on Shift+Enter', () =>
  {
    const { actions, trigger } = renderPicker([job(1), job(2)])
    const input = open(trigger)
    type(input, 'mp3 320')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(actions.duplicate).toHaveBeenCalledTimes(1)
    expect(actions.duplicate.mock.calls[0][0]).toEqual(['MM-0001', 'MM-0002'])
    expect(actions.duplicate.mock.calls[0][1].preset).toBe('MP3 320k')
    expect(actions.assignRecipes).not.toHaveBeenCalled()
  })

  it('closes on Escape without applying and returns focus to the table', () =>
  {
    const { actions, trigger, table } = renderPicker(selection())
    const input = open(trigger)
    type(input, 'web')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(table)
    expect(actions.assignRecipes).not.toHaveBeenCalled()
    expect((open(trigger)).value).toBe('')
  })

  it('opens through its handle, as Ctrl+K does', () =>
  {
    const { ref, trigger } = renderPicker([job(137)])
    act(() => ref.current?.open())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const input = screen.getByRole('combobox', { hidden: true })
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-label')).toBe('Set operation for MM-0137')
    act(() => ref.current?.open())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('lets a locked selection browse but not apply, and says why', () =>
  {
    const { actions, trigger } = renderPicker([job(1, { state: 'queued' }), job(2, { state: 'done' })])
    const input = open(trigger)
    expect(footer(input)).toContain('These jobs keep their settings: they are queued, running, or finished.')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(actions.assignRecipes).not.toHaveBeenCalled()
    expect(actions.duplicate).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('lists recently used recipes and the user presets', () =>
  {
    const recent = [recipe('web-1080p')]
    const users = [userPreset('user-1', 'Talks', 'audio-mp3-320')]
    const input = open(renderPicker([job(1)], state({ recent, user: users })).trigger)
    type(input, 'talks')
    expect(shownGroups()).toEqual([{ group: 'Your presets', labels: [expect.stringContaining('Talks')] }])
    type(input, '')
    expect(shownGroups().map((group) => group.group)).toEqual(
      ['Pinned', 'Recently used', 'Convert', 'Normalize', 'Gain', 'Compress', 'Extract', 'Your presets'])
  })
})

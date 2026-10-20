/**
 * The Preset select of the Recipe tab: its grouped choices, the edited and mixed texts, a deleted preset's text,
 * the actions menu (reset, save as, update, rename, pin, delete), the inline save row with its name checks and pin
 * keys, and the standard line a loudness preset shows under it.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { applyGainPreset, applyLoudnessPreset, LOUDNESS_PRESETS } from '../../../src/shared/audio/presets'
import { formatCatalog } from '../../../src/shared/jobs/ids'
import { DEFAULT_PINS } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { JobView, PresetState, UserPreset } from '../../../src/shared/jobs/types'
import type { RecipeContext } from '../../../src/renderer/src/stores/recipeFields'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import type { BatchActions } from '../../../src/renderer/src/stores/batchActions'
import { toast } from '../../../src/renderer/src/ui'
import { STANDARD_TOGGLE, StandardLine, standardLineText } from '../../../src/renderer/src/components/batch/inspector/StandardLine'
import
{
  appliedNote,
  nowBlocked,
  PresetSelect,
  presetRecipe,
  sharedRecipe
} from '../../../src/renderer/src/components/batch/inspector/PresetSelect'
import
{
  NAME_LENGTH_ERROR,
  pinLabel,
  pinOptions,
  presetNameError,
  SavePresetRow
} from '../../../src/renderer/src/components/batch/inspector/SavePresetRow'

const M = '\u2212'
const OUT = { kind: 'same-as-source' } as const

let seq = 0

beforeEach(() =>
{
  window.localStorage.clear()
})

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

function job(recipe: Recipe, over: Partial<JobView> = {}): JobView
{
  seq += 1
  return {
    id: formatCatalog(seq),
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `C:/media/take-${seq}.wav`, name: `take-${seq}.wav`, ext: '.wav', dir: 'C:/media', size: 1000, mtimeMs: 0, origin: 'files', subdir: '' },
    recipe,
    recipeLabel: '',
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
    addedAt: seq,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  } as JobView
}

function presets(over: Partial<PresetState> = {}): PresetState
{
  return { user: [], pins: { ...DEFAULT_PINS }, recent: [], ...over }
}

function ctx(over: Partial<RecipeContext> = {}): RecipeContext
{
  return { presets: presets(), output: OUT, albumIds: [], ...over }
}

function loudness(id: Parameters<typeof applyLoudnessPreset>[0]): Recipe
{
  return applyLoudnessPreset(id, OUT) as Recipe
}

function edited(id: Parameters<typeof applyLoudnessPreset>[0], lufs: number): Recipe
{
  const recipe = applyLoudnessPreset(id, OUT)
  return { ...recipe, target: { ...recipe.target, integratedLufs: lufs } } as Recipe
}

function userPreset(id: string, name: string, recipe: Recipe): UserPreset
{
  return { id, name, recipe: { ...recipe, userPreset: null } as Recipe, createdAt: 1, updatedAt: 1 }
}

function withUser(recipe: Recipe, preset: UserPreset): Recipe
{
  return { ...recipe, userPreset: { id: preset.id, name: preset.name } } as Recipe
}

interface Spies
{
  assignRecipes: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function spies(reply: (name: string, req: unknown) => unknown = () => null): Spies
{
  return {
    assignRecipes: vi.fn(async () => ({ status: 'done', value: { applied: [], refused: [] }, seq: 1, entryId: null })),
    send: vi.fn(async (name: string, req: unknown) => ({ status: 'done', value: reply(name, req), seq: 1 }))
  }
}

function renderSelect(jobs: JobView[], context: RecipeContext, op: Recipe['kind'] = 'normalize', actions: Spies = spies()): Spies
{
  render(
    <TestBatchActionsProvider overrides={actions as unknown as Partial<BatchActions>}>
      <PresetSelect jobs={jobs} op={op} ctx={context} />
    </TestBatchActionsProvider>
  )
  return actions
}

function select(): HTMLSelectElement
{
  return screen.getByLabelText('Preset') as HTMLSelectElement
}

function groups(): string[]
{
  return Array.from(select().querySelectorAll('optgroup')).map((group) => group.label)
}

describe('standardLineText', () =>
{
  it('words every built-in loudness preset from its data', () =>
  {
    const sentences = Object.fromEntries(LOUDNESS_PRESETS.map((preset) => [preset.id, standardLineText(preset.id)?.sentence]))
    expect(sentences['ebu-r128']).toBe(`EBU R 128: ${M}23.0 LUFS, true peak at most ${M}1.0 dBTP. Files are normalized to the target and checked within \u00b10.2 LU.`)
    expect(sentences['atsc-a85']).toBe(`ATSC A/85: ${M}24 LKFS, true peak at most ${M}2.0 dBTP. A/85 anticipates \u00b12 dB; this app checks within \u00b10.5 dB for lossless and \u00b11.0 dB for lossy outputs.`)
    expect(sentences['film-r128s4']).toBe(`EBU R 128 s4: ${M}23.0 LUFS program loudness, true peak at most ${M}1.0 dBTP. Checked within \u00b10.2 LU.`)
    expect(sentences['apple-podcasts']).toBe(`Apple Podcasts: ${M}16 LKFS, true peak at most ${M}1.0 dBTP. Apple states \u00b11 dB; this app checks within \u00b10.5 dB for lossless and \u00b11.0 dB for lossy outputs.`)
    expect(sentences['spotify']).toBe(`Spotify reference: ${M}14 LUFS, true peak at most ${M}1.0 dBTP. No tolerance stated; this app checks within \u00b10.5 LU for lossless and \u00b11.0 LU for lossy outputs.`)
    expect(sentences['streaming-r128s2']).toBe(`EBU R 128 s2: ${M}18 LUFS (s2 allows ${M}20 to ${M}16), true peak at most ${M}1.0 dBTP. No tolerance stated; this app checks within \u00b10.5 LU for lossless and \u00b11.0 LU for lossy outputs.`)
    expect(sentences['aes-streaming']).toBe(`AES TD1004 (2015): ${M}18 LUFS, true peak at most ${M}1.0 dBTP. Checked within \u00b10.5 LU.`)
    expect(sentences['night']).toBe(`Not a standard: ${M}18 LUFS after reducing dynamics, true peak at most ${M}1.0 dBTP.`)
    expect(sentences['custom']).toBe(`Custom: integrated ${M}60 to ${M}5 LUFS, true peak ${M}9 to 0 dBTP.`)
  })

  it('adds the supersession line, the measurement note, and the cited clauses', () =>
  {
    const aes = standardLineText('aes-streaming')
    expect(aes?.superseded).toBe('Superseded by AES TD1008 (2021) and AES77-2023; these values are not verified against AES77-2023.')
    expect(standardLineText('ebu-r128')?.superseded).toBeNull()
    expect(standardLineText('film-r128s4')?.note).toBe('Measured on the full mix with a BS.1770 meter, as s4 (g) specifies for Programme Loudness.')
    expect(standardLineText('atsc-a85')?.note).toMatch(/^A\/85's method for short-form content \(section 5\.2\.6\)/)
    expect(standardLineText('spotify')?.note).toBeNull()
    expect(standardLineText('ebu-r128')?.sources.map((source) => source.clause)).toEqual(['(h), (i), (m), (q)', '(d)', '', 'sections 3.1 and 3.3'])
  })

  it('takes an edited target inside the range, and names nothing for an unknown preset', () =>
  {
    expect(standardLineText('streaming-r128s2', -17)?.sentence).toMatch(new RegExp(`^EBU R 128 s2: ${M}17\\.0 LUFS \\(s2 allows`))
    expect(standardLineText('mp4-h264')).toBeNull()
  })

  it('renders the sentences and opens each source in the browser with its clause', () =>
  {
    render(<StandardLine presetId='ebu-r128' id='line' />)
    const toggle = screen.getByRole('button', { name: STANDARD_TOGGLE })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const line = document.getElementById('line') as HTMLElement
    expect(line.textContent).toContain('Files are normalized to the target')
    const sources = within(screen.getByRole('list', { name: 'Sources' })).getAllByRole('listitem')
    expect(sources).toHaveLength(4)
    const link = within(sources[0]).getByRole('link')
    expect(link.getAttribute('href')).toBe('https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128.pdf')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(sources[0].textContent).toBe('EBU R 128 V5 (November 2023), (h), (i), (m), (q)')
    expect(sources[2].textContent).toBe('EBU Tech 3344 version 2.1 (July 2016)')
    cleanup()
    const { container } = render(<StandardLine presetId='aes-streaming' />)
    expect(container.textContent).toContain('Superseded by AES TD1008 (2021)')
    cleanup()
    const empty = render(<StandardLine presetId='web-1080p' />)
    expect(empty.container.innerHTML).toBe('')
  })
})

describe('PresetSelect', () =>
{
  it('groups Normalize choices as Pinned, Recently used, Standards, Not a standard, Custom, and Your presets', () =>
  {
    const late = userPreset('user-late', 'Late podcasts', edited('streaming-r128s2', -17))
    const context = ctx({ presets: presets({ user: [late], recent: [loudness('spotify'), edited('streaming-r128s2', -19)] }) })
    renderSelect([job(loudness('ebu-r128'))], context)
    expect(groups()).toEqual(['Pinned', 'Recently used', 'Standards', 'Not a standard', 'Custom', 'Your presets'])
    expect(select().value).toBe('ebu-r128')
    const pinned = select().querySelector('optgroup[label="Pinned"]') as HTMLElement
    expect(pinned.textContent).toContain(`EBU R 128 (${M}23 LUFS) \u00b7 Alt+1`)
    const recent = select().querySelector('optgroup[label="Recently used"]') as HTMLElement
    expect(recent.textContent).toContain('Streaming (EBU R 128 s2), edited')
  })

  it('groups Gain choices under App presets and Custom', () =>
  {
    renderSelect([job(applyGainPreset('gentle-lift', OUT) as Recipe)], ctx(), 'boost')
    expect(groups()).toEqual(['Pinned', 'App presets', 'Custom'])
  })

  it('reads ", edited" for a recipe that differs from its preset and "Mixed: 2 presets" across presets', () =>
  {
    renderSelect([job(edited('streaming-r128s2', -17))], ctx())
    expect(select().value).toBe('')
    expect(select().selectedOptions[0].textContent).toBe('Streaming (EBU R 128 s2), edited')
    cleanup()
    renderSelect([job(loudness('ebu-r128')), job(loudness('spotify')), job(loudness('spotify'))], ctx())
    expect(select().selectedOptions[0].textContent).toBe('Mixed: 2 presets')
    expect(screen.getByText('Music streaming (Spotify reference) (2), EBU R 128 (1)')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Files are normalized')
  })

  it('names the deleted preset a job came from', () =>
  {
    const gone = { ...edited('streaming-r128s2', -17), userPreset: { id: 'user-gone', name: 'Late podcasts' } } as Recipe
    renderSelect([job(gone)], ctx())
    expect(select().selectedOptions[0].textContent).toBe('Custom (from deleted preset Late podcasts)')
  })

  it('shows the standard line of the shared preset with the shared target', () =>
  {
    renderSelect([job(edited('streaming-r128s2', -17)), job(edited('streaming-r128s2', -17))], ctx())
    expect(document.body.textContent).toContain(`EBU R 128 s2: ${M}17.0 LUFS`)
  })

  it('applies a chosen preset with the applied toast', async () =>
  {
    const actions = renderSelect([job(loudness('ebu-r128')), job(loudness('ebu-r128'))], ctx())
    await act(async () =>
    {
      fireEvent.change(select(), { target: { value: 'spotify' } })
    })
    expect(actions.assignRecipes).toHaveBeenCalledTimes(1)
    const [assignments, options] = actions.assignRecipes.mock.calls[0]
    expect(assignments).toHaveLength(2)
    expect(assignments[0].recipe.presetId).toBe('spotify')
    expect(options).toEqual({ toast: { kind: 'applied', preset: 'Music streaming (Spotify reference)', note: null } })
  })

  it('keeps a locked selection read-only with its reason', () =>
  {
    renderSelect([job(loudness('ebu-r128'), { state: 'queued', runId: 4 as JobView['runId'] })], ctx())
    expect(select().disabled).toBe(true)
    expect(document.body.textContent).toContain('Take it out of the batch to edit it.')
  })
})

describe('PresetSelect helpers', () =>
{
  it('finds the one recipe a selection shares, album letters aside', () =>
  {
    const a = job({ ...loudness('ebu-r128'), albumGroupId: 'A' } as Recipe)
    const b = job({ ...loudness('ebu-r128'), albumGroupId: 'B' } as Recipe)
    expect(sharedRecipe([a, b])).toBe(a.recipe)
    expect(sharedRecipe([a, job(loudness('spotify'))])).toBeNull()
    expect(sharedRecipe([])).toBeNull()
  })

  it('stores a recipe without its preset reference or album letter', () =>
  {
    const recipe = { ...loudness('ebu-r128'), albumGroupId: 'A', userPreset: { id: 'u', name: 'U' } } as Recipe
    const stored = presetRecipe(recipe) as Recipe & { albumGroupId: string | null }
    expect(stored.userPreset).toBeNull()
    expect(stored.albumGroupId).toBeNull()
    const gain = presetRecipe(applyGainPreset('gentle-lift', OUT) as Recipe)
    expect(gain.kind).toBe('boost')
  })

  it('restates blocking consequences once applied', () =>
  {
    expect(nowBlocked('8 of 38 have no video stream; Compress needs one, so they would be blocked.')).toBe('8 of 38 have no video stream; Compress needs one, so they are now blocked.')
    expect(nowBlocked('Opus holds 8 channels. 1 of the selected jobs would be blocked.')).toBe('Opus holds 8 channels. 1 of the selected jobs is now blocked.')
    expect(nowBlocked('take.wav has no audio. It would be blocked.')).toBe('take.wav has no audio. It is now blocked.')
    expect(appliedNote([])).toBeNull()
    expect(appliedNote([
      { code: 'no-video-stream', severity: 'info', count: 1, text: 'Their outputs will be audio only.' },
      { code: 'no-audio-stream', severity: 'error', count: 2, text: 'No audio. 2 of the selected jobs would be blocked.' }
    ] as never)).toBe('No audio. 2 of the selected jobs are now blocked.')
  })
})

describe('preset names and pin keys', () =>
{
  const late = userPreset('user-late', 'Late podcasts', loudness('streaming-r128s2'))

  it('takes 1 to 60 characters, unique per operation', () =>
  {
    expect(presetNameError('   ', 'normalize', [])).toBe(NAME_LENGTH_ERROR)
    expect(presetNameError('x'.repeat(61), 'normalize', [])).toBe(NAME_LENGTH_ERROR)
    expect(presetNameError('x'.repeat(60), 'normalize', [])).toBeNull()
    expect(presetNameError(' late PODCASTS ', 'normalize', [late])).toBe('A preset named late PODCASTS already exists. Choose another name, or update it from the preset menu.')
    expect(presetNameError('Late podcasts', 'boost', [late])).toBeNull()
    expect(presetNameError('Late podcasts', 'normalize', [late], 'user-late')).toBeNull()
  })

  it('names a taken key by its holder', () =>
  {
    const state = presets({ user: [late], pins: { ...DEFAULT_PINS, '9': 'user-late' } })
    expect(pinLabel(state, '4', 'win32' as never)).toBe('Alt+4 (Gentle lift)')
    expect(pinLabel(state, '9', 'win32' as never)).toBe('Alt+9 (Late podcasts)')
    const free = presets({ pins: {} })
    expect(pinOptions(free, 'win32' as never).map((option) => option.label)).toEqual(['None', 'Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9'])
  })

  it('checks the name inline, saves with the chosen key, and cancels on Escape', async () =>
  {
    const onSubmit = vi.fn(async () => null)
    const onCancel = vi.fn()
    render(<SavePresetRow initialName='Streaming (EBU R 128 s2), edited' op='normalize' presets={presets({ user: [late] })} onSubmit={onSubmit} onCancel={onCancel} />)
    const name = screen.getByLabelText('Preset name') as HTMLInputElement
    expect(name.value).toBe('Streaming (EBU R 128 s2), edited')
    expect(document.activeElement).toBe(name)
    fireEvent.change(name, { target: { value: 'Late podcasts' } })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Save preset' }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('A preset named Late podcasts already exists. Choose another name, or update it from the preset menu.')).toBeTruthy()
    fireEvent.change(name, { target: { value: 'Night shift' } })
    expect(name.getAttribute('aria-invalid')).toBe('false')
    fireEvent.change(screen.getByLabelText('Pin to number'), { target: { value: '4' } })
    await act(async () =>
    {
      fireEvent.submit(name.form as HTMLFormElement)
    })
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Night shift', pin: 4 })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal inline and renames without a pin key', async () =>
  {
    const onSubmit = vi.fn(async () => 'The preset file could not be written.')
    render(<SavePresetRow mode='rename' initialName='Late podcasts' presetId='user-late' op='normalize' presets={presets({ user: [late] })} onSubmit={onSubmit} onCancel={() => undefined} />)
    expect(screen.queryByLabelText('Pin to number')).toBeNull()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Rename preset' }))
    })
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Late podcasts', pin: null })
    expect(screen.getByText('The preset file could not be written.')).toBeTruthy()
  })
})

describe('Save as preset and the preset actions menu', () =>
{
  const late = userPreset('user-late', 'Late podcasts', edited('streaming-r128s2', -17))

  function savedReply(name: string, req: unknown): unknown
  {
    if (name === 'savePreset')
    {
      const request = req as { id: string | null; name: string; recipe: Recipe }
      return { preset: { id: request.id ?? 'user-new', name: request.name, recipe: request.recipe, createdAt: 2, updatedAt: 2 }, unpinned: request.id === null ? 'gentle-lift' : null }
    }
    return name === 'setPin' ? { unpinned: null } : null
  }

  function keyMenu(): HTMLElement
  {
    return document.querySelector('[role="menu"][aria-label="Pin to number"]') as HTMLElement
  }

  function openMenu(): HTMLElement
  {
    fireEvent.click(screen.getByRole('button', { name: 'Preset actions' }))
    return document.querySelector('[role="menu"][aria-label="Preset actions"]') as HTMLElement
  }

  it('saves an edited recipe inline, points the jobs at the new preset, and names a moved pin', async () =>
  {
    const show = vi.spyOn(toast, 'show')
    const jobs = [job({ ...edited('streaming-r128s2', -17), albumGroupId: 'A' } as Recipe), job(edited('streaming-r128s2', -17))]
    const actions = renderSelect(jobs, ctx(), 'normalize', spies(savedReply))
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }))
    const name = screen.getByLabelText('Preset name') as HTMLInputElement
    expect(name.value).toBe('Streaming (EBU R 128 s2), edited')
    expect(document.activeElement).toBe(name)
    fireEvent.change(name, { target: { value: 'Late podcasts' } })
    fireEvent.change(screen.getByLabelText('Pin to number'), { target: { value: '4' } })
    await act(async () =>
    {
      fireEvent.submit(name.form as HTMLFormElement)
    })
    const [command, request] = actions.send.mock.calls[0]
    expect(command).toBe('savePreset')
    expect(request).toMatchObject({ id: null, name: 'Late podcasts', pin: 4 })
    expect(request.recipe.userPreset).toBeNull()
    expect(request.recipe.albumGroupId).toBeNull()
    const [assignments, options] = actions.assignRecipes.mock.calls[0]
    expect(options).toEqual({ field: 'Preset' })
    expect(assignments.map((entry: { recipe: Recipe }) => entry.recipe.userPreset)).toEqual([{ id: 'user-new', name: 'Late podcasts' }, { id: 'user-new', name: 'Late podcasts' }])
    expect(assignments[0].recipe.albumGroupId).toBe('A')
    expect(show).toHaveBeenCalledWith({ tone: 'success', title: 'Saved preset Late podcasts.', body: 'Saved preset Late podcasts on Alt+4. Gentle lift is no longer pinned.' })
    expect(screen.queryByLabelText('Preset name')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save as preset…' }))
  })

  it('cancels the row with Escape and returns focus to the button', () =>
  {
    renderSelect([job(edited('streaming-r128s2', -17))], ctx())
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }))
    fireEvent.keyDown(screen.getByLabelText('Preset name'), { key: 'Escape' })
    expect(screen.queryByLabelText('Preset name')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save as preset…' }))
  })

  it('offers Save as preset only for an edited or custom recipe, and explains why different recipes cannot be saved', () =>
  {
    renderSelect([job(loudness('ebu-r128'))], ctx())
    expect(screen.queryByRole('button', { name: 'Save as preset…' })).toBeNull()
    cleanup()
    renderSelect([job(loudness('custom'))], ctx())
    expect(screen.getByRole('button', { name: 'Save as preset…' }).getAttribute('aria-disabled')).toBeNull()
    cleanup()
    renderSelect([job(edited('streaming-r128s2', -17)), job(edited('streaming-r128s2', -19))], ctx())
    const button = screen.getByRole('button', { name: 'Save as preset…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByText('Select jobs with the same settings to save them as a preset.').length).toBeGreaterThan(0)
    fireEvent.click(button)
    expect(screen.queryByLabelText('Preset name')).toBeNull()
  })

  it('resets edited jobs to their preset from the menu', async () =>
  {
    const actions = renderSelect([job(edited('streaming-r128s2', -17))], ctx())
    const menu = openMenu()
    await act(async () =>
    {
      fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: 'Reset to Streaming (EBU R 128 s2)' }))
    })
    const [assignments, options] = actions.assignRecipes.mock.calls[0]
    expect(assignments[0].recipe.target.integratedLufs).toBe(-18)
    expect(options).toEqual({ toast: { kind: 'applied', preset: 'Streaming (EBU R 128 s2)', note: null } })
  })

  it('updates, renames, and deletes a user preset, noting that jobs keep their settings', async () =>
  {
    const context = ctx({ presets: presets({ user: [late] }) })
    const actions = renderSelect([job(withUser(edited('streaming-r128s2', -16), late))], context, 'normalize', spies(savedReply))
    let menu = openMenu()
    await act(async () =>
    {
      fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: /^Update Late podcasts with these settings/ }))
    })
    expect(actions.send.mock.calls[0][0]).toBe('savePreset')
    expect(actions.send.mock.calls[0][1]).toMatchObject({ id: 'user-late', name: 'Late podcasts', pin: null })
    expect(screen.getByRole('status').textContent).toBe('Jobs already in the queue keep their settings.')
    menu = openMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: /^Rename Late podcasts/ }))
    const name = screen.getByLabelText('Preset name') as HTMLInputElement
    expect(name.value).toBe('Late podcasts')
    fireEvent.change(name, { target: { value: 'Early podcasts' } })
    await act(async () =>
    {
      fireEvent.submit(name.form as HTMLFormElement)
    })
    expect(actions.send.mock.calls[1]).toEqual(['renamePreset', { id: 'user-late', name: 'Early podcasts' }])
    expect(screen.queryByLabelText('Preset name')).toBeNull()
    menu = openMenu()
    await act(async () =>
    {
      fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: /^Delete Late podcasts/ }))
    })
    expect(actions.send.mock.calls[2]).toEqual(['removePreset', { id: 'user-late' }])
    expect(screen.getByRole('status').textContent).toBe('Jobs already in the queue keep their settings.')
  })

  it('pins the preset to a number and unpins it', async () =>
  {
    const actions = renderSelect([job(loudness('ebu-r128'))], ctx(), 'normalize', spies(savedReply))
    let menu = openMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: 'Pin to number' }))
    const keysMenu = keyMenu()
    const radios = within(keysMenu).getAllByRole('menuitemradio', { hidden: true })
    expect(radios.map((item) => item.textContent)).toContain('Alt+4 (Gentle lift)')
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    await act(async () =>
    {
      fireEvent.click(radios[8])
    })
    expect(actions.send.mock.calls[0]).toEqual(['setPin', { key: 9, presetId: 'ebu-r128' }])
    menu = openMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: 'Pin to number' }))
    await act(async () =>
    {
      fireEvent.click(within(keyMenu()).getByRole('menuitem', { hidden: true, name: 'Unpin' }))
    })
    expect(actions.send.mock.calls[1]).toEqual(['setPin', { key: 1, presetId: null }])
  })

  it('shows a refused command in the status line', async () =>
  {
    const actions = spies()
    actions.send = vi.fn(async () => ({ status: 'refused', code: 'nothing', message: 'The preset no longer exists.' }))
    renderSelect([job(withUser(loudness('streaming-r128s2'), late))], ctx({ presets: presets({ user: [late] }) }), 'normalize', actions)
    const menu = openMenu()
    await act(async () =>
    {
      fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: /^Delete Late podcasts/ }))
    })
    expect(screen.getByRole('status').textContent).toBe('The preset no longer exists.')
  })
})

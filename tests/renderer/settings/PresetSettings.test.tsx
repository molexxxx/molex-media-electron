/**
 * Settings, Presets: the user's presets by operation with their values in plain words, the empty state, Rename and
 * Delete and the pinned keys through the engine's preset commands (never config:save), and the built-in presets,
 * read-only, with their standard and sources.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LOUDNESS_PRESETS, applyGainPreset, applyLoudnessPreset, type LoudnessPreset } from '../../../src/shared/audio/presets'
import type { JobsApi } from '../../../src/shared/jobs/contract'
import { describeRecipe } from '../../../src/shared/jobs/describe'
import { CONVERT_PRESETS, EARLIER_DEFAULT_PRESET } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { PresetState, UserPreset } from '../../../src/shared/jobs/types'
import { initialJobsState, useJobsStore } from '../../../src/renderer/src/stores/jobs'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'
import
{
  PRESET_WORDS,
  PresetSettings,
  commandFailure,
  deleteQuestion,
  builtinRowId,
  loudnessValues,
  pinChoices,
  pinsIntro,
  presetsByOperation,
  windowJobs
} from '../../../src/renderer/src/components/settings/tabs/PresetSettings'

const SAME = { kind: 'same-as-source' } as const

function user(id: string, name: string, recipe: Recipe): UserPreset
{
  return { id, name, recipe: { ...recipe, userPreset: null }, createdAt: 1, updatedAt: 1 }
}

const EARLIER = user(EARLIER_DEFAULT_PRESET.id, EARLIER_DEFAULT_PRESET.name, applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'aac', kbpsPerPair: 192 }) as Recipe)
const PODCAST = user('user-podcast', 'Podcast master', applyLoudnessPreset('apple-podcasts', SAME) as Recipe)
const LIFT = user('user-lift', 'Lift a little', applyGainPreset('gentle-lift', SAME) as Recipe)
const WEB = user('user-web', 'Web copy', { ...CONVERT_PRESETS[0].recipe } as Recipe)

function state(users: UserPreset[], pins: PresetState['pins'] = {}): PresetState
{
  return { user: users, pins, recent: [] }
}

interface FakeJobs
{
  api: JobsApi
  renamePreset: ReturnType<typeof vi.fn>
  removePreset: ReturnType<typeof vi.fn>
  setPin: ReturnType<typeof vi.fn>
  savePreset: ReturnType<typeof vi.fn>
}

/** A jobs API that answers the preset commands and publishes presets.changed into the store, as the engine does. */
function fakeJobs(): FakeJobs
{
  const publish = (next: PresetState): void => useJobsStore.setState({ presets: next })
  const current = (): PresetState => useJobsStore.getState().presets ?? state([])
  const renamePreset = vi.fn(async (req: { id: string; name: string }) =>
  {
    const presets = current()
    const renamed = presets.user.map((entry) => entry.id === req.id ? { ...entry, name: req.name } : entry)
    publish({ ...presets, user: renamed })
    return { ok: true, value: renamed.find((entry) => entry.id === req.id), seq: 2 }
  })
  const removePreset = vi.fn(async (req: { id: string }) =>
  {
    const presets = current()
    const pins = Object.fromEntries(Object.entries(presets.pins).filter(([, id]) => id !== req.id))
    publish({ ...presets, user: presets.user.filter((entry) => entry.id !== req.id), pins })
    return { ok: true, value: null, seq: 3 }
  })
  const setPin = vi.fn(async (req: { key: number; presetId: string | null }) =>
  {
    const presets = current()
    const key = String(req.key) as keyof PresetState['pins']
    const unpinned = presets.pins[key] ?? null
    const pins = { ...presets.pins }
    for (const [slot, id] of Object.entries(pins))
    {
      if (id === req.presetId)
      {
        delete pins[slot as keyof PresetState['pins']]
      }
    }
    if (req.presetId === null)
    {
      delete pins[key]
    }
    else
    {
      pins[key] = req.presetId
    }
    publish({ ...presets, pins })
    return { ok: true, value: { unpinned }, seq: 4 }
  })
  const savePreset = vi.fn()
  return { api: { renamePreset, removePreset, setPin, savePreset } as unknown as JobsApi, renamePreset, removePreset, setPin, savePreset }
}

let jobs: FakeJobs
let saveConfig: ReturnType<typeof vi.fn>

function renderTab(): ReturnType<typeof render>
{
  return render(
    <PlatformProvider platform='win32'>
      <PresetSettings />
    </PlatformProvider>
  )
}

beforeEach(() =>
{
  jobs = fakeJobs()
  saveConfig = vi.fn()
  vi.stubGlobal('api', { jobs: jobs.api, saveConfig })
  useJobsStore.setState(initialJobsState())
})

afterEach(() =>
{
  cleanup()
  vi.unstubAllGlobals()
  useJobsStore.setState(initialJobsState())
})

describe('presetsByOperation', () =>
{
  it('groups user presets in operation order and sorts each group by name', () =>
  {
    const second = user('user-b', 'Broadcast', applyLoudnessPreset('ebu-r128', SAME) as Recipe)
    const groups = presetsByOperation([WEB, PODCAST, LIFT, second])
    expect(groups.map((group) => group.op)).toEqual(['normalize', 'boost', 'convert'])
    expect(groups[0].presets.map((preset) => preset.name)).toEqual(['Broadcast', 'Podcast master'])
  })

  it('answers no groups for no presets', () =>
  {
    expect(presetsByOperation([])).toEqual([])
  })
})

describe('deleteQuestion and commandFailure', () =>
{
  it('names the key a pinned preset frees', () =>
  {
    expect(deleteQuestion(PODCAST, null, '')).toBe('Delete Podcast master? Jobs that use it keep their settings.')
    expect(deleteQuestion(PODCAST, '3', 'Alt+3')).toBe('Delete Podcast master? Jobs that use it keep their settings. Alt+3 is no longer pinned.')
  })

  it('reads the failure message of a refused command', () =>
  {
    expect(commandFailure({ ok: true })).toBeNull()
    expect(commandFailure({ ok: false, error: { message: 'That preset no longer exists.' } })).toBe('That preset no longer exists.')
  })

  it('finds the preload jobs surface, or none', () =>
  {
    expect(windowJobs()).toBe(jobs.api)
    vi.stubGlobal('api', undefined)
    expect(windowJobs()).toBeNull()
  })
})

describe('PresetSettings, your presets', () =>
{
  it('says presets appear when the engine connects before the first snapshot', () =>
  {
    renderTab()
    expect(screen.getByText(PRESET_WORDS.loading)).toBeInTheDocument()
  })

  it('says how to save a preset from the Batch inspector when there are none', () =>
  {
    useJobsStore.setState({ presets: state([]) })
    renderTab()
    expect(screen.getByText(PRESET_WORDS.empty)).toBeInTheDocument()
    expect(screen.getByText(PRESET_WORDS.emptyHow)).toHaveTextContent(/Batch inspector|inspector/)
  })

  it('lists the presets by operation with their values in plain words, Earlier default included', () =>
  {
    useJobsStore.setState({ presets: state([EARLIER, PODCAST, LIFT, WEB], { '2': PODCAST.id }) })
    renderTab()
    const normalize = screen.getByRole('list', { name: 'Normalize presets' })
    expect(within(normalize).getByText('Earlier default')).toBeInTheDocument()
    expect(within(normalize).getByText(PRESET_WORDS.earlierDefault)).toBeInTheDocument()
    expect(within(normalize).getByText(describeRecipe(EARLIER.recipe))).toBeInTheDocument()
    expect(within(normalize).getByText('Podcast master')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Gain presets' })).toHaveTextContent('Lift a little')
    expect(screen.getByRole('list', { name: 'Convert presets' })).toHaveTextContent('Web copy')
    const podcastRow = within(normalize).getByText('Podcast master').closest('li') as HTMLElement
    expect(podcastRow).toHaveTextContent('Alt')
  })

  it('renames through presets:rename and follows the presets.changed event', async () =>
  {
    useJobsStore.setState({ presets: state([PODCAST]) })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Podcast master' }))
    const field = screen.getByLabelText(PRESET_WORDS.nameLabel)
    fireEvent.change(field, { target: { value: 'Show master' } })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.save }))
    })
    expect(jobs.renamePreset).toHaveBeenCalledWith({ id: PODCAST.id, name: 'Show master' })
    expect(screen.getByText('Show master')).toBeInTheDocument()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('refuses an empty or clashing name before any command', async () =>
  {
    const other = user('user-other', 'Broadcast', applyLoudnessPreset('ebu-r128', SAME) as Recipe)
    useJobsStore.setState({ presets: state([PODCAST, other]) })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Podcast master' }))
    const field = screen.getByLabelText(PRESET_WORDS.nameLabel)
    fireEvent.change(field, { target: { value: '  ' } })
    await act(async () =>
    {
      fireEvent.submit(field.closest('form') as HTMLFormElement)
    })
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: 'broadcast' } })
    await act(async () =>
    {
      fireEvent.submit(field.closest('form') as HTMLFormElement)
    })
    expect(screen.getByText(/A preset named broadcast already exists/)).toBeInTheDocument()
    expect(jobs.renamePreset).not.toHaveBeenCalled()
  })

  it('closes Rename without a command when the name is unchanged or on Escape', async () =>
  {
    useJobsStore.setState({ presets: state([PODCAST]) })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Podcast master' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.save }))
    })
    expect(screen.queryByLabelText(PRESET_WORDS.nameLabel)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Podcast master' }))
    fireEvent.keyDown(screen.getByLabelText(PRESET_WORDS.nameLabel), { key: 'Escape' })
    expect(screen.queryByLabelText(PRESET_WORDS.nameLabel)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Podcast master' }))
    fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.cancel }))
    expect(screen.queryByLabelText(PRESET_WORDS.nameLabel)).toBeNull()
    expect(jobs.renamePreset).not.toHaveBeenCalled()
  })

  it('shows a refused rename and keeps the field open', async () =>
  {
    jobs.renamePreset.mockResolvedValueOnce({ ok: false, error: { code: 'not-found', message: 'That preset no longer exists.', issues: [], details: null } })
    useJobsStore.setState({ presets: state([PODCAST]) })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Podcast master' }))
    fireEvent.change(screen.getByLabelText(PRESET_WORDS.nameLabel), { target: { value: 'Other' } })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.save }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('That preset no longer exists.')
    expect(screen.getByLabelText(PRESET_WORDS.nameLabel)).toBeInTheDocument()
  })

  it('deletes through presets:remove after the inline confirmation, and Keep cancels', async () =>
  {
    useJobsStore.setState({ presets: state([PODCAST, LIFT], { '4': PODCAST.id }) })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Podcast master' }))
    expect(screen.getByText(/Alt\+4 is no longer pinned/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.keep }))
    expect(jobs.removePreset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Podcast master' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.remove }))
    })
    expect(jobs.removePreset).toHaveBeenCalledWith({ id: PODCAST.id })
    expect(screen.queryByText('Podcast master')).toBeNull()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('says the engine is not connected when the preload has no jobs surface', async () =>
  {
    vi.stubGlobal('api', {})
    useJobsStore.setState({ presets: state([PODCAST]) })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Podcast master' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: PRESET_WORDS.remove }))
    })
    expect(screen.getByRole('status')).toHaveTextContent(PRESET_WORDS.loading)
  })
})

describe('pinChoices and pinsIntro', () =>
{
  it('offers none, the user presets, then every operation of built-in presets', () =>
  {
    const choices = pinChoices([PODCAST, LIFT])
    expect(choices[0]).toEqual({ value: 'none', label: PRESET_WORDS.noPin })
    expect(choices[1]).toMatchObject({ group: 'Your presets' })
    expect((choices[1] as { options: Array<{ label: string }> }).options.map((option) => option.label)).toEqual(['Lift a little · Gain', 'Podcast master · Normalize'])
    expect(choices.slice(2).map((choice) => (choice as { group: string }).group)).toEqual(['Normalize', 'Gain', 'Convert', 'Compress', 'Extract'])
    expect(pinChoices([]).slice(1).map((choice) => (choice as { group: string }).group)[0]).toBe('Normalize')
  })

  it('writes the platform keys', () =>
  {
    expect(pinsIntro('win32')).toMatch(/^Alt\+1 to Alt\+9 apply/)
    expect(pinsIntro('darwin')).toMatch(/^Option\+1 to Option\+9 apply/)
  })
})

describe('PresetSettings, pinned keys', () =>
{
  it('shows the preset each key holds and moves a key through presets:setPin', async () =>
  {
    useJobsStore.setState({ presets: state([PODCAST], { '1': 'ebu-r128', '2': PODCAST.id }) })
    renderTab()
    const first = screen.getByRole('combobox', { name: 'Alt+1 applies' }) as HTMLSelectElement
    expect(first.value).toBe('ebu-r128')
    expect((screen.getByRole('combobox', { name: 'Alt+3 applies' }) as HTMLSelectElement).value).toBe('none')
    await act(async () =>
    {
      fireEvent.change(screen.getByRole('combobox', { name: 'Alt+3 applies' }), { target: { value: PODCAST.id } })
    })
    expect(jobs.setPin).toHaveBeenCalledWith({ key: 3, presetId: PODCAST.id })
    expect((screen.getByRole('combobox', { name: 'Alt+3 applies' }) as HTMLSelectElement).value).toBe(PODCAST.id)
    expect((screen.getByRole('combobox', { name: 'Alt+2 applies' }) as HTMLSelectElement).value).toBe('none')
    await act(async () =>
    {
      fireEvent.change(first, { target: { value: 'none' } })
    })
    expect(jobs.setPin).toHaveBeenLastCalledWith({ key: 1, presetId: null })
    expect(saveConfig).not.toHaveBeenCalled()
  })
})

describe('PresetSettings, built-in presets', () =>
{
  it('lists the loudness presets read-only with their standard, values, and sources', () =>
  {
    useJobsStore.setState({ presets: state([]) })
    renderTab()
    const list = screen.getByRole('list', { name: 'Built-in Normalize presets' })
    const r128 = document.getElementById(builtinRowId('normalize', 'ebu-r128')) as HTMLElement
    const ebu = LOUDNESS_PRESETS.find((preset) => preset.id === 'ebu-r128') as LoudnessPreset
    expect(r128).toHaveTextContent(loudnessValues(ebu))
    expect(r128).toHaveTextContent(PRESET_WORDS.standard)
    expect(r128).toHaveTextContent('Delivering to a European TV or radio broadcaster')
    expect(document.getElementById(builtinRowId('normalize', 'night'))).toHaveTextContent(PRESET_WORDS.notStandard)
    expect(document.getElementById(builtinRowId('normalize', 'aes-streaming'))).toHaveTextContent(PRESET_WORDS.superseded)
    expect(within(list).queryByText('Custom')).toBeNull()
    expect(within(r128).queryByRole('button', { name: 'Emphasize dialog' })).toBeNull()
    const toggle = within(r128).getByRole('button', { name: 'Technical details' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const link = within(r128).getByRole('link', { name: ebu.sources[0].name })
    expect(link).toHaveAttribute('href', ebu.sources[0].url)
    expect(within(r128).queryByRole('button', { name: /Rename|Delete/ })).toBeNull()
  })

  it('brings the preset of a chosen goal into view and marks it, per operation', () =>
  {
    renderTab()
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    onTestFinished(() =>
    {
      Element.prototype.scrollIntoView = original
    })
    fireEvent.click(within(screen.getByRole('list', { name: 'Normalize goals' })).getByRole('button', { name: /Dialogue too quiet/ }))
    const night = document.getElementById(builtinRowId('normalize', 'night')) as HTMLElement
    expect(night).toHaveAttribute('data-highlighted')
    expect(document.activeElement).toBe(night)
    expect(scroll).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Compress' }))
    expect(screen.getByRole('list', { name: 'Compress goals' })).toBeInTheDocument()
    expect(document.querySelector('[data-highlighted]')).toBeNull()
  })

  it('switches to the gain presets and the media catalogs by group', () =>
  {
    renderTab()
    fireEvent.click(screen.getByRole('radio', { name: 'Gain' }))
    expect(screen.getByRole('list', { name: 'Built-in Gain presets' })).toHaveTextContent(describeRecipe({ ...applyGainPreset('gentle-lift', SAME), userPreset: null } as Recipe))
    fireEvent.click(screen.getByRole('radio', { name: 'Convert' }))
    const convert = screen.getByRole('group', { name: 'Built-in Convert presets' })
    expect(within(convert).getByRole('list', { name: `${CONVERT_PRESETS[0].group} presets` })).toHaveTextContent(CONVERT_PRESETS[0].label)
    expect(convert).toHaveTextContent(CONVERT_PRESETS[0].description)
  })

  it('never offers a loudness target, true peak, LRA, policy, codec, or bitrate field', () =>
  {
    useJobsStore.setState({ presets: state([EARLIER]) })
    const { container } = renderTab()
    expect(container.querySelectorAll('input[type="number"], [role="spinbutton"], [role="slider"]')).toHaveLength(0)
    expect(screen.queryByText(/Loudness range|Bitrate|Output codec|cannot be reached/i)).toBeNull()
  })
})

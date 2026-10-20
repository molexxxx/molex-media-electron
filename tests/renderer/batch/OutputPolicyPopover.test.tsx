/**
 * The Output popover and its file name field: folders are trimmed and unquoted and validated by main on commit with
 * the refusal inline, Replace hides the folder and keeps the template for Extract jobs, "Save as default" is never
 * offered for Replace, the preview resolves a real job through the shared renderer, and a running batch locks it all.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { applyLoudnessPreset } from '../../../src/shared/audio/presets'
import { formatCatalog, formatRunId } from '../../../src/shared/jobs/ids'
import type { CommandResult } from '../../../src/shared/jobs/contract'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { BatchPolicy, JobView, PlanSummary } from '../../../src/shared/jobs/types'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import
{
  cleanFolderInput,
  defaultTemplateFor,
  OUTPUT_COPY,
  OutputPolicyPanel,
  OutputPolicyPopover,
  outputLockedMessage,
  previewJobOf,
  templateForMode
} from '../../../src/renderer/src/components/batch/header/OutputPolicyPopover'
import
{
  extensionOf,
  hasLeadingToken,
  insertToken,
  namesEachOutput,
  previewPath,
  SHARED_NAME_WARNING,
  TEMPLATE_FIELDS,
  templateMessages,
  withLeadingToken
} from '../../../src/renderer/src/components/batch/header/NameTemplateField'

const OUT = { kind: 'same-as-source' } as const
const DATE = new Date(2026, 9, 18, 12).getTime()

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

function normalize(): Recipe
{
  return applyLoudnessPreset('ebu-r128', OUT) as Recipe
}

function policy(over: Partial<BatchPolicy> = {}): BatchPolicy
{
  return {
    rev: 1,
    destination: { mode: 'folder', folder: 'D:\\Exports' },
    template: '{name}',
    conflict: 'rename',
    displaced: 'trash',
    gpu: 'auto',
    ...over
  }
}

function job(over: Partial<JobView> = {}): JobView
{
  return {
    id: formatCatalog(142),
    seq: 142,
    rev: 1,
    inputsRev: 1,
    source: { path: 'D:\\Rips\\Live\\take-1.flac', name: 'take-1.flac', ext: '.flac', dir: 'D:\\Rips\\Live', size: 1_000_000, mtimeMs: 0, origin: 'folder', subdir: 'Live' },
    recipe: normalize(),
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
    plan: { finalName: 'take-1.wav' } as PlanSummary,
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
    ...over
  } as JobView
}

type SetPolicyRequest = { policy: Omit<BatchPolicy, 'rev'> }

function accepting(): ReturnType<typeof vi.fn<(req: SetPolicyRequest) => Promise<CommandResult<{ policy: BatchPolicy; demoted: never[] }>>>>
{
  return vi.fn(async (req: SetPolicyRequest) => ({ ok: true as const, value: { policy: { ...req.policy, rev: 2 }, demoted: [] }, seq: 1 }))
}

function refusing(message: string): ReturnType<typeof vi.fn>
{
  return vi.fn(async () => ({ ok: false as const, error: { code: 'invalid-payload' as const, message, issues: [], details: null } }))
}

interface PanelOptions
{
  setPolicy?: ReturnType<typeof vi.fn>
  policy?: BatchPolicy
  locked?: boolean
  previewJob?: JobView | null
  browse?: () => Promise<string | null>
  onSaveDefault?: (input: Omit<BatchPolicy, 'rev'>) => Promise<boolean>
}

function panel(options: PanelOptions = {}): { setPolicy: ReturnType<typeof vi.fn>; rerender: (next: PanelOptions) => void }
{
  const setPolicy = options.setPolicy ?? accepting()
  const tree = (next: PanelOptions): React.JSX.Element => (
    <TestBatchActionsProvider api={{ setPolicy } as never}>
      <OutputPolicyPanel
        policy={next.policy ?? policy()}
        locked={next.locked ?? false}
        runId={formatRunId(31)}
        previewJob={next.previewJob === undefined ? job() : next.previewJob}
        platform="win32"
        browse={next.browse}
        onSaveDefault={next.onSaveDefault}
        now={() => DATE}
      />
    </TestBatchActionsProvider>
  )
  const { rerender } = render(tree(options))
  return { setPolicy, rerender: (next) => rerender(tree({ ...options, ...next })) }
}

function sent(setPolicy: ReturnType<typeof vi.fn>, call = 0): Omit<BatchPolicy, 'rev'>
{
  return (setPolicy.mock.calls[call][0] as SetPolicyRequest).policy
}

describe('folder input', () =>
{
  it('trims and unquotes a pasted or typed folder', () =>
  {
    expect(cleanFolderInput('  "D:\\Exports\\Podcasts"  ')).toBe('D:\\Exports\\Podcasts')
    expect(cleanFolderInput('\'/Users/me/Out\'')).toBe('/Users/me/Out')
    expect(cleanFolderInput('" "E:\\A" "')).toBe('E:\\A')
    expect(cleanFolderInput('"')).toBe('"')
    expect(cleanFolderInput('D:\\Plain')).toBe('D:\\Plain')
  })

  it('moves a template still at its default to the new destination\'s default and keeps an edited one', () =>
  {
    expect(defaultTemplateFor('folder')).toBe('{name}')
    expect(defaultTemplateFor('replace-originals')).toBe('{name}-{op}')
    expect(templateForMode('{name}', 'folder', 'next-to-source')).toBe('{name}-{op}')
    expect(templateForMode('{name}-{op}', 'replace-originals', 'folder')).toBe('{name}')
    expect(templateForMode('{catalog} {name}', 'folder', 'replace-originals')).toBe('{catalog} {name}')
  })

  it('names the batch that holds the lock', () =>
  {
    expect(outputLockedMessage(formatRunId(31))).toBe('Locked while Batch 31 runs. New jobs you review for this batch use the same output. It unlocks when the batch ends.')
    expect(outputLockedMessage(null)).toContain('Locked while the batch runs.')
  })
})

describe('name template helpers', () =>
{
  it('inserts a token at the caret or over the selection', () =>
  {
    expect(insertToken('{name}', 6, 6, 'catalog')).toEqual({ text: '{name}{catalog}', caret: 15 })
    expect(insertToken('a-b', 1, 2, 'op')).toEqual({ text: 'a{op}b', caret: 5 })
    expect(insertToken('ab', 9, -3, 'ext')).toEqual({ text: '{ext}', caret: 5 })
  })

  it('adds and removes leading folders with {preset}/ before {subdir}/', () =>
  {
    expect(withLeadingToken('{name}', 'subdir', true)).toBe('{subdir}/{name}')
    expect(withLeadingToken('{subdir}/{name}', 'preset', true)).toBe('{preset}/{subdir}/{name}')
    expect(withLeadingToken('{preset}\\{subdir}/{name}', 'preset', false)).toBe('{subdir}/{name}')
    expect(hasLeadingToken('{preset}/{subdir}/{name}', 'subdir')).toBe(true)
    expect(hasLeadingToken('{name}/{subdir}/x', 'subdir')).toBe(false)
  })

  it('lists every insertable field with the operation hint', () =>
  {
    expect(TEMPLATE_FIELDS.map((entry) => entry.token)).toEqual(['name', 'ext', 'op', 'preset', 'catalog', 'date', 'subdir'])
    expect(TEMPLATE_FIELDS[2].hint).toBe('normalize, gain, convert, compress, or extract')
  })

  it('resolves a job\'s real path with the shared renderer', () =>
  {
    const preview = previewJobOf(job())
    expect(preview).toMatchObject({ catalog: 'MM-0142', fileName: 'take-1.flac', directory: 'D:\\Rips\\Live', subdir: 'Live', outputExt: 'wav' })
    expect(previewPath('{subdir}/{name}-{op}-{catalog}', preview, { folder: 'D:\\Exports\\', platform: 'win32', date: '2026-10-18' }).path)
      .toBe('D:\\Exports\\Live\\take-1-normalize-MM-0142.wav')
    expect(previewPath('{preset} {date} {ext}', preview, { folder: null, platform: 'linux', date: '2026-10-18' }).path)
      .toBe('D:\\Rips\\Live/ebu-r128 2026-10-18 flac.wav')
    expect(previewPath('{name}', { ...preview, outputExt: null }, { folder: '', platform: 'win32', date: '' }).path).toBe('take-1')
    expect(previewPath('{subdir}', { ...preview, subdir: '' }, { folder: 'D:\\X', platform: 'win32', date: '' }).path).toBeNull()
    expect(previewJobOf(job({ plan: null })).outputExt).toBeNull()
    expect(extensionOf('.hidden')).toBe('')
    expect(extensionOf('a.b.mkv')).toBe('mkv')
  })

  it('reports main\'s refusal first, then the renderer\'s errors and warnings', () =>
  {
    expect(templateMessages('{album}', null, 'win32', null).error).toBe('Unknown token {album} in the file name.')
    expect(templateMessages('../{name}', null, 'win32', null).error).toBe('File names cannot climb out of the folder (..).')
    expect(templateMessages('{name}', null, 'win32', 'molexMedia cannot write to D:\\: access denied.').error).toBe('molexMedia cannot write to D:\\: access denied.')
    expect(templateMessages('{op}', null, 'win32', null)).toEqual({ error: null, notes: [SHARED_NAME_WARNING] })
    expect(templateMessages('{name}:x', null, 'win32', null).notes[0]).toMatch(/replaced with _/)
    expect(namesEachOutput('{catalog}')).toBe(true)
    expect(namesEachOutput('{nam}')).toBe(false)
  })
})

describe('OutputPolicyPanel', () =>
{
  it('shows the three destinations with their descriptions and the folder with Browse', () =>
  {
    panel()
    expect(screen.getByRole('heading', { name: 'Output' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Folder' })).toBeChecked()
    expect(screen.getByText(OUTPUT_COPY.folderDescription)).toBeInTheDocument()
    expect(screen.getByText(OUTPUT_COPY.nextToSourceDescription)).toBeInTheDocument()
    expect(screen.getByText(OUTPUT_COPY.replaceDescription)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('D:\\Exports')
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeEnabled()
    expect(screen.getByText(OUTPUT_COPY.footer)).toBeInTheDocument()
    expect(screen.getByText('+ output extension')).toBeInTheDocument()
  })

  it('sends a typed folder trimmed and unquoted on Enter, and shows nothing when unchanged', async () =>
  {
    const { setPolicy } = panel()
    const folder = screen.getByRole('textbox', { name: 'Folder' })
    fireEvent.keyDown(folder, { key: 'Enter' })
    expect(setPolicy).not.toHaveBeenCalled()
    fireEvent.change(folder, { target: { value: '  "E:\\Podcasts"  ' } })
    await act(async () =>
    {
      fireEvent.keyDown(folder, { key: 'Enter' })
    })
    expect(sent(setPolicy)).toEqual({ destination: { mode: 'folder', folder: 'E:\\Podcasts' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto' })
    expect(folder).toHaveValue('E:\\Podcasts')
  })

  it('unquotes a path pasted over the whole field silently', () =>
  {
    panel()
    const folder = screen.getByRole('textbox', { name: 'Folder' }) as HTMLInputElement
    folder.setSelectionRange(0, folder.value.length)
    fireEvent.paste(folder, { clipboardData: { getData: () => '"F:\\Shows\\Season 1"' } })
    expect(folder).toHaveValue('F:\\Shows\\Season 1')
  })

  it('shows main\'s refusal inline under the folder and clears it on typing', async () =>
  {
    const message = 'The output folder must be a full path, like D:\\Exports.'
    panel({ setPolicy: refusing(message) })
    const folder = screen.getByRole('textbox', { name: 'Folder' })
    fireEvent.change(folder, { target: { value: 'Exports' } })
    await act(async () =>
    {
      fireEvent.blur(folder)
    })
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(folder).toHaveAttribute('aria-invalid', 'true')
    expect(folder).toHaveAccessibleDescription(message)
    fireEvent.change(folder, { target: { value: 'D:\\Exports2' } })
    expect(screen.queryByText(message)).toBeNull()
  })

  it('commits a browsed folder', async () =>
  {
    const browse = vi.fn(async () => '"G:\\Out"')
    const { setPolicy } = panel({ browse })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    })
    expect(sent(setPolicy).destination).toEqual({ mode: 'folder', folder: 'G:\\Out' })
  })

  it('ignores a canceled browse', async () =>
  {
    const { setPolicy } = panel({ browse: async () => null })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    })
    expect(setPolicy).not.toHaveBeenCalled()
  })

  it('switches to Next to each source with the matching default template', async () =>
  {
    const { setPolicy } = panel()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('radio', { name: 'Next to each source' }))
    })
    expect(sent(setPolicy)).toMatchObject({ destination: { mode: 'next-to-source' }, template: '{name}-{op}' })
  })

  it('waits for a folder when Folder is chosen with none known', async () =>
  {
    const { setPolicy } = panel({ policy: policy({ destination: { mode: 'next-to-source' }, template: '{name}-{op}' }) })
    const folder = screen.getByRole('textbox', { name: 'Folder' })
    expect(folder).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Folder' }))
    expect(setPolicy).not.toHaveBeenCalled()
    expect(folder).toBeEnabled()
    fireEvent.change(folder, { target: { value: 'D:\\New' } })
    await act(async () =>
    {
      fireEvent.keyDown(folder, { key: 'Enter' })
    })
    expect(sent(setPolicy)).toMatchObject({ destination: { mode: 'folder', folder: 'D:\\New' }, template: '{name}' })
  })

  it('returns to the remembered folder when Folder is chosen again', async () =>
  {
    const { setPolicy, rerender } = panel()
    rerender({ policy: policy({ rev: 2, destination: { mode: 'next-to-source' }, template: '{name}-{op}' }) })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('radio', { name: 'Folder' }))
    })
    expect(sent(setPolicy)).toMatchObject({ destination: { mode: 'folder', folder: 'D:\\Exports' }, template: '{name}' })
  })

  it('hides the folder in Replace mode with the reason and keeps the template for Extract jobs', () =>
  {
    panel({ policy: policy({ destination: { mode: 'replace-originals' }, template: '{name}-{op}' }) })
    expect(screen.getByRole('radio', { name: 'Replace originals' })).toBeChecked()
    expect(screen.queryByRole('textbox', { name: 'Folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull()
    expect(screen.getByText(OUTPUT_COPY.replaceNote)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'File name for Extract jobs' })).toHaveValue('{name}-{op}')
    expect(screen.getByRole('checkbox', { name: 'Keep old files beside the new ones' })).not.toBeChecked()
    expect(screen.getByText(OUTPUT_COPY.keepOldHint)).toBeInTheDocument()
    expect(screen.getByText('Example: D:\\Rips\\Live\\take-1-normalize.wav')).toBeInTheDocument()
  })

  it('never offers Replace originals as a saved default', async () =>
  {
    const onSaveDefault = vi.fn(async () => true)
    panel({ policy: policy({ destination: { mode: 'replace-originals' }, template: '{name}-{op}' }), onSaveDefault })
    const save = screen.getByRole('button', { name: 'Save as default' })
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(save).toHaveAccessibleDescription(expect.stringContaining(OUTPUT_COPY.saveDefaultReplace))
    await act(async () =>
    {
      fireEvent.click(save)
    })
    expect(onSaveDefault).not.toHaveBeenCalled()
  })

  it('saves a folder policy as the default through main and says so', async () =>
  {
    const { setPolicy } = panel()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Save as default' }))
    })
    expect(sent(setPolicy)).toMatchObject({ destination: { mode: 'folder', folder: 'D:\\Exports' } })
    expect(screen.getByText(OUTPUT_COPY.saved)).toBeInTheDocument()
  })

  it('hands Save as default to the page when it supplies one', async () =>
  {
    const onSaveDefault = vi.fn(async () => false)
    const { setPolicy } = panel({ onSaveDefault })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Save as default' }))
    })
    expect(onSaveDefault).toHaveBeenCalledWith(expect.objectContaining({ template: '{name}' }))
    expect(setPolicy).not.toHaveBeenCalled()
    expect(screen.queryByText(OUTPUT_COPY.saved)).toBeNull()
  })

  it('shows the conflict hint and offers Keep old files only with Overwrite', async () =>
  {
    const { setPolicy, rerender } = panel()
    expect(screen.getAllByText('Adds (2), (3), and so on to the new file\'s name.').length).toBeGreaterThan(0)
    expect(screen.queryByRole('checkbox', { name: 'Keep old files beside the new ones' })).toBeNull()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('radio', { name: 'Skip' }))
    })
    expect(sent(setPolicy).conflict).toBe('skip')
    rerender({ policy: policy({ rev: 3, conflict: 'overwrite' }) })
    expect(screen.getAllByText('Replaces the existing file after the output verifies; the old file goes to the Recycle Bin.').length).toBeGreaterThan(0)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Keep old files beside the new ones' }))
    })
    expect(sent(setPolicy, 1).displaced).toBe('keep')
    rerender({ policy: policy({ rev: 4, conflict: 'overwrite', displaced: 'keep' }) })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Keep old files beside the new ones' }))
    })
    expect(sent(setPolicy, 2).displaced).toBe('trash')
  })

  it('previews the focused job\'s real name and follows typing before the commit', async () =>
  {
    const { setPolicy } = panel()
    expect(screen.getByText('Example: D:\\Exports\\take-1.wav')).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'File name' })
    expect(name).toHaveAccessibleDescription('Example: D:\\Exports\\take-1.wav')
    fireEvent.change(name, { target: { value: '{catalog} {name}' } })
    expect(screen.getByText('Example: D:\\Exports\\MM-0142 take-1.wav')).toBeInTheDocument()
    expect(setPolicy).not.toHaveBeenCalled()
    await act(async () =>
    {
      fireEvent.keyDown(name, { key: 'Enter' })
    })
    expect(sent(setPolicy).template).toBe('{catalog} {name}')
  })

  it('shows no example without a job and the renderer\'s error inline', () =>
  {
    panel({ previewJob: null })
    expect(screen.queryByText(/^Example:/)).toBeNull()
    const name = screen.getByRole('textbox', { name: 'File name' })
    fireEvent.change(name, { target: { value: '{album}' } })
    expect(screen.getByText('Unknown token {album} in the file name.')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows main\'s refusal of a template inline until the text changes', async () =>
  {
    panel({ setPolicy: refusing('The file name is empty for some jobs; add {name} or {catalog}.') })
    const name = screen.getByRole('textbox', { name: 'File name' })
    fireEvent.change(name, { target: { value: '{subdir}' } })
    await act(async () =>
    {
      fireEvent.blur(name)
    })
    expect(screen.getAllByText('The file name is empty for some jobs; add {name} or {catalog}.').length).toBeGreaterThan(0)
  })

  it('edits the template text visibly from the two check items', async () =>
  {
    const { setPolicy } = panel()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Keep source subfolders' }))
    })
    expect(screen.getByRole('textbox', { name: 'File name' })).toHaveValue('{subdir}/{name}')
    expect(sent(setPolicy).template).toBe('{subdir}/{name}')
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('checkbox', { name: 'One folder per preset' }))
    })
    expect(screen.getByRole('textbox', { name: 'File name' })).toHaveValue('{preset}/{subdir}/{name}')
    expect(screen.getByText('Example: D:\\Exports\\ebu-r128\\Live\\take-1.wav')).toBeInTheDocument()
  })

  it('inserts a field from the menu at the caret and commits it', async () =>
  {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    {
      setTimeout(() => callback(0), 0)
      return 1
    })
    const { setPolicy } = panel()
    const name = screen.getByRole('textbox', { name: 'File name' }) as HTMLInputElement
    name.setSelectionRange(0, 0)
    fireEvent.select(name)
    fireEvent.click(screen.getByRole('button', { name: 'Insert field' }))
    await act(async () =>
    {
      fireEvent.click(await screen.findByRole('menuitem', { hidden: true, name: /Job number/ }))
    })
    expect(sent(setPolicy).template).toBe('{catalog}{name}')
    expect(raf).toHaveBeenCalled()
    await waitFor(() => expect(name.selectionStart).toBe(9))
    expect(name).toHaveFocus()
  })

  it('is read-only during a run with the locked reason', async () =>
  {
    const { setPolicy } = panel({ locked: true })
    expect(screen.getAllByText(outputLockedMessage(formatRunId(31)))[0].tagName).toBe('P')
    expect(screen.getByRole('radio', { name: 'Next to each source' })).toBeDisabled()
    const folder = screen.getByRole('textbox', { name: 'Folder' })
    expect(folder).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'File name' })).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Insert field' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Keep source subfolders' })).toBeDisabled()
    const save = screen.getByRole('button', { name: 'Save as default' })
    expect(save).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(folder, { target: { value: 'E:\\Other' } })
    await act(async () =>
    {
      fireEvent.keyDown(folder, { key: 'Enter' })
      fireEvent.blur(folder)
      fireEvent.blur(screen.getByRole('textbox', { name: 'File name' }))
      fireEvent.click(save)
    })
    expect(setPolicy).not.toHaveBeenCalled()
  })

  it('says it is loading before the first snapshot', () =>
  {
    render(
      <TestBatchActionsProvider>
        <OutputPolicyPanel policy={null} locked={false} runId={null} previewJob={null} platform="win32" />
      </TestBatchActionsProvider>
    )
    expect(screen.getByText('Loading the output settings…')).toBeInTheDocument()
  })
})

describe('OutputPolicyPopover', () =>
{
  it('renders the header\'s trigger and the panel inside a dialog named Output', () =>
  {
    render(
      <TestBatchActionsProvider>
        <OutputPolicyPopover
          control={{ label: 'Output: D:\\Exports', tooltip: 'Where outputs go', locked: false }}
          policy={policy()}
          runId={null}
          previewJob={job()}
          platform="win32"
        />
      </TestBatchActionsProvider>
    )
    const trigger = screen.getByRole('button', { name: 'Output: D:\\Exports' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(dialog).toHaveAttribute('aria-label', 'Output')
    expect(dialog).toHaveTextContent(OUTPUT_COPY.footer)
  })
})

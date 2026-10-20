/**
 * The run header's Output popover: where outputs go, what they are named, and what happens when a file with that
 * name exists. Every change is sent to main, which validates it and plans the waiting jobs against it; the popover
 * shows main's refusals inline beside the field that sent them and is read-only while a batch runs.
 */
import React, { useEffect, useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { Platform } from '../../../../../shared/text/platform'
import type { RunId } from '../../../../../shared/jobs/ids'
import { DEFAULT_TEMPLATES, type BatchPolicy, type ConflictRule, type Destination, type JobView } from '../../../../../shared/jobs/types'
import { templateDate } from '../../../../../shared/jobs/template'
import { batchLabel } from '../../../copy/batch'
import { policyInput, type PolicyInput } from '../../../stores/batchUndo'
import { Button, Checkbox, FieldCaption, FieldMessage, Popover, RadioList, SegmentedControl, type RadioOption, type SegmentOption } from '../../../ui'
import { useBatchActions } from '../BatchActionsContext'
import type { HeaderControl } from './RunHeader'
import { extensionOf, NameTemplateField, type TemplatePreviewJob } from './NameTemplateField'
import { TooltipButton } from './TooltipButton'

type DestinationMode = Destination['mode']

/** The Output popover's fixed text. */
export const OUTPUT_COPY = {
  title: 'Output',
  destination: 'Destination',
  folder: 'Folder',
  folderDescription: 'Writes every output into one folder.',
  nextToSource: 'Next to each source',
  nextToSourceDescription: 'Writes each output beside its source file.',
  replace: 'Replace originals',
  replaceDescription: 'Writes and verifies each output, then moves its original to the Recycle Bin. Ends when this batch ends and is never saved as a default.',
  browse: 'Browse…',
  fileName: 'File name',
  fileNameExtract: 'File name for Extract jobs',
  conflict: 'If a file with that name exists',
  keepOld: 'Keep old files beside the new ones',
  keepOldHint: 'Originals stay as name (original).ext and replaced files as name (previous).ext. Nothing goes to the Recycle Bin.',
  replaceNote: 'Outputs take each original\'s place. The folder does not apply; a new extension writes beside the original and replaces it. Extract jobs never replace originals; they are named by the file name below.',
  footer: 'Changes apply to jobs not in a batch.',
  saveDefault: 'Save as default',
  saveDefaultReplace: 'Replace originals ends with its batch and is never saved as a default.',
  saved: 'Saved as the default for new batches.'
} as const

/** The conflict rule's segments with the hint each one shows while checked. */
export const CONFLICT_OPTIONS: ReadonlyArray<SegmentOption<ConflictRule> & { description: string }> = [
  { value: 'rename', label: 'Rename', description: 'Adds (2), (3), and so on to the new file\'s name.' },
  { value: 'skip', label: 'Skip', description: 'Leaves the existing file and skips the job.' },
  { value: 'overwrite', label: 'Overwrite', description: 'Replaces the existing file after the output verifies; the old file goes to the Recycle Bin.' }
]

/** "Locked while Batch 31 runs. New jobs you review for this batch use the same output. It unlocks when the batch ends." */
export function outputLockedMessage(runId: RunId | null): string
{
  const batch = runId === null ? 'the batch' : batchLabel(runId)
  return `Locked while ${batch} runs. New jobs you review for this batch use the same output. It unlocks when the batch ends.`
}

/** A typed or pasted folder trimmed and unquoted, as Explorer's "Copy as path" wraps it in quotes. */
export function cleanFolderInput(text: string): string
{
  let folder = text.trim()
  while (folder.length >= 2 && ((folder.startsWith('"') && folder.endsWith('"')) || (folder.startsWith('\'') && folder.endsWith('\''))))
  {
    folder = folder.slice(1, -1).trim()
  }
  return folder
}

/** The template each destination starts with; Replace names Extract jobs as Next to each source does. */
export function defaultTemplateFor(mode: DestinationMode): string
{
  return mode === 'folder' ? DEFAULT_TEMPLATES.folder : DEFAULT_TEMPLATES['next-to-source']
}

/** The template after a destination change: a template still at the old default follows the new one; an edited one stays. */
export function templateForMode(template: string, from: DestinationMode, to: DestinationMode): string
{
  return template === defaultTemplateFor(from) ? defaultTemplateFor(to) : template
}

/** The job the name preview resolves, from a row of the table. */
export function previewJobOf(job: JobView): TemplatePreviewJob
{
  const fileName = job.source.path.split(/[/\\]/).pop() ?? job.source.name
  return {
    catalog: job.id,
    fileName,
    directory: job.source.dir,
    subdir: job.source.subdir,
    recipe: job.recipe,
    outputExt: job.plan === null ? null : extensionOf(job.plan.finalName) || null
  }
}

function defaultBrowse(): Promise<string | null>
{
  const api = (window as unknown as { api?: { selectOutputDir?: () => Promise<string | null | undefined> } }).api
  return api?.selectOutputDir === undefined ? Promise.resolve(null) : api.selectOutputDir().then((folder) => folder ?? null)
}

const FOLDER_FRAME = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken px-2 font-mono text-body text-ink',
  'transition-colors duration-fast ease-out',
  'enabled:not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill',
  'disabled:border-line disabled:text-ink-disabled read-only:border-line'
].join(' ')

type ErrorField = 'folder' | 'template' | 'other'

/** Props for {@link OutputPolicyPopover}. */
export interface OutputPolicyPopoverProps
{
  /** The trigger's label and tooltip, and whether a batch locks the output. */
  control: HeaderControl
  /** The queue's policy; null until the first snapshot. */
  policy: BatchPolicy | null
  /** The batch that holds the lock, for its name in the locked reason. */
  runId: RunId | null
  /** The job the name preview resolves: the focused job, or the first waiting one. */
  previewJob: JobView | null
  platform: Platform
  /** Opens the folder picker; resolves to the chosen folder, or null when canceled. */
  browse?: () => Promise<string | null>
  /** Saves the policy as the default for new batches; by default it is sent again, and main keeps the last policy that does not replace originals. */
  onSaveDefault?: (policy: PolicyInput) => Promise<boolean>
  /** The clock of the {date} preview. */
  now?: () => number
  onOpenChange?: (open: boolean) => void
}

/** The Output popover: Destination, File name, the conflict rule, and "Save as default". */
export function OutputPolicyPopover({ control, policy, runId, previewJob, platform, browse = defaultBrowse, onSaveDefault, now = Date.now, onOpenChange }: OutputPolicyPopoverProps): React.JSX.Element
{
  return (
    <Popover
      label={OUTPUT_COPY.title}
      className="w-120 max-w-[calc(100vw-2rem)]"
      onOpenChange={onOpenChange}
      trigger={<TooltipButton iconEnd="action.openMenu" tip={control.tooltip}>{control.label}</TooltipButton>}
    >
      <OutputPolicyPanel
        policy={policy}
        locked={control.locked}
        runId={runId}
        previewJob={previewJob}
        platform={platform}
        browse={browse}
        onSaveDefault={onSaveDefault}
        now={now}
      />
    </Popover>
  )
}

/** Props for {@link OutputPolicyPanel}. */
export interface OutputPolicyPanelProps
{
  policy: BatchPolicy | null
  locked: boolean
  runId: RunId | null
  previewJob: JobView | null
  platform: Platform
  browse?: () => Promise<string | null>
  onSaveDefault?: (policy: PolicyInput) => Promise<boolean>
  now?: () => number
}

/** The Output popover's content, also usable where the output policy shows inline. */
export function OutputPolicyPanel({ policy, locked, runId, previewJob, platform, browse = defaultBrowse, onSaveDefault, now = Date.now }: OutputPolicyPanelProps): React.JSX.Element
{
  const actions = useBatchActions()
  const ids = useId()
  const committedFolder = policy?.destination.mode === 'folder' ? policy.destination.folder : null
  const [folderDraft, setFolderDraft] = useState(committedFolder ?? '')
  const [choosingFolder, setChoosingFolder] = useState(false)
  const [errors, setErrors] = useState<Record<ErrorField, string | null>>({ folder: null, template: null, other: null })
  const [saved, setSaved] = useState(false)

  useEffect(() =>
  {
    if (committedFolder !== null)
    {
      setFolderDraft(committedFolder)
      setChoosingFolder(false)
    }
  }, [committedFolder])
  const policyKey = policy === null ? '' : JSON.stringify(policyInput(policy))
  useEffect(() =>
  {
    setSaved(false)
  }, [policyKey])

  if (policy === null)
  {
    return <p className="text-body text-ink-2">Loading the output settings…</p>
  }

  const mode: DestinationMode = choosingFolder ? 'folder' : policy.destination.mode
  const replace = mode === 'replace-originals'
  const lockText = locked ? outputLockedMessage(runId) : null

  const commit = async (patch: Partial<PolicyInput>, field: ErrorField): Promise<boolean> =>
  {
    if (locked)
    {
      return false
    }
    setErrors((current) => ({ ...current, [field]: null }))
    const outcome = await actions.setPolicy({ ...policyInput(policy), ...patch })
    if (outcome.status === 'refused')
    {
      setErrors((current) => ({ ...current, [field]: outcome.message }))
      return false
    }
    return true
  }

  const commitFolder = (text: string): void =>
  {
    const folder = cleanFolderInput(text)
    setFolderDraft(folder)
    if (folder === committedFolder)
    {
      return
    }
    const template = templateForMode(policy.template, policy.destination.mode, 'folder')
    void commit({ destination: { mode: 'folder', folder }, template }, 'folder')
  }

  const chooseMode = (next: DestinationMode): void =>
  {
    setErrors({ folder: null, template: null, other: null })
    if (next === 'folder')
    {
      const folder = cleanFolderInput(folderDraft)
      if (folder === '')
      {
        setChoosingFolder(true)
        return
      }
      commitFolder(folder)
      return
    }
    setChoosingFolder(false)
    if (next === policy.destination.mode)
    {
      return
    }
    const destination: Destination = next === 'next-to-source' ? { mode: 'next-to-source' } : { mode: 'replace-originals' }
    void commit({ destination, template: templateForMode(policy.template, policy.destination.mode, next) }, 'other')
  }

  const runBrowse = async (): Promise<void> =>
  {
    const folder = await browse()
    if (folder !== null && folder !== '')
    {
      commitFolder(folder)
    }
  }

  const saveDefault = async (): Promise<void> =>
  {
    const input = policyInput(policy)
    const ok = onSaveDefault === undefined ? await commit(input, 'other') : await onSaveDefault(input)
    setSaved(ok)
  }

  const folderId = `${ids}-folder`
  const folderErrorId = `${folderId}-error`
  const folderField = (
    <div className="flex flex-col gap-1">
      <FieldCaption htmlFor={folderId}>Folder</FieldCaption>
      <div className="flex items-center gap-2">
        <input
          id={folderId}
          type="text"
          spellCheck={false}
          autoComplete="off"
          className={FOLDER_FRAME}
          value={folderDraft}
          readOnly={locked}
          disabled={mode !== 'folder'}
          aria-invalid={errors.folder !== null || undefined}
          aria-describedby={errors.folder !== null ? folderErrorId : undefined}
          onChange={(event) =>
          {
            setFolderDraft(event.target.value)
            setErrors((current) => ({ ...current, folder: null }))
          }}
          onPaste={(event: ClipboardEvent<HTMLInputElement>) =>
          {
            const pasted = event.clipboardData.getData('text')
            const element = event.currentTarget
            if (pasted !== cleanFolderInput(pasted) && element.selectionStart === 0 && element.selectionEnd === element.value.length)
            {
              event.preventDefault()
              setFolderDraft(cleanFolderInput(pasted))
            }
          }}
          onBlur={() =>
          {
            if (!locked && mode === 'folder')
            {
              commitFolder(folderDraft)
            }
          }}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) =>
          {
            if (event.key === 'Enter')
            {
              event.preventDefault()
              if (!locked)
              {
                commitFolder(folderDraft)
              }
            }
          }}
        />
        <Button disabled={locked || mode !== 'folder'} onClick={() => void runBrowse()}>{OUTPUT_COPY.browse}</Button>
      </div>
      {errors.folder !== null && <FieldMessage id={folderErrorId} tone="error">{errors.folder}</FieldMessage>}
    </div>
  )

  const destinationOptions: Array<RadioOption<DestinationMode>> = [
    { value: 'folder', label: OUTPUT_COPY.folder, description: OUTPUT_COPY.folderDescription, field: replace ? undefined : folderField },
    { value: 'next-to-source', label: OUTPUT_COPY.nextToSource, description: OUTPUT_COPY.nextToSourceDescription },
    { value: 'replace-originals', label: OUTPUT_COPY.replace, description: OUTPUT_COPY.replaceDescription }
  ]
  const destinationCaption = `${ids}-destination`
  const conflictCaption = `${ids}-conflict`
  const keepHintId = `${ids}-keep-hint`
  const conflictHint = CONFLICT_OPTIONS.find((option) => option.value === policy.conflict)?.description ?? null
  const showKeep = replace || policy.conflict === 'overwrite'
  const saveReason = locked ? lockText ?? undefined : replace ? OUTPUT_COPY.saveDefaultReplace : undefined

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-body font-semibold text-ink">{OUTPUT_COPY.title}</h2>
      {lockText !== null && <p className="text-label text-ink-2">{lockText}</p>}
      <section className="flex flex-col gap-2">
        <FieldCaption id={destinationCaption}>{OUTPUT_COPY.destination}</FieldCaption>
        <RadioList value={mode} onChange={chooseMode} options={destinationOptions} labelledBy={destinationCaption} disabled={locked} error={errors.other ?? undefined} />
        {replace && <p className="text-label text-ink-2">{OUTPUT_COPY.replaceNote}</p>}
      </section>
      <NameTemplateField
        id={`${ids}-template`}
        caption={replace ? OUTPUT_COPY.fileNameExtract : OUTPUT_COPY.fileName}
        value={policy.template}
        onCommit={(template) => void commit({ template }, 'template')}
        job={previewJob === null ? null : previewJobOf(previewJob)}
        folder={mode === 'folder' ? cleanFolderInput(folderDraft) || null : null}
        platform={platform}
        date={templateDate(now())}
        error={errors.template}
        readOnly={locked}
      />
      <section className="flex flex-col gap-2">
        <FieldCaption id={conflictCaption}>{OUTPUT_COPY.conflict}</FieldCaption>
        <SegmentedControl
          value={policy.conflict}
          onChange={(conflict) => void commit({ conflict }, 'other')}
          options={CONFLICT_OPTIONS}
          labelledBy={conflictCaption}
          disabled={locked}
        />
        {conflictHint !== null && <p className="text-label text-ink-2" aria-hidden="true">{conflictHint}</p>}
        {showKeep && (
          <div className="flex flex-col gap-1">
            <Checkbox
              checked={policy.displaced === 'keep'}
              disabled={locked}
              describedBy={keepHintId}
              onChange={(event) => void commit({ displaced: event.target.checked ? 'keep' : 'trash' }, 'other')}
            >
              {OUTPUT_COPY.keepOld}
            </Checkbox>
            <p id={keepHintId} className="text-label text-ink-2">{OUTPUT_COPY.keepOldHint}</p>
          </div>
        )}
      </section>
      <footer className="flex items-center justify-between gap-3 pt-1">
        <p className="text-label text-ink-2">{saved ? OUTPUT_COPY.saved : OUTPUT_COPY.footer}</p>
        <Button unavailableReason={saveReason} onClick={() => void saveDefault()}>{OUTPUT_COPY.saveDefault}</Button>
      </footer>
    </div>
  )
}

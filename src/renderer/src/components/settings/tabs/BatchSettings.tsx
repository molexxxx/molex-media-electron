/**
 * @module components/settings/tabs/BatchSettings
 * @description Batch tab: the default output policy, workers, run settings, history, and recent folders,
 * read from the engine snapshot and changed only through engine commands.
 */

import React, { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react'
import { useStore, type StoreApi } from 'zustand'
import { ACTIVE_STATES, DEFAULT_TEMPLATES, TEMPLATE_TOKENS } from '../../../../../shared/jobs/types'
import type { BatchPolicy, CapabilitySummary, ConflictRule, Destination, RunSettings, RunState } from '../../../../../shared/jobs/types'
import type { CommandResult, JobsApi } from '../../../../../shared/jobs/contract'
import { binPhrase, type Platform } from '../../../../../shared/text/platform'
import { policyInput, type PolicyInput } from '../../../stores/batchUndo'
import { useJobsStore, whenApplied, type JobsState } from '../../../stores/jobs'
import { countOf } from '../../../copy/batch'
import { outputLockedMessage } from '../../batch/header/OutputPolicyPopover'
import {
  autoLimitsSentence,
  detectionLine,
  fixedLimitsSentence,
  gpuLockedMessage,
  gpuUnavailable,
  WORKER_LIMITS,
  WORKERS_COPY,
  workersText
} from '../../batch/header/WorkersPopover'
import { Button, InlineConfirm, NumberField, RadioList, SegmentedControl, Select, Switch, type RadioOption, type SegmentOption } from '../../../ui'
import { Row, Section } from '../Section'

/** The engine commands the Batch tab sends. */
export type BatchSettingsApi = Pick<JobsApi, 'setPolicy' | 'setWorkers' | 'setSettings' | 'listRuns' | 'deleteRuns' | 'forgetFolder' | 'clearRecentFolders'>

/** The retention main applies to history; shown beside the usage. */
export const RETENTION_NOTE = 'molexMedia keeps the newest 200 batches, up to 200 MB of history and 256 MB of logs, and removes the oldest first.'

/** The labels of each conflict rule. */
export const CONFLICT_LABELS: Readonly<Record<ConflictRule, string>> = {
  skip: 'Skip the file',
  rename: 'Add a number',
  overwrite: 'Overwrite it'
}

/** The run settings a reset restores; the new-install values main starts with. */
export const DEFAULT_RUN_SETTINGS: RunSettings = {
  workers: { mode: 'auto' },
  gpuSessions: { mode: 'auto' },
  priority: 'below-normal',
  keepAwake: true,
  verifyVideo: 'full',
  notify: { completion: true, firstFailure: true },
  measureOnReview: true,
  includeSubfolders: true
}

/** Whether the run holds queued or running jobs, so jobs:setPolicy refuses and the policy fields are read-only. */
export function isPolicyLocked(run: RunState | null): boolean
{
  if (run === null || run.status === 'idle') return false
  const counts = run.counts
  const holding = ACTIVE_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), counts.queued ?? 0)
  return holding > 0
}

/** A byte count in the units the history usage reads in. */
export function formatBytes(bytes: number): string
{
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** "12 batches · 4.2 MB of history · 18.0 MB of logs" */
export function usageText(usage: { runs: number; historyBytes: number; logBytes: number }): string
{
  return `${countOf(usage.runs, 'batch', 'batches')} · ${formatBytes(usage.historyBytes)} of history · ${formatBytes(usage.logBytes)} of logs`
}

/**
 * The policy a reset restores: template, conflict rule, displaced files, and GPU at their new-install values.
 * The destination stays a folder (the current one when known); Replace originals is never a default, so a
 * replace or next-to-source queue falls back to the given folder, or to next to each source without one.
 */
export function defaultPolicy(policy: BatchPolicy, capabilities: CapabilitySummary | null, folder: string | null): PolicyInput
{
  const known = policy.destination.mode === 'folder' ? policy.destination.folder : folder
  const destination: Destination = known ? { mode: 'folder', folder: known } : { mode: 'next-to-source' }
  const gpu = capabilities !== null && capabilities.gpu.encoders.length > 0 ? 'auto' : 'off'
  return { destination, template: DEFAULT_TEMPLATES[destination.mode], conflict: 'rename', displaced: 'trash', gpu }
}

/** The run settings part of jobs:setSettings. */
export function settingsInput(settings: RunSettings): Partial<Omit<RunSettings, 'workers' | 'gpuSessions'>>
{
  const { priority, keepAwake, verifyVideo, notify, measureOnReview, includeSubfolders } = settings
  return { priority, keepAwake, verifyVideo, notify: { ...notify }, measureOnReview, includeSubfolders }
}

/** What a reset changed: the last event seq its commands caused, and each refusal's message. */
export interface ResetOutcome
{
  seq: number
  errors: string[]
  /** The policy was left alone because a batch holds queued or running jobs. */
  policyLocked: boolean
}

/** What a reset reads: the engine's current policy, run, and capabilities. */
export interface ResetFacts
{
  policy: BatchPolicy | null
  run: RunState | null
  capabilities: CapabilitySummary | null
  /** The folder a reset uses when the destination is not a folder now. */
  folder?: string | null
}

/** Restores every Batch field through its engine command; the policy only while no batch holds jobs. */
export async function resetBatchDefaults(api: Pick<BatchSettingsApi, 'setPolicy' | 'setWorkers' | 'setSettings'>, facts: ResetFacts): Promise<ResetOutcome>
{
  const errors: string[] = []
  let seq = 0
  const workers = await api.setWorkers({ workers: DEFAULT_RUN_SETTINGS.workers, gpuSessions: DEFAULT_RUN_SETTINGS.gpuSessions })
  if (workers.ok) seq = Math.max(seq, workers.seq)
  else errors.push(workers.error.message)
  const settings = await api.setSettings({ settings: settingsInput(DEFAULT_RUN_SETTINGS) })
  if (settings.ok) seq = Math.max(seq, settings.seq)
  else errors.push(settings.error.message)
  const policyLocked = isPolicyLocked(facts.run)
  if (facts.policy !== null && !policyLocked)
  {
    const next = defaultPolicy(facts.policy, facts.capabilities, facts.folder ?? null)
    if (JSON.stringify(next) !== JSON.stringify(policyInput(facts.policy)))
    {
      const policy = await api.setPolicy({ policy: next })
      if (policy.ok) seq = Math.max(seq, policy.seq)
      else errors.push(policy.error.message)
    }
  }
  return { seq, errors, policyLocked }
}

/** One command in flight per field: the busy field, and each field's last refusal. */
function useSend(store: StoreApi<JobsState>)
{
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const send = useCallback(async <T,>(field: string, command: () => Promise<CommandResult<T>>): Promise<CommandResult<T>> =>
  {
    setBusy(field)
    setErrors((current) =>
    {
      const next = { ...current }
      delete next[field]
      return next
    })
    try
    {
      const result = await command()
      if (result.ok) await whenApplied(result.seq, store)
      else setErrors((current) => ({ ...current, [field]: result.error.message }))
      return result
    }
    finally
    {
      setBusy((current) => current === field ? null : current)
    }
  }, [store])
  return { busy, errors, send }
}

type Send = ReturnType<typeof useSend>

const FIELD_FRAME = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken px-2 text-body text-ink',
  'hover:border-line-control-hover read-only:border-line read-only:text-ink-2'
].join(' ')

/** A text field that commits on Enter or when focus leaves it, and drops the draft on Escape. */
function CommitField({ id, value, readOnly, describedBy, label, onCommit }: { id: string; value: string; readOnly: boolean; describedBy?: string; label?: string; onCommit(next: string): void }): React.JSX.Element
{
  const [draft, setDraft] = useState(value)
  useEffect(() =>
  {
    setDraft(value)
  }, [value])
  const commit = (): void =>
  {
    const next = draft.trim()
    if (next !== value && next !== '') onCommit(next)
    else setDraft(value)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void =>
  {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') setDraft(value)
  }
  return (
    <input
      id={id}
      type="text"
      spellCheck={false}
      className={FIELD_FRAME}
      value={draft}
      readOnly={readOnly}
      aria-label={label}
      aria-describedby={describedBy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  )
}

/** What the replace note and destination field say. */
export const OUTPUT_SETTINGS_COPY = {
  lead: 'Where new batches write their outputs and what happens to the files those outputs meet. Each batch can still change these in Batch, Output.',
  replaceNote: 'Replace originals is chosen per batch in Batch, Output, and is never kept as a default.',
  replaceCurrent: 'The current batch replaces its originals. Choose where the batches after it write.',
  folder: 'A folder',
  nextToSource: 'Next to each source',
  nextToSourceHint: 'Outputs are written beside the files they come from.',
  browse: 'Browse…',
  templateHint: `Builds each output's file name; the extension is added for you. Fields: ${TEMPLATE_TOKENS.map((token) => `{${token}}`).join(', ')}. A / makes subfolders.`
} as const

interface OutputSectionProps
{
  policy: BatchPolicy
  run: RunState | null
  platform: Platform
  api: Pick<BatchSettingsApi, 'setPolicy'>
  send: Send
  pickFolder(): Promise<string | null>
}

function OutputSection({ policy, run, platform, api, send, pickFolder }: OutputSectionProps): React.JSX.Element
{
  const base = useId()
  const locked = isPolicyLocked(run)
  const lockId = `${base}-locked`
  const [lastFolder, setLastFolder] = useState<string | null>(policy.destination.mode === 'folder' ? policy.destination.folder : null)
  useEffect(() =>
  {
    if (policy.destination.mode === 'folder') setLastFolder(policy.destination.folder)
  }, [policy.destination])

  const apply = (field: string, patch: Partial<PolicyInput>): void =>
  {
    if (locked) return
    void send.send(field, () => api.setPolicy({ policy: { ...policyInput(policy), ...patch } }))
  }
  const moveTo = (destination: Destination): void =>
  {
    const mode = policy.destination.mode
    const template = mode !== 'replace-originals' && policy.template === DEFAULT_TEMPLATES[mode] && destination.mode !== 'replace-originals'
      ? DEFAULT_TEMPLATES[destination.mode]
      : policy.template
    apply('destination', { destination, template })
  }
  const browse = async (): Promise<void> =>
  {
    if (locked) return
    const folder = await pickFolder()
    if (folder) moveTo({ mode: 'folder', folder })
  }
  const chooseMode = (mode: 'folder' | 'next-to-source'): void =>
  {
    if (mode === 'next-to-source') moveTo({ mode })
    else if (lastFolder) moveTo({ mode: 'folder', folder: lastFolder })
    else void browse()
  }

  const describe = (id: string): string => locked ? `${id} ${lockId}` : id
  const mode = policy.destination.mode
  const folderValue = policy.destination.mode === 'folder' ? policy.destination.folder : lastFolder ?? ''
  const folderField = (
    <div className="flex min-w-0 items-center gap-2">
      <CommitField
        id={`${base}-folder`}
        label="Output folder"
        value={folderValue}
        readOnly={locked || mode !== 'folder'}
        describedBy={locked ? lockId : undefined}
        onCommit={(folder) => moveTo({ mode: 'folder', folder })}
      />
      <Button size="md" disabled={locked || send.busy === 'destination'} onClick={() => void browse()}>{OUTPUT_SETTINGS_COPY.browse}</Button>
    </div>
  )
  const destinations: Array<RadioOption<'folder' | 'next-to-source'>> = [
    { value: 'folder', label: OUTPUT_SETTINGS_COPY.folder, field: folderField },
    { value: 'next-to-source', label: OUTPUT_SETTINGS_COPY.nextToSource, description: OUTPUT_SETTINGS_COPY.nextToSourceHint }
  ]
  const conflicts: Array<SegmentOption<ConflictRule>> = (['skip', 'rename', 'overwrite'] as const).map((value) => ({ value, label: CONFLICT_LABELS[value] }))

  return (
    <Section
      id={`${base}-title`}
      title="Output"
      lead={(
        <>
          <p>{OUTPUT_SETTINGS_COPY.lead}</p>
          {locked && <p id={lockId} className="mt-1 text-ink">{outputLockedMessage(run?.runId ?? null)}</p>}
        </>
      )}
    >
      <Row id={`${base}-dest`} label="Destination" hint={mode === 'replace-originals' ? OUTPUT_SETTINGS_COPY.replaceCurrent : OUTPUT_SETTINGS_COPY.replaceNote} error={send.errors.destination}>
        <RadioList
          value={mode === 'replace-originals' ? null : mode}
          onChange={chooseMode}
          options={destinations}
          labelledBy={`${base}-dest`}
          describedBy={describe(`${base}-dest-hint`)}
          disabled={locked}
        />
      </Row>
      <Row id={`${base}-template`} label="File name" htmlFor={`${base}-template-input`} hint={OUTPUT_SETTINGS_COPY.templateHint} error={send.errors.template}>
        <CommitField
          id={`${base}-template-input`}
          value={policy.template}
          readOnly={locked || mode === 'replace-originals'}
          describedBy={describe(`${base}-template-hint`)}
          onCommit={(template) => apply('template', { template })}
        />
      </Row>
      <Row id={`${base}-conflict`} label="When the name is taken" hint="What a new output does when a file already has its name." error={send.errors.conflict}>
        <SegmentedControl
          value={policy.conflict}
          onChange={(conflict) => apply('conflict', { conflict })}
          options={conflicts}
          labelledBy={`${base}-conflict`}
          describedBy={describe(`${base}-conflict-hint`)}
          disabled={locked}
        />
      </Row>
      <Row
        id={`${base}-keep`}
        label="Keep old files beside the new ones"
        htmlFor={`${base}-keep-switch`}
        hint={`Off sends a file an output replaces or overwrites to ${binPhrase(platform)}. On renames it and keeps it beside the new file.`}
        error={send.errors.displaced}
      >
        <Switch
          id={`${base}-keep-switch`}
          checked={policy.displaced === 'keep'}
          onChange={(keep) => apply('displaced', { displaced: keep ? 'keep' : 'trash' })}
          describedBy={describe(`${base}-keep-hint`)}
          disabled={locked}
          busy={send.busy === 'displaced'}
        />
      </Row>
    </Section>
  )
}

type CountMode = 'auto' | 'fixed'

const COUNT_MODES: ReadonlyArray<SegmentOption<CountMode>> = [
  { value: 'auto', label: 'Auto' },
  { value: 'fixed', label: 'Fixed' }
]

function clampCount(value: number, max: number): number
{
  return Math.min(max, Math.max(WORKER_LIMITS.min, Math.round(value)))
}

interface WorkersSectionProps
{
  settings: RunSettings
  run: RunState | null
  policy: BatchPolicy
  capabilities: CapabilitySummary | null
  api: Pick<BatchSettingsApi, 'setWorkers' | 'setPolicy'>
  send: Send
  more: boolean
}

function WorkersSection({ settings, run, policy, capabilities, api, send, more }: WorkersSectionProps): React.JSX.Element
{
  const base = useId()
  const limits = run?.workers.limits ?? null
  const workers = settings.workers
  const sessions = settings.gpuSessions
  const fixedCount = workers.mode === 'fixed' ? workers.count : clampCount(limits?.total ?? 4, WORKER_LIMITS.max)
  const fixedSessions = sessions.mode === 'fixed' ? sessions.count : clampCount(limits?.gpu ?? 1, WORKER_LIMITS.gpuMax)
  const setWorkers = (next: RunSettings['workers'], gpuSessions: RunSettings['gpuSessions'] | null): Promise<unknown> =>
    send.send('workers', () => api.setWorkers({ workers: next, gpuSessions }))

  const locked = isPolicyLocked(run)
  const unavailable = gpuUnavailable(capabilities)
  const gpuOptions: Array<SegmentOption<BatchPolicy['gpu']>> = [
    { value: 'off', label: WORKERS_COPY.gpuOff },
    { value: 'auto', label: WORKERS_COPY.gpuAllowed, disabled: unavailable }
  ]
  if (policy.gpu === 'require') gpuOptions.push({ value: 'require', label: 'Required' })
  const detection = detectionLine(capabilities)
  const gpuHint = [unavailable ? WORKERS_COPY.noEncoder : detection, WORKERS_COPY.consequence].filter(Boolean).join(' ')
  const gpuLock = locked && run?.runId ? gpuLockedMessage(run.runId) : null
  const setGpu = (gpu: BatchPolicy['gpu']): void =>
  {
    if (!locked) void send.send('gpu', () => api.setPolicy({ policy: { ...policyInput(policy), gpu } }))
  }

  return (
    <Section id={`${base}-title`} title={WORKERS_COPY.title} lead={WORKERS_COPY.live}>
      <Row
        id={`${base}-workers`}
        label={WORKERS_COPY.jobsAtOnce}
        hint={workers.mode === 'auto' && limits !== null ? autoLimitsSentence(limits) : fixedLimitsSentence(fixedCount)}
        error={send.errors.workers}
      >
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            value={workers.mode}
            onChange={(mode) => void setWorkers(mode === 'auto' ? { mode } : { mode, count: fixedCount }, null)}
            options={COUNT_MODES}
            labelledBy={`${base}-workers`}
            describedBy={`${base}-workers-hint`}
          />
          {workers.mode === 'fixed' && (
            <NumberField
              key={`workers-${workers.count}`}
              className="w-28"
              label={WORKERS_COPY.fixedWorkers}
              value={workers.count}
              step={1}
              min={WORKER_LIMITS.min}
              max={WORKER_LIMITS.max}
              decimals={0}
              valueText={workersText}
              onCommit={(count) => setWorkers({ mode: 'fixed', count: clampCount(count, WORKER_LIMITS.max) }, null)}
            />
          )}
        </div>
      </Row>
      <Row id={`${base}-gpu`} label={WORKERS_COPY.gpu} hint={gpuHint} error={send.errors.gpu}>
        <SegmentedControl
          value={policy.gpu}
          onChange={setGpu}
          options={gpuOptions}
          labelledBy={`${base}-gpu`}
          describedBy={gpuLock === null ? `${base}-gpu-hint` : `${base}-gpu-hint ${base}-gpu-lock`}
          disabled={locked}
        />
        {gpuLock !== null && <p id={`${base}-gpu-lock`} className="text-label text-ink">{gpuLock}</p>}
      </Row>
      {more && (
        <Row id={`${base}-sessions`} label={WORKERS_COPY.sessions} hint={WORKERS_COPY.sessionsHint} error={send.errors.sessions}>
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              value={sessions.mode}
              onChange={(mode) => void send.send('sessions', () => api.setWorkers({ workers, gpuSessions: mode === 'auto' ? { mode } : { mode, count: fixedSessions } }))}
              options={COUNT_MODES}
              labelledBy={`${base}-sessions`}
              describedBy={`${base}-sessions-hint`}
            />
            {sessions.mode === 'fixed' && (
              <NumberField
                key={`sessions-${sessions.count}`}
                className="w-28"
                label={WORKERS_COPY.fixedSessions}
                value={sessions.count}
                step={1}
                min={WORKER_LIMITS.min}
                max={WORKER_LIMITS.gpuMax}
                decimals={0}
                onCommit={(count) => send.send('sessions', () => api.setWorkers({ workers, gpuSessions: { mode: 'fixed', count: clampCount(count, WORKER_LIMITS.gpuMax) } }))}
              />
            )}
          </div>
        </Row>
      )}
    </Section>
  )
}

type SettingKey = 'keepAwake' | 'measureOnReview' | 'includeSubfolders'

interface RunSectionProps
{
  settings: RunSettings
  api: Pick<BatchSettingsApi, 'setSettings'>
  send: Send
  more: boolean
  onToggleMore(): void
}

function RunSection({ settings, api, send, more, onToggleMore }: RunSectionProps): React.JSX.Element
{
  const base = useId()
  const set = (field: string, patch: Parameters<BatchSettingsApi['setSettings']>[0]['settings']): void =>
  {
    void send.send(field, () => api.setSettings({ settings: patch }))
  }
  const toggle = (key: SettingKey, label: string, hint: string): React.JSX.Element => (
    <Row id={`${base}-${key}`} label={label} htmlFor={`${base}-${key}-switch`} hint={hint} error={send.errors[key]}>
      <Switch
        id={`${base}-${key}-switch`}
        checked={settings[key]}
        onChange={(next) => set(key, { [key]: next })}
        describedBy={`${base}-${key}-hint`}
        busy={send.busy === key}
      />
    </Row>
  )
  const notify = (key: keyof RunSettings['notify'], label: string, hint: string): React.JSX.Element => (
    <Row id={`${base}-${key}`} label={label} htmlFor={`${base}-${key}-switch`} hint={hint} error={send.errors[key]}>
      <Switch
        id={`${base}-${key}-switch`}
        checked={settings.notify[key]}
        onChange={(next) => set(key, { notify: { ...settings.notify, [key]: next } })}
        describedBy={`${base}-${key}-hint`}
        busy={send.busy === key}
      />
    </Row>
  )
  const verifications: ReadonlyArray<SegmentOption<RunSettings['verifyVideo']>> = [
    { value: 'full', label: 'Full' },
    { value: 'sampled', label: 'Sampled' }
  ]

  return (
    <Section id={`${base}-title`} title="While a batch runs" lead="These never change what an output contains, so they apply at once, even during a batch.">
      {toggle('keepAwake', 'Keep the computer awake', 'Stops sleep while a batch has jobs running.')}
      <Row id={`${base}-verify`} label="Video verification" hint="Full decodes each video output to the end. Sampled decodes parts spread across it, which is faster on long files. Applies from the next check." error={send.errors.verifyVideo}>
        <SegmentedControl
          value={settings.verifyVideo}
          onChange={(verifyVideo) => set('verifyVideo', { verifyVideo })}
          options={verifications}
          labelledBy={`${base}-verify`}
          describedBy={`${base}-verify-hint`}
        />
      </Row>
      {notify('completion', 'Notify when a batch finishes', 'One notification with the verified and returned counts.')}
      {notify('firstFailure', 'Notify on the first returned job', 'The first job in a batch that fails, is interrupted, or ends outside tolerance.')}
      {toggle('measureOnReview', 'Measure loudness when Review opens', 'Measures Normalize and Boost jobs in the background so Review can show their levels.')}
      {toggle('includeSubfolders', 'Include subfolders', 'Adding a folder also adds the files in its subfolders. The Add menu shares this setting.')}
      {more && (
        <Row id={`${base}-priority`} label="Process priority" htmlFor={`${base}-priority-select`} hint="Below normal keeps the computer responsive while FFmpeg works. Applies from the next process." error={send.errors.priority}>
          <Select
            id={`${base}-priority-select`}
            className="w-48"
            value={settings.priority}
            onChange={(priority) => set('priority', { priority: priority as RunSettings['priority'] })}
            options={[{ value: 'below-normal', label: 'Below normal' }, { value: 'normal', label: 'Normal' }]}
            describedBy={`${base}-priority-hint`}
          />
        </Row>
      )}
      <div className="pt-1">
        <Button variant="ghost" size="sm" aria-expanded={more} onClick={onToggleMore}>{more ? 'Fewer settings' : 'More settings'}</Button>
      </div>
    </Section>
  )
}

/** Retention usage as runs:list reports it. */
type Usage = { runs: number; historyBytes: number; logBytes: number }

function HistorySection({ api }: { api: Pick<BatchSettingsApi, 'listRuns' | 'deleteRuns'> }): React.JSX.Element
{
  const base = useId()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async (): Promise<void> =>
  {
    const result = await api.listRuns({ before: null, limit: 1 })
    if (result.ok) setUsage(result.value.usage)
    else setError(result.error.message)
  }, [api])
  useEffect(() =>
  {
    void load()
  }, [load])

  const clear = async (): Promise<void> =>
  {
    setClearing(true)
    setError(null)
    setMessage(null)
    const result = await api.deleteRuns({ runIds: 'all' })
    setClearing(false)
    if (result.ok)
    {
      setMessage(`Cleared ${countOf(result.value.deleted, 'batch', 'batches')} from history. Their outputs stay on disk.`)
      await load()
    }
    else
    {
      setError(result.error.message)
    }
  }

  const empty = usage !== null && usage.runs === 0
  return (
    <Section id={`${base}-title`} title="History" lead={RETENTION_NOTE}>
      <Row id={`${base}-usage`} label="Kept now" error={error ?? undefined}>
        <p className="text-body tabular-nums text-ink-2">{usage === null ? 'Reading history…' : usageText(usage)}</p>
        {message !== null && <p role="status" className="text-label text-ink-2">{message}</p>}
        <div>
          {confirming
            ? (
                <InlineConfirm
                  question="Clear every batch from history? Outputs stay on disk; their reports can no longer be exported."
                  safeLabel="Keep"
                  confirmLabel="Clear history"
                  danger
                  size="sm"
                  onResolve={(confirmed) =>
                  {
                    setConfirming(false)
                    if (confirmed) void clear()
                  }}
                />
              )
            : <Button size="sm" loading={clearing} loadingLabel="Clearing…" disabled={usage === null || empty} onClick={() => setConfirming(true)}>Clear history</Button>}
        </div>
      </Row>
    </Section>
  )
}

/** "Oct 12" for a recent folder's last add. */
export function folderDate(at: number): string
{
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

interface RecentFoldersProps
{
  folders: JobsState['recentFolders']
  api: Pick<BatchSettingsApi, 'forgetFolder' | 'clearRecentFolders'>
  send: Send
}

function RecentFoldersSection({ folders, api, send }: RecentFoldersProps): React.JSX.Element
{
  const base = useId()
  return (
    <Section id={`${base}-title`} title="Recent folders" lead="The folders Batch offers under Add, Recent folders. Choosing one adds the files not already in the queue.">
      {folders.length === 0
        ? <p className="py-3 text-body text-ink-2">No recent folders. Folders you add in Batch appear here.</p>
        : (
            <ul aria-labelledby={`${base}-title`} className="flex flex-col py-2">
              {folders.map((folder) => (
                <li key={folder.path} className="flex items-center gap-4 border-b border-line py-2 last:border-b-0">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body text-ink">{folder.name}</span>
                    <span className="truncate text-label tabular-nums text-ink-3" title={folder.path}>{`${folder.path} · ${countOf(folder.files, 'file')} · ${folderDate(folder.addedAt)}`}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Forget ${folder.name}`}
                    loading={send.busy === `forget:${folder.path}`}
                    loadingLabel="Forgetting…"
                    onClick={() => void send.send(`forget:${folder.path}`, () => api.forgetFolder({ path: folder.path }))}
                  >
                    Forget
                  </Button>
                </li>
              ))}
            </ul>
          )}
      {folders.map((folder) => send.errors[`forget:${folder.path}`]).filter(Boolean).concat(send.errors.folders ?? []).map((error) => (
        <p key={error} role="alert" className="text-label text-error">{error}</p>
      ))}
      <div className="pt-1">
        <Button
          size="sm"
          disabled={folders.length === 0}
          loading={send.busy === 'folders'}
          loadingLabel="Clearing…"
          onClick={() => void send.send('folders', () => api.clearRecentFolders({}))}
        >
          Clear recent folders
        </Button>
      </div>
    </Section>
  )
}

/** The outcome sentence of a reset. */
export function resetMessage(outcome: ResetOutcome): string
{
  if (outcome.errors.length > 0) return `Some settings were not reset: ${outcome.errors.join(' ')}`
  if (outcome.policyLocked) return 'Workers and run settings are back to their defaults. Output settings stay as they are until the batch ends.'
  return 'Batch settings are back to their defaults.'
}

interface ResetSectionProps
{
  api: Pick<BatchSettingsApi, 'setPolicy' | 'setWorkers' | 'setSettings'>
  store: StoreApi<JobsState>
}

function ResetSection({ api, store }: ResetSectionProps): React.JSX.Element
{
  const base = useId()
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const reset = async (): Promise<void> =>
  {
    setResetting(true)
    setMessage(null)
    const state = store.getState()
    const outcome = await resetBatchDefaults(api, { policy: state.policy, run: state.run, capabilities: state.capabilities })
    await whenApplied(outcome.seq, store)
    setResetting(false)
    setMessage(resetMessage(outcome))
  }
  return (
    <Section id={`${base}-title`} title="Defaults">
      <Row id={`${base}-reset`} label="Reset batch settings" hint="Restores output, workers, and the settings above to the values a new install starts with. History and recent folders stay.">
        <div>
          {confirming
            ? (
                <InlineConfirm
                  question="Reset batch settings to their defaults?"
                  safeLabel="Keep"
                  confirmLabel="Reset"
                  size="sm"
                  onResolve={(confirmed) =>
                  {
                    setConfirming(false)
                    if (confirmed) void reset()
                  }}
                />
              )
            : <Button size="sm" loading={resetting} loadingLabel="Resetting…" onClick={() => setConfirming(true)}>Reset batch settings</Button>}
        </div>
        {message !== null && <p role="status" className="text-label text-ink-2">{message}</p>}
      </Row>
    </Section>
  )
}

/** Props for {@link BatchSettings}; each defaults to the window's engine, store, and folder picker. */
export interface BatchSettingsProps
{
  api?: BatchSettingsApi
  store?: StoreApi<JobsState>
  pickFolder?: () => Promise<string | null>
}

/** The Batch tab of Settings: every field reads the engine snapshot and writes through its engine command. */
export function BatchSettings({ api, store = useJobsStore, pickFolder }: BatchSettingsProps): React.JSX.Element
{
  const jobs = api ?? window.api.jobs
  const pick = pickFolder ?? ((): Promise<string | null> => window.api.selectOutputDir())
  const policy = useStore(store, (state) => state.policy)
  const settings = useStore(store, (state) => state.settings)
  const run = useStore(store, (state) => state.run)
  const capabilities = useStore(store, (state) => state.capabilities)
  const folders = useStore(store, (state) => state.recentFolders)
  const status = useStore(store, (state) => state.status)
  const failure = useStore(store, (state) => state.error)
  const send = useSend(store)
  const [more, setMore] = useState(false)

  if (policy === null || settings === null)
  {
    return (
      <p role="status" className="text-body text-ink-2">
        {status === 'error' ? `Batch settings are unavailable: ${failure ?? 'the job engine did not answer'}.` : 'Loading batch settings…'}
      </p>
    )
  }
  const platform = capabilities?.platform ?? 'win32'
  return (
    <div className="flex flex-col gap-6">
      <OutputSection policy={policy} run={run} platform={platform} api={jobs} send={send} pickFolder={pick} />
      <WorkersSection settings={settings} run={run} policy={policy} capabilities={capabilities} api={jobs} send={send} more={more} />
      <RunSection settings={settings} api={jobs} send={send} more={more} onToggleMore={() => setMore((open) => !open)} />
      <HistorySection api={jobs} />
      <RecentFoldersSection folders={folders} api={jobs} send={send} />
      <ResetSection api={jobs} store={store} />
    </div>
  )
}

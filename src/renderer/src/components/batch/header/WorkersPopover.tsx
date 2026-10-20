/**
 * The run header's Workers popover: how many jobs run at once, whether video may encode on the GPU, and how many
 * GPU encodes run together. Worker counts are run settings and stay live during a run; GPU encoding changes outputs,
 * so it belongs to the output policy and locks while a batch runs.
 */
import React, { useId, useState } from 'react'
import type { RunId } from '../../../../../shared/jobs/ids'
import type { BatchPolicy, CapabilitySummary, RunSettings, WorkersState } from '../../../../../shared/jobs/types'
import { batchLabel, countOf } from '../../../copy/batch'
import { policyInput } from '../../../stores/batchUndo'
import { Button, FieldCaption, FieldMessage, NumberField, Popover, RangeField, SegmentedControl, type SegmentOption } from '../../../ui'
import { useBatchActions } from '../BatchActionsContext'
import type { HeaderControl } from './RunHeader'
import { TooltipButton } from './TooltipButton'

/** The Workers popover's fixed text. */
export const WORKERS_COPY = {
  title: 'Workers',
  jobsAtOnce: 'Jobs at once',
  fixedWorkers: 'Fixed workers',
  live: 'Applies now. Fewer workers take effect as running jobs finish.',
  gpu: 'GPU encoding',
  gpuOff: 'Off',
  gpuAllowed: 'When the settings allow',
  noEncoder: 'No supported GPU encoder found on this computer.',
  detecting: 'Checking the GPU…',
  consequence: 'Only H.264 and HEVC have GPU encoders. GPU encoders cannot encode lossless, so lossless jobs use the CPU encoder. On the GPU, two-pass runs as one pass, CRF becomes a constant quantizer, and tune and pixel format are ignored. Review lists every job this affects.',
  sessions: 'GPU encodes at once',
  fixedSessions: 'Fixed GPU encodes',
  sessionsHint: 'More sessions than the driver allows make jobs fail. molexMedia lowers the limit for the session after a refusal.',
  settingsLink: 'More in Settings: priority, keep awake, verification'
} as const

/** The fewest and most fixed workers, and the most fixed GPU encodes. */
export const WORKER_LIMITS = { min: 1, max: 64, gpuMax: 16 } as const

/** "16 workers", "1 worker": the fixed count's spoken and shown value. */
export function workersText(count: number): string
{
  return countOf(count, 'worker')
}

/** Auto's effective limits in words, from main's worker state. */
export function autoLimitsSentence(limits: WorkersState['limits']): string
{
  const video = limits.videoCpu === 1 ? '1 is a CPU video encode' : `${limits.videoCpu} are CPU video encodes`
  const lead = `Auto runs up to ${countOf(limits.total, 'job')} at once on this computer, of which at most ${video}`
  if (limits.gpu === 0)
  {
    return `${lead}.`
  }
  return `${lead} and ${limits.gpu === 1 ? '1 is a GPU encode' : `${limits.gpu} are GPU encodes`}.`
}

/** "Up to 4 jobs at once, including up to 4 video encodes that each use every core. Auto is faster for video." */
export function fixedLimitsSentence(count: number): string
{
  const encodes = count === 1 ? '1 video encode that uses every core' : `${count} video encodes that each use every core`
  return `Up to ${countOf(count, 'job')} at once, including up to ${encodes}. Auto is faster for video.`
}

const FAMILY_BY_VENDOR = { nvidia: 'NVENC', intel: 'Quick Sync', amd: 'AMF' } as const
const VENDOR_NAMES = { nvidia: 'NVIDIA', intel: 'Intel', amd: 'AMD' } as const
const FAMILY_BY_SUFFIX: ReadonlyArray<[RegExp, string]> = [
  [/_nvenc$/, 'NVENC'],
  [/_qsv$/, 'Quick Sync'],
  [/_amf$/, 'AMF'],
  [/_videotoolbox$/, 'VideoToolbox'],
  [/_vaapi$/, 'VA-API']
]

/** The encoder family a detected GPU encodes with: from its vendor, or else from the encoder names. */
export function encoderFamily(gpu: CapabilitySummary['gpu']): string | null
{
  if (gpu.vendor !== null)
  {
    return FAMILY_BY_VENDOR[gpu.vendor]
  }
  for (const [pattern, family] of FAMILY_BY_SUFFIX)
  {
    if (gpu.encoders.some((encoder) => pattern.test(encoder)))
    {
      return family
    }
  }
  return null
}

/** Whether detection finished and found no GPU encoder this FFmpeg build can use. */
export function gpuUnavailable(capabilities: CapabilitySummary | null): boolean
{
  return capabilities !== null && capabilities.gpu.status === 'ready' && capabilities.gpu.encoders.length === 0
}

/** "Detected: NVIDIA GeForce RTX 4070, NVENC.", "Checking the GPU…", or null when there is nothing to name. */
export function detectionLine(capabilities: CapabilitySummary | null): string | null
{
  if (capabilities === null || capabilities.gpu.status === 'detecting')
  {
    return WORKERS_COPY.detecting
  }
  const gpu = capabilities.gpu
  if (gpu.encoders.length === 0)
  {
    return null
  }
  const adapter = gpu.name ?? (gpu.vendor === null ? 'a GPU' : `an ${VENDOR_NAMES[gpu.vendor]} GPU`)
  const family = encoderFamily(gpu)
  return family === null ? `Detected: ${adapter}.` : `Detected: ${adapter}, ${family}.`
}

/** "GPU encoding is locked while Batch 31 runs." */
export function gpuLockedMessage(runId: RunId): string
{
  return `GPU encoding is locked while ${batchLabel(runId)} runs.`
}

function clamp(value: number, min: number, max: number): number
{
  return Math.min(max, Math.max(min, Math.round(value)))
}

type Mode = 'auto' | 'fixed'
type GpuChoice = 'off' | 'auto'

/** Props for {@link WorkersPopover}. */
export interface WorkersPopoverProps extends WorkersPanelProps
{
  /** The trigger's label and tooltip from the run header. */
  control: HeaderControl
  onOpenChange?: (open: boolean) => void
}

/** The Workers popover with the header's trigger. */
export function WorkersPopover({ control, onOpenChange, ...panel }: WorkersPopoverProps): React.JSX.Element
{
  return (
    <Popover
      label={WORKERS_COPY.title}
      className="w-112 max-w-[calc(100vw-2rem)]"
      onOpenChange={onOpenChange}
      trigger={<TooltipButton iconEnd="action.openMenu" tip={control.tooltip}>{control.label}</TooltipButton>}
    >
      <WorkersPanel {...panel} />
    </Popover>
  )
}

/** Props for {@link WorkersPanel}. */
export interface WorkersPanelProps
{
  /** Main's worker slots: the setting, the effective limits, and what is taken; null until the first snapshot. */
  workers: WorkersState | null
  settings: RunSettings | null
  capabilities: CapabilitySummary | null
  /** The output policy, which carries the GPU choice. */
  policy: BatchPolicy | null
  /** The batch that runs: worker changes apply live and GPU encoding locks; null while nothing runs. */
  runId: RunId | null
  /** Opens Settings at the batch settings; the link is left out when not given. */
  onOpenSettings?: () => void
}

/** The Workers popover's content. */
export function WorkersPanel({ workers, settings, capabilities, policy, runId, onOpenSettings }: WorkersPanelProps): React.JSX.Element
{
  const actions = useBatchActions()
  const ids = useId()
  const [workersError, setWorkersError] = useState<string | null>(null)
  const [gpuError, setGpuError] = useState<string | null>(null)

  if (workers === null || settings === null)
  {
    return <p className="text-body text-ink-2">Loading the worker settings…</p>
  }

  const sendWorkers = async (next: RunSettings['workers'], sessions: RunSettings['gpuSessions'] | null): Promise<void> =>
  {
    setWorkersError(null)
    const outcome = await actions.send('setWorkers', { workers: next, gpuSessions: sessions })
    if (outcome.status === 'refused')
    {
      setWorkersError(outcome.message)
    }
  }

  const sendGpu = async (gpu: GpuChoice): Promise<void> =>
  {
    if (policy === null || runId !== null)
    {
      return
    }
    setGpuError(null)
    const outcome = await actions.setPolicy({ ...policyInput(policy), gpu })
    if (outcome.status === 'refused')
    {
      setGpuError(outcome.message)
    }
  }

  const workersMode: Mode = workers.setting.mode
  const fixedCount = workers.setting.mode === 'fixed' ? workers.setting.count : clamp(workers.limits.total, WORKER_LIMITS.min, WORKER_LIMITS.max)
  const jobsCaption = `${ids}-jobs`
  const jobsHintId = `${ids}-jobs-hint`
  const liveId = `${ids}-live`
  const jobsHint = workersMode === 'auto' ? autoLimitsSentence(workers.limits) : fixedLimitsSentence(fixedCount)
  const jobsOptions: ReadonlyArray<SegmentOption<Mode>> = [
    { value: 'auto', label: 'Auto' },
    { value: 'fixed', label: 'Fixed' }
  ]
  const jobsDescribedBy = runId === null ? jobsHintId : `${jobsHintId} ${liveId}`

  const unavailable = gpuUnavailable(capabilities)
  const gpuLocked = runId !== null
  const gpuChoice: GpuChoice | null = policy === null ? null : policy.gpu === 'off' ? 'off' : 'auto'
  const gpuCaption = `${ids}-gpu`
  const gpuNoteId = `${ids}-gpu-note`
  const detection = detectionLine(capabilities)
  const gpuOptions: ReadonlyArray<SegmentOption<GpuChoice>> = [
    { value: 'off', label: WORKERS_COPY.gpuOff },
    { value: 'auto', label: WORKERS_COPY.gpuAllowed, disabled: unavailable, description: unavailable ? WORKERS_COPY.noEncoder : undefined }
  ]

  const sessionsMode: Mode = settings.gpuSessions.mode
  const autoSessions = sessionsMode === 'auto' ? workers.limits.gpu : null
  const fixedSessions = settings.gpuSessions.mode === 'fixed' ? settings.gpuSessions.count : clamp(workers.limits.gpu, WORKER_LIMITS.min, WORKER_LIMITS.gpuMax)
  const sessionsCaption = `${ids}-sessions`
  const sessionsHintId = `${ids}-sessions-hint`
  const sessionsOptions: ReadonlyArray<SegmentOption<Mode>> = [
    { value: 'auto', label: autoSessions === null ? 'Auto' : `Auto (${autoSessions})` },
    { value: 'fixed', label: 'Fixed' }
  ]

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-body font-semibold text-ink">{WORKERS_COPY.title}</h2>
      <section className="flex flex-col gap-2">
        <FieldCaption id={jobsCaption}>{WORKERS_COPY.jobsAtOnce}</FieldCaption>
        <SegmentedControl
          value={workersMode}
          onChange={(mode) => void sendWorkers(mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', count: fixedCount }, null)}
          options={jobsOptions}
          labelledBy={jobsCaption}
          describedBy={jobsDescribedBy}
          error={workersError ?? undefined}
        />
        {workersMode === 'fixed' && (
          <RangeField
            key={fixedCount}
            label={WORKERS_COPY.fixedWorkers}
            value={fixedCount}
            min={WORKER_LIMITS.min}
            max={WORKER_LIMITS.max}
            step={1}
            bigStep={4}
            decimals={0}
            valueText={workersText}
            onCommit={(count) => sendWorkers({ mode: 'fixed', count: clamp(count, WORKER_LIMITS.min, WORKER_LIMITS.max) }, null)}
          />
        )}
        <p id={jobsHintId} className="text-label text-ink-2">{jobsHint}</p>
        {runId !== null && <p id={liveId} className="text-label text-ink-2">{WORKERS_COPY.live}</p>}
      </section>
      <section className="flex flex-col gap-2">
        <FieldCaption id={gpuCaption}>{WORKERS_COPY.gpu}</FieldCaption>
        <SegmentedControl
          value={gpuChoice}
          onChange={(gpu) => void sendGpu(gpu)}
          options={gpuOptions}
          labelledBy={gpuCaption}
          describedBy={gpuNoteId}
          disabled={gpuLocked || policy === null}
          error={gpuError ?? undefined}
        />
        <div id={gpuNoteId} className="flex flex-col gap-1">
          {gpuLocked && <p className="text-label text-ink-2">{gpuLockedMessage(runId)}</p>}
          {unavailable
            ? <FieldMessage id={`${gpuNoteId}-reason`} tone="note">{WORKERS_COPY.noEncoder}</FieldMessage>
            : detection !== null && <p className="text-label text-ink-2">{detection}</p>}
          <p className="text-label text-ink-2">{WORKERS_COPY.consequence}</p>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <FieldCaption id={sessionsCaption}>{WORKERS_COPY.sessions}</FieldCaption>
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={sessionsMode}
            onChange={(mode) => void sendWorkers(workers.setting, mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', count: fixedSessions })}
            options={sessionsOptions}
            labelledBy={sessionsCaption}
            describedBy={sessionsHintId}
            disabled={unavailable}
          />
          {sessionsMode === 'fixed' && (
            <NumberField
              key={fixedSessions}
              label={WORKERS_COPY.fixedSessions}
              value={fixedSessions}
              min={WORKER_LIMITS.min}
              max={WORKER_LIMITS.gpuMax}
              step={1}
              decimals={0}
              describedBy={sessionsHintId}
              disabled={unavailable}
              className="w-20"
              onCommit={(count) => sendWorkers(workers.setting, { mode: 'fixed', count: clamp(count, WORKER_LIMITS.min, WORKER_LIMITS.gpuMax) })}
            />
          )}
        </div>
        <p id={sessionsHintId} className="text-label text-ink-2">{WORKERS_COPY.sessionsHint}</p>
      </section>
      {onOpenSettings !== undefined && (
        <Button variant="ghost" className="self-start" onClick={onOpenSettings}>{WORKERS_COPY.settingsLink}</Button>
      )}
    </div>
  )
}

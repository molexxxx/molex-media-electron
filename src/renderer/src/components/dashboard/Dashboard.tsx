/**
 * @module components/dashboard/Dashboard
 * @description The home view, a front panel: the queue's display window across the top with the machine's readiness
 * along its foot, a strip of operation keys into Batch beside the Editor and Player keys, and the latest settled
 * jobs with their measured stamps, all read from the jobs store.
 */
import React from 'react'
import type { EncoderPolicy } from '../../../../shared/audio/types'
import type { JobsApi } from '../../../../shared/jobs/contract'
import { operationLabel, recipeLabel } from '../../../../shared/jobs/describe'
import { applyDefaultPreset, DEFAULT_PRESETS, findPreset, presetLookup } from '../../../../shared/jobs/presets'
import { OPERATIONS, type Operation } from '../../../../shared/jobs/recipes'
import { useAppStore } from '../../stores/appStore'
import { useJobsStore, type JobsState } from '../../stores/jobs'
import { Banner, type IconName } from '../../ui'
import { RecentActivity } from './components/RecentActivity'
import { DisplayWindow } from './components/StatCard'
import { KeyStrip, ToolKey } from './components/ToolCard'

/** The output policy a default preset is applied with: encode as the source is encoded. */
export const TILE_OUTPUT: EncoderPolicy = { kind: 'same-as-source' }

/** What an operation tile needs: the file picker, the engine's add command, and the switch to Batch. */
export interface OperationAddDeps
{
  openFiles(): Promise<string[]>
  add: JobsApi['add']
  showBatch(): void
}

/** An operation tile's outcome: files added, the picker closed with nothing, or the engine's refusal. */
export type OperationAddOutcome =
  | { status: 'added'; added: number }
  | { status: 'canceled' }
  | { status: 'refused'; message: string }

/**
 * Opens the file picker and adds the picked files as new jobs with the operation's default preset, then shows Batch.
 * It only adds: jobs already in the queue keep their operation and preset.
 */
export async function addFilesWithOperation(op: Operation, deps: OperationAddDeps): Promise<OperationAddOutcome>
{
  const paths = await deps.openFiles()
  if (paths.length === 0)
  {
    return { status: 'canceled' }
  }
  const reply = await deps.add({
    paths: [...paths],
    recipe: applyDefaultPreset(op, TILE_OUTPUT),
    origin: 'files',
    after: null,
    recursive: false,
    allowSecondJobs: false,
    force: false
  })
  if (!reply.ok)
  {
    return { status: 'refused', message: reply.error.message }
  }
  deps.showBatch()
  return { status: 'added', added: reply.value.added.length }
}

const OPERATION_ICONS: Readonly<Record<Operation, IconName>> =
{
  normalize: 'op.normalize',
  boost: 'op.boost',
  convert: 'op.convert',
  compress: 'op.compress',
  extract: 'op.extract'
}

/** The tile's secondary line: the preset new files from this tile start with. */
export function tileDetail(op: Operation): string
{
  const preset = findPreset(DEFAULT_PRESETS[op])
  return preset === null ? 'Starts with the default preset' : `Starts with ${preset.label}`
}

function windowDeps(showBatch: () => void): OperationAddDeps
{
  return {
    openFiles: () => window.api.openFiles(),
    add: (request) => window.api.jobs.add(request),
    showBatch
  }
}

/** Props for {@link Dashboard}; tests replace the window's picker and engine. */
export interface DashboardProps
{
  deps?: OperationAddDeps
}

/** "Or drop files and folders anywhere on this page; they get Normalize · Streaming (EBU R 128 s2)." */
export function dropHint(recipe: string | null): string
{
  return recipe === null
    ? 'Or drop files and folders anywhere on this page.'
    : `Or drop files and folders anywhere on this page; they get ${recipe}.`
}

const selectDefaultRecipe = (state: JobsState): JobsState['defaultRecipe'] => state.defaultRecipe
const selectPresets = (state: JobsState): JobsState['presets'] => state.presets

function OperationList({ deps }: { deps: OperationAddDeps }): React.JSX.Element
{
  const [picking, setPicking] = React.useState(false)
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const defaultRecipe = useJobsStore(selectDefaultRecipe)
  const presets = useJobsStore(selectPresets)
  const hint = dropHint(defaultRecipe === null ? null : recipeLabel(defaultRecipe, presetLookup(presets?.user ?? [])))

  const run = async (op: Operation): Promise<void> =>
  {
    setPicking(true)
    setRefusal(null)
    try
    {
      const outcome = await addFilesWithOperation(op, deps)
      if (outcome.status === 'refused')
      {
        setRefusal(outcome.message)
      }
    }
    finally
    {
      setPicking(false)
    }
  }

  return (
    <section aria-labelledby="dashboard-add" className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-6 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="dashboard-add" className="type-legend text-accent-ink">Add files with</h2>
        <p data-part="drop-hint" className="min-w-0 truncate text-label text-ink-3">{hint}</p>
      </div>
      {refusal !== null && (
        <Banner tone="error" title="The files were not added." onDismiss={() => setRefusal(null)}>{refusal}</Banner>
      )}
      <KeyStrip className="grid-cols-5">
        {OPERATIONS.map((op) => (
          <ToolKey
            key={op}
            icon={OPERATION_ICONS[op]}
            title={operationLabel(op)}
            name={`Add files with ${operationLabel(op)}…`}
            detail={tileDetail(op)}
            busy={picking}
            onActivate={() => void run(op)}
          />
        ))}
      </KeyStrip>
    </section>
  )
}

function ToolList({ open }: { open: (view: 'editor' | 'player') => void }): React.JSX.Element
{
  return (
    <section aria-labelledby="dashboard-tools" className="flex min-w-0 flex-col gap-2">
      <h2 id="dashboard-tools" className="min-h-6 type-legend text-accent-ink">Tools</h2>
      <KeyStrip className="grid-cols-2">
        <ToolKey icon="nav.editor" title="Media Editor" detail="Timeline, transforms, keyframes, and preview" onActivate={() => open('editor')} />
        <ToolKey icon="nav.player" title="Media Player" detail="Local files and streams with visualizations" onActivate={() => open('player')} />
      </KeyStrip>
    </section>
  )
}

/** How often the system panel asks main for memory, CPU, and GPU load. */
export const SYSTEM_POLL_MS = 2000

const GPU_POLL_MS = 3000

const VENDOR_NAMES: Readonly<Record<string, string>> = { nvidia: 'NVIDIA', intel: 'Intel', amd: 'AMD', cpu: 'CPU' }

const PLATFORM_NAMES: Readonly<Record<string, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

interface SystemSample
{
  cpus: number
  cpuModel?: string
  cpuUsage?: number
  totalMemory: number
  freeMemory: number
  platform?: string
  arch?: string
}

interface GpuSample
{
  mode: string
  label: string
  vendor: string
  pending: boolean
  gpuModel?: string | null
}

const GB = 1024 ** 3

/** Memory in use as "9.2 of 31.9 GB" with its share, or null before the first sample. */
export function memoryWords(sample: Pick<SystemSample, 'totalMemory' | 'freeMemory'> | null): { value: string; detail: string } | null
{
  if (sample === null || sample.totalMemory <= 0)
  {
    return null
  }
  const used = Math.max(0, sample.totalMemory - sample.freeMemory)
  const share = Math.min(100, (used / sample.totalMemory) * 100)
  return { value: `${(used / GB).toFixed(1)} of ${(sample.totalMemory / GB).toFixed(1)} GB`, detail: `${share.toFixed(0)}% used` }
}

/** The FFmpeg version without the banner, "7.1.1" from "ffmpeg version 7.1.1 Copyright…". */
export function ffmpegShortVersion(version: string | null): string | null
{
  if (version === null || version.trim() === '')
  {
    return null
  }
  return version.replace(/^ffmpeg version /i, '').split(/\s+/)[0]
}

function Fact({ label, value, detail, title, children }: { label: string; value: string; detail?: string | null; title?: string | null; children?: React.ReactNode }): React.JSX.Element
{
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-label" title={title ?? undefined}>
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 tabular-nums text-ink-2">
        <span className="truncate">{value}</span>
        {children}
        {detail != null && detail !== '' && (
          <>
            <span aria-hidden="true" className="text-ink-3">·</span>
            <span className="truncate text-ink-3">{detail}</span>
          </>
        )}
      </dd>
    </div>
  )
}

/** FFmpeg, GPU acceleration, CPU, memory, and platform along the display window's foot, polled from main while the Dashboard shows. */
function SystemStrip({ ffmpegVersion }: { ffmpegVersion: string | null }): React.JSX.Element
{
  const setSystemInfo = useAppStore((s) => s.setSystemInfo)
  const [info, setInfo] = React.useState<SystemSample | null>(null)
  const [gpu, setGpu] = React.useState<GpuSample | null>(null)
  const [gpuLoad, setGpuLoad] = React.useState<number | null>(null)

  React.useEffect(() =>
  {
    let stopped = false
    let gpuTimer: number | undefined
    const sample = async (): Promise<void> =>
    {
      try
      {
        const next = await window.api.getSystemInfo()
        if (!stopped && next)
        {
          setInfo(next)
          setSystemInfo(next)
        }
      }
      catch
      {
        return
      }
    }
    const sampleGpu = async (): Promise<void> =>
    {
      try
      {
        const next = await window.api.getGpuInfo()
        if (stopped || !next)
        {
          return
        }
        setGpu(next)
        if (!next.pending && gpuTimer !== undefined)
        {
          window.clearInterval(gpuTimer)
          gpuTimer = undefined
        }
      }
      catch
      {
        return
      }
    }
    const sampleGpuLoad = async (): Promise<void> =>
    {
      try
      {
        const next = await window.api.getGpuUsage()
        if (!stopped && next && typeof next.usage === 'number')
        {
          setGpuLoad(next.usage)
        }
      }
      catch
      {
        return
      }
    }
    void sample()
    void sampleGpu()
    void sampleGpuLoad()
    const timer = window.setInterval(() => void sample(), SYSTEM_POLL_MS)
    const loadTimer = window.setInterval(() => void sampleGpuLoad(), SYSTEM_POLL_MS)
    gpuTimer = window.setInterval(() => void sampleGpu(), GPU_POLL_MS)
    return () =>
    {
      stopped = true
      window.clearInterval(timer)
      window.clearInterval(loadTimer)
      if (gpuTimer !== undefined)
      {
        window.clearInterval(gpuTimer)
      }
    }
  }, [setSystemInfo])

  const memory = memoryWords(info)
  const ffmpeg = ffmpegShortVersion(ffmpegVersion)
  const cpuDetail = info === null
    ? null
    : [`${info.cpus} cores`, typeof info.cpuUsage === 'number' ? `${info.cpuUsage.toFixed(0)}% load` : null].filter(Boolean).join(' · ')
  const gpuDetail = gpu === null
    ? null
    : [gpu.gpuModel ?? null, gpuLoad === null ? null : `${gpuLoad.toFixed(0)}% load`].filter(Boolean).join(' · ')
  const platform = info?.platform ? `${PLATFORM_NAMES[info.platform] ?? info.platform}${info.arch ? ` ${info.arch}` : ''}` : 'Detecting…'

  return (
    <dl aria-label="System" className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1">
      <Fact label="FFmpeg" value={ffmpeg ?? 'Detecting…'} />
      <Fact label="GPU" value={gpu === null || gpu.pending ? 'Detecting…' : gpu.label} detail={gpuDetail} title={gpu?.gpuModel}>
        {gpu !== null && !gpu.pending && (
          <span data-part="vendor" className="shrink-0 rounded-xs border border-line-strong px-1 text-label text-ink-2">
            {VENDOR_NAMES[gpu.vendor] ?? gpu.vendor}
          </span>
        )}
      </Fact>
      <Fact label="CPU" value={cpuDetail ?? 'Detecting…'} title={info?.cpuModel} />
      <Fact label="Memory" value={memory?.value ?? 'Detecting…'} detail={memory?.detail} />
      <Fact label="Platform" value={platform} />
    </dl>
  )
}

/** The home view: no field of it reads the old batch state; the queue, the keys' drop hint, and recent jobs come from the jobs store. */
export default function Dashboard({ deps }: DashboardProps = {}): React.JSX.Element
{
  const setView = useAppStore((s) => s.setView)
  const ffmpegVersion = useAppStore((s) => s.ffmpegVersion)
  const [addDeps] = React.useState<OperationAddDeps>(() => deps ?? windowDeps(() => setView('batch')))

  return (
    <div className="flex min-h-full flex-col gap-6 pr-2 sm:pr-3 md:pr-4">
      <header className="flex flex-col gap-3">
        <h1 className="text-title font-semibold text-ink">Dashboard</h1>
        <DisplayWindow footer={<SystemStrip ffmpegVersion={ffmpegVersion} />} />
      </header>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,2fr)]">
        <OperationList deps={addDeps} />
        <ToolList open={setView} />
      </div>
      <RecentActivity />
    </div>
  )
}

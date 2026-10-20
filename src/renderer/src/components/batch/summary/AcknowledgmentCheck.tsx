import { useId, type ChangeEvent, type ReactElement, type Ref } from 'react'
import type { PreflightReport, VolumeReport } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { countOf, formatBytes, formatCount, joinList, verbFor } from '../../../copy/batch'
import { Checkbox } from '../../../ui/Checkbox'

/** How many originals one volume's bin receives. */
export interface VolumeCount
{
  volume: string
  count: number
}

/** What the acknowledgment states: the counts the Review session holds and where the originals go. */
export interface AcknowledgmentFacts
{
  originals: number
  overwrites: number
  /** Originals per volume, in report order; one entry names its drive, several name each. */
  originalsByVolume: readonly VolumeCount[]
  /** "Keep old files beside the new ones": nothing goes to the bin, originals and replaced files are renamed. */
  keepOld: boolean
  platform: Platform
}

function normalizedPath(path: string): string
{
  return path.replace(/\//g, '\\').toLowerCase()
}

/** A volume as the summary names it: "D:" rather than "D:\", and "/" for a POSIX root. */
export function volumeName(volume: string): string
{
  if (volume.length > 1 && /[\\/]$/.test(volume))
  {
    return volume.slice(0, -1)
  }
  return volume
}

/**
 * The volume a path lies on: the longest volume of the report that holds it, else its drive letter or UNC
 * share, else the POSIX root.
 */
export function volumeOf(path: string, volumes: readonly Pick<VolumeReport, 'volume'>[] = []): string
{
  const target = normalizedPath(path)
  let best: string | null = null
  for (const entry of volumes)
  {
    const prefix = normalizedPath(entry.volume)
    if (prefix !== '' && target.startsWith(prefix) && (best === null || prefix.length > normalizedPath(best).length))
    {
      best = entry.volume
    }
  }
  if (best !== null)
  {
    return volumeName(best)
  }
  const drive = /^([a-z]):/i.exec(path)
  if (drive)
  {
    return `${drive[1].toUpperCase()}:`
  }
  const share = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(path)
  if (share)
  {
    return share[0].replace(/\//g, '\\')
  }
  return '/'
}

/** The originals a report replaces, counted per source volume in the order the jobs appear. */
export function originalsByVolume(report: Pick<PreflightReport, 'jobs' | 'volumes'>): VolumeCount[]
{
  const counts = new Map<string, number>()
  for (const job of report.jobs)
  {
    if (job.plan === null || job.plan.output.resolution !== 'replace-original')
    {
      continue
    }
    const volume = volumeOf(job.plan.source.path, report.volumes)
    counts.set(volume, (counts.get(volume) ?? 0) + 1)
  }
  return [...counts].map(([volume, count]) => ({ volume, count }))
}

/** "the Recycle Bin" on Windows, "the Trash" elsewhere. */
export function binName(platform: Platform): string
{
  return platform === 'win32' ? 'the Recycle Bin' : 'the Trash'
}

function whereClause(facts: AcknowledgmentFacts): string
{
  if (facts.platform !== 'win32' || facts.originalsByVolume.length === 0)
  {
    return ''
  }
  if (facts.originalsByVolume.length === 1)
  {
    return ` on ${facts.originalsByVolume[0].volume}`
  }
  return ` (${facts.originalsByVolume.map((entry) => `${formatCount(entry.count)} on ${entry.volume}`).join(', ')})`
}

function originalsPart(facts: AcknowledgmentFacts, withVerify: boolean): string
{
  const n = facts.originals
  if (facts.keepOld)
  {
    const tail = withVerify ? ` and ${verbFor(n, 'replaced by its output', 'replaced by their outputs')}` : ''
    return `${countOf(n, 'original')} ${verbFor(n, 'is', 'are')} renamed to name (original).ext${tail}`
  }
  const verify = withVerify ? ` after ${verbFor(n, 'its output verifies', 'their outputs verify')}` : ''
  return `${countOf(n, 'original')} ${verbFor(n, 'goes', 'go')} to ${binName(facts.platform)}${whereClause(facts)}${verify}`
}

function overwritesPart(facts: AcknowledgmentFacts): string
{
  const k = facts.overwrites
  if (facts.keepOld)
  {
    return `${countOf(k, 'existing file')} ${verbFor(k, 'stays', 'stay')} as name (previous).ext and ${verbFor(k, 'is', 'are')} replaced`
  }
  return `${countOf(k, 'existing file')} ${verbFor(k, 'goes', 'go')} to ${binName(facts.platform)} and ${verbFor(k, 'is', 'are')} replaced`
}

function parts(facts: AcknowledgmentFacts, withVerify: boolean): string[]
{
  const list: string[] = []
  if (facts.originals > 0)
  {
    list.push(originalsPart(facts, withVerify))
  }
  if (facts.overwrites > 0)
  {
    list.push(overwritesPart(facts))
  }
  return list
}

/** Whether the facts call for the acknowledgment at all. */
export function needsAcknowledgment(facts: Pick<AcknowledgmentFacts, 'originals' | 'overwrites'>): boolean
{
  return facts.originals > 0 || facts.overwrites > 0
}

/**
 * The checkbox label: "I understand that 20 originals go to the Recycle Bin on D: after their outputs verify and 3
 * existing files go to the Recycle Bin and are replaced." Several volumes name each ("(14 on D:, 6 on E:)").
 */
export function acknowledgmentLabel(facts: AcknowledgmentFacts): string
{
  return `I understand that ${parts(facts, true).join(' and ')}.`
}

/** What Ctrl+Enter announces when the acknowledgment holds Start: "Confirm that 20 originals go to the Recycle Bin on D: first." */
export function confirmFirstText(facts: AcknowledgmentFacts): string
{
  return `Confirm that ${parts(facts, false).join(' and ')} first.`
}

/**
 * The description under the label: the room Review found in each bin the batch sends files to, and that the bin
 * can be emptied automatically. "The Recycle Bin on D: has room for about 96 GB. Windows can empty it automatically."
 */
export function acknowledgmentDescription(facts: AcknowledgmentFacts, volumes: readonly VolumeReport[]): string
{
  if (facts.keepOld)
  {
    return `Nothing goes to ${binName(facts.platform)}; the old files stay beside the new ones.`
  }
  if (facts.platform !== 'win32')
  {
    return 'The Trash can be emptied automatically.'
  }
  const receiving = new Set(facts.originalsByVolume.map((entry) => entry.volume))
  const rooms = volumes.filter((entry) =>
    entry.trash === 'available' && entry.trashBytesFree !== null && (entry.trashBytesNeeded > 0 || receiving.has(volumeName(entry.volume))))
  if (rooms.length === 0)
  {
    return 'Windows can empty the Recycle Bin automatically.'
  }
  if (rooms.length === 1)
  {
    return `The Recycle Bin on ${volumeName(rooms[0].volume)} has room for about ${formatBytes(rooms[0].trashBytesFree as number)}. Windows can empty it automatically.`
  }
  const list = joinList(rooms.map((entry) => `about ${formatBytes(entry.trashBytesFree as number)} on ${volumeName(entry.volume)}`))
  return `The Recycle Bin has room for ${list}. Windows can empty it automatically.`
}

/** Props for {@link AcknowledgmentCheck}. */
export interface AcknowledgmentCheckProps
{
  facts: AcknowledgmentFacts
  /** The report's volumes, for the room each bin has. */
  volumes: readonly VolumeReport[]
  checked: boolean
  /** Why a refreshed report unchecked the box: "The number of originals changed to 22; confirm again." */
  notice?: string | null
  onChange: (checked: boolean) => void
  /** The checkbox itself, which Ctrl+Enter focuses when the acknowledgment holds the primary action. */
  ref?: Ref<HTMLInputElement>
}

/**
 * The Review acknowledgment: a checkbox whose label states the originals affected and the files replaced, naming
 * the bin per volume, with the room Review found under it. It never remembers a past Start; the Review session
 * keeps it checked across refreshed reports while both counts hold, and when one changes it shows why it unchecked.
 */
export function AcknowledgmentCheck({ facts, volumes, checked, notice = null, onChange, ref }: AcknowledgmentCheckProps): ReactElement
{
  const descriptionId = useId()
  const noticeId = useId()
  const describedBy = notice === null ? descriptionId : `${noticeId} ${descriptionId}`

  return (
    <div data-slot-part="acknowledgment" className="flex flex-col gap-1">
      {notice === null
        ? null
        : <p id={noticeId} data-line="acknowledgment-notice" className="text-label text-warning">{notice}</p>}
      <Checkbox
        ref={ref}
        checked={checked}
        describedBy={describedBy}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
      >
        {acknowledgmentLabel(facts)}
      </Checkbox>
      <p id={descriptionId} className="pl-6 text-label text-ink-2">{acknowledgmentDescription(facts, volumes)}</p>
    </div>
  )
}

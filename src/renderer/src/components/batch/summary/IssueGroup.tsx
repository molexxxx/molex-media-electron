import { useId, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { PlanFix, PlanIssue, PlanIssueCode, PreflightReport } from '../../../../../shared/jobs/types'
import { countOf } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { CapsText } from '../../../ui/CapsText'
import { Icon } from '../../../ui/Icon'
import type { IconName } from '../../../ui/icons'

/** How serious an issue group is; blocking groups come first. */
export type IssueSeverity = PlanIssue['severity']

/** A page control an issue offers beside main's fix: these open something rather than re-plan. */
export type IssueActionId = 'locate' | 'probe-again' | 'show-log' | 'change-output' | 'change-file-name' | 'open-settings' | 'select-album'

/** One distinct issue of a report and the jobs that carry it. */
export interface IssueGroupData
{
  key: string
  code: PlanIssueCode
  severity: IssueSeverity
  /** Main's words, verbatim. */
  reason: string
  jobIds: JobId[]
  fix: PlanFix | null
  actions: IssueActionId[]
}

const SEVERITY_RANK: Readonly<Record<IssueSeverity, number>> = { error: 0, warning: 1, info: 2 }

const SEVERITY_LOOK: Readonly<Record<IssueSeverity, { icon: IconName, ink: string, word: string }>> = {
  error: { icon: 'status.failed', ink: 'text-error', word: 'Blocking' },
  warning: { icon: 'status.warning', ink: 'text-warning', word: 'Warning' },
  info: { icon: 'action.info', ink: 'text-ink-3', word: 'Note' }
}

const PAGE_ACTIONS: Partial<Readonly<Record<PlanIssueCode, readonly IssueActionId[]>>> = {
  'source-missing': ['locate'],
  'source-unreadable': ['probe-again'],
  'probe-failed': ['probe-again', 'show-log'],
  'destination-invalid': ['change-output'],
  'destination-not-writable': ['change-output'],
  'disk-tight': ['change-output'],
  'disk-insufficient': ['change-output'],
  'template-unknown-token': ['change-file-name'],
  'template-empty': ['change-file-name'],
  'template-escapes': ['change-file-name'],
  'same-as-source': ['change-file-name'],
  'ffmpeg-unavailable': ['open-settings'],
  'ffmpeg-below-minimum': ['open-settings'],
  'self-test-failed': ['open-settings'],
  'album-incomplete': ['select-album']
}

const ACTION_LABELS: Readonly<Record<IssueActionId, string>> = {
  'locate': 'Locate…',
  'probe-again': 'Probe again',
  'show-log': 'Show log',
  'change-output': 'Change output',
  'change-file-name': 'Change file name',
  'open-settings': 'Open Settings',
  'select-album': 'Select the whole album'
}

/** The page controls an issue code offers. */
export function issueActions(code: PlanIssueCode): IssueActionId[]
{
  return [...(PAGE_ACTIONS[code] ?? [])]
}

/** The label of a page control. */
export function issueActionLabel(id: IssueActionId): string
{
  return ACTION_LABELS[id]
}

function fixKey(fix: PlanFix | null): string
{
  return fix === null ? 'none' : JSON.stringify(fix)
}

/**
 * The report's issues as one group per distinct issue (its code, severity, and fix), each with the jobs that carry
 * it, blocking first and otherwise in the order the jobs list them. The reason is main's message for the first job.
 */
export function groupIssues(jobs: PreflightReport['jobs']): IssueGroupData[]
{
  const groups = new Map<string, IssueGroupData>()
  for (const job of jobs)
  {
    for (const issue of job.issues)
    {
      const key = `${issue.severity}|${issue.code}|${fixKey(issue.fix)}`
      const group = groups.get(key)
      if (group === undefined)
      {
        groups.set(key, { key, code: issue.code, severity: issue.severity, reason: issue.message, jobIds: [job.jobId], fix: issue.fix, actions: issueActions(issue.code) })
      }
      else if (!group.jobIds.includes(job.jobId))
      {
        group.jobIds.push(job.jobId)
      }
    }
  }
  return [...groups.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

function capitalized(word: string): string
{
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
}

const GPU_LABELS: Readonly<Record<'off' | 'auto' | 'require', string>> = {
  off: 'Turn off GPU encoding for this batch',
  auto: 'Use the GPU when it can for this batch',
  require: 'Require the GPU for this batch'
}

/**
 * A fix button's label, which states its scope: a fix that changes jobs says how many ("Write MKV instead for 2
 * jobs"), and a fix that changes the batch says so ("Use Rename for this batch").
 */
export function fixLabel(fix: PlanFix, count: number): string
{
  const jobs = countOf(count, 'job')
  switch (fix.kind)
  {
    case 'set-conflict-rule':
      return `Use ${capitalized(fix.rule)} for this batch`
    case 'add-token':
      return `Add ${fix.token} to file names`
    case 'set-gpu':
      return GPU_LABELS[fix.gpu]
    case 'set-displaced':
      return 'Keep old files beside the new ones for this batch'
    case 'set-destination':
      return 'Write next to each source instead'
    case 'set-container':
      return fix.container === 'mka' ? `Keep all tracks as .mka for ${jobs}` : `Write ${fix.container.toUpperCase()} instead for ${jobs}`
    case 'patch-recipe':
      return `${fix.label} for ${jobs}`
    case 'remove':
      return `Remove ${jobs} from the queue`
  }
}

/** "Show 4 more issues", or "Show 1 more issue". */
export function moreIssuesLabel(count: number): string
{
  return `Show ${countOf(count, 'more issue', 'more issues')}`
}

/** What a fix that empties its group announces: "Fixed for 2 jobs." */
export function fixedText(count: number): string
{
  return `Fixed for ${countOf(count, 'job')}.`
}

/** Props for {@link IssueGroup}. */
export interface IssueGroupProps
{
  group: IssueGroupData
  /** "Select": selects exactly the group's jobs and focuses the first. */
  onSelect: (ids: readonly JobId[]) => void
  /** A fix button: re-plans exactly the group's jobs, or the batch for a batch fix; the caller makes it undoable. */
  onFix: (fix: PlanFix, ids: readonly JobId[]) => void
  onAction?: (action: IssueActionId, ids: readonly JobId[]) => void
}

/** One issue line: icon and word, main's reason, the job count, the fix buttons, and "Select". */
export function IssueGroup({ group, onSelect, onFix, onAction }: IssueGroupProps): ReactElement
{
  const reasonId = useId()
  const look = SEVERITY_LOOK[group.severity]
  const count = group.jobIds.length

  return (
    <li
      data-issue-group={group.key}
      data-severity={group.severity}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line px-3 py-2 first:border-t-0"
    >
      <span className={`flex items-center gap-1.5 ${look.ink}`}>
        <Icon name={look.icon} size="sm" />
        <CapsText className="type-legend">{look.word}</CapsText>
      </span>
      <span className="flex min-w-0 flex-col">
        <span id={reasonId} className="min-w-0 text-body text-ink">{group.reason}</span>
        <span className="text-label text-ink-3 tabular-nums">{countOf(count, 'job')}</span>
      </span>
      <span className="flex flex-wrap justify-end gap-1.5">
        {group.fix === null
          ? null
          : (
            <Button size="sm" variant="secondary" onClick={() => onFix(group.fix as PlanFix, group.jobIds)}>
              {fixLabel(group.fix, count)}
            </Button>
          )}
        {onAction === undefined
          ? null
          : group.actions.map((action) => (
            <Button key={action} size="sm" variant="ghost" onClick={() => onAction(action, group.jobIds)}>
              {issueActionLabel(action)}
            </Button>
          ))}
        <Button size="sm" variant="ghost" aria-describedby={reasonId} onClick={() => onSelect(group.jobIds)}>Select</Button>
      </span>
    </li>
  )
}

/** Props for {@link IssueGroups}. */
export interface IssueGroupsProps extends Omit<IssueGroupProps, 'group'>
{
  groups: readonly IssueGroupData[]
  /** How many groups show before "Show {n} more issues". */
  limit?: number
  /** Where focus goes when a fix empties the last group. */
  headingRef: RefObject<HTMLElement | null>
  /** Polite announcements: "Fixed for 2 jobs." */
  onAnnounce?: (message: string) => void
}

interface PendingFix
{
  key: string
  index: number
  count: number
}

function focusFirstButton(list: HTMLElement | null, key: string): boolean
{
  const row = list === null ? null : [...list.querySelectorAll<HTMLElement>('[data-issue-group]')].find((element) => element.dataset.issueGroup === key)
  const button = row?.querySelector<HTMLElement>('button') ?? null
  button?.focus()
  return button !== null
}

/**
 * The Review issue groups, blocking first; three show until "Show {n} more issues". A group disappears when its
 * count reaches zero, and when a fix button inside it emptied it, focus moves to the group that took its place
 * (or the one before it) and otherwise to the summary heading, with "Fixed for {n} jobs." announced.
 */
export function IssueGroups({ groups, limit = 3, headingRef, onAnnounce, onFix, ...rest }: IssueGroupsProps): ReactElement | null
{
  const listRef = useRef<HTMLUListElement>(null)
  const pendingRef = useRef<PendingFix | null>(null)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() =>
  {
    const pending = pendingRef.current
    if (pending === null || groups.some((group) => group.key === pending.key))
    {
      return
    }
    pendingRef.current = null
    const active = document.activeElement
    const lost = active === null || active === document.body || (listRef.current?.contains(active) ?? false)
    if (lost)
    {
      const target = groups[pending.index] ?? groups[pending.index - 1] ?? null
      if (target === null || !focusFirstButton(listRef.current, target.key))
      {
        headingRef.current?.focus()
      }
    }
    onAnnounce?.(fixedText(pending.count))
  }, [groups, headingRef, onAnnounce])

  const fix = (group: IssueGroupData, index: number) => (planFix: PlanFix, ids: readonly JobId[]): void =>
  {
    pendingRef.current = { key: group.key, index, count: ids.length }
    onFix(planFix, ids)
  }

  if (groups.length === 0)
  {
    return null
  }

  const shown = expanded ? groups : groups.slice(0, Math.max(0, limit))
  const hidden = groups.length - shown.length

  return (
    <div data-slot-part="issue-groups" className="flex flex-col gap-1">
      <ul ref={listRef} className="flex flex-col rounded-sm border border-line">
        {shown.map((group, index) => (
          <IssueGroup key={group.key} group={group} onFix={fix(group, index)} {...rest} />
        ))}
      </ul>
      {hidden > 0 || (expanded && groups.length > limit)
        ? (
          <div>
            <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show fewer' : moreIssuesLabel(hidden)}
            </Button>
          </div>
        )
        : null}
    </div>
  )
}

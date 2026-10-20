/**
 * The job table's columns: each job list's column set from the batch view with its tracks, alignment, sort keys,
 * and header words. Priority 1 columns always show, except the working column below 560 px of grid width;
 * priority 2 shows from 680 px and priority 3 from 960 px. Run adds a priority 3 column for its quick buttons.
 */
import { JOB_STATES, type JobView } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { statusWords } from '../../../copy/batch'
import { BATCH_COLUMNS, MIN_TABLE_WIDTH, type ColumnSetId } from '../../../stores/batchView'
import { GRID_ACTIONS_WIDTH, type GridColumn, type GridSortValue } from '../../../ui/DataGrid'
import { sourceSummary, type JobColumnId } from './cells'

/** The column sets whose rows are jobs; History's batch list has rows of its own. */
export type JobColumnSet = Exclude<ColumnSetId, 'historyBatches'>

/** A row of the job table: only the job's id, so each row reads its own job and re-renders alone. */
export interface JobRow
{
  id: string
}

/** What the columns read besides their set. */
export interface JobColumnOptions
{
  /** Reads a job when the grid sorts. */
  lookup: (id: string) => JobView | null
  platform: Platform
  /** A batch is running, so Run's working column reads "Progress" rather than "Result". */
  running?: boolean
  /** Adds Run's quick buttons (Cancel job, Skip, Acknowledge) at priority 3 widths. */
  quickActions?: boolean
  /** The grid is under {@link NARROW_TABLE_WIDTH}, so the working column steps aside. */
  narrow?: boolean
}

/** Below this grid width the working column steps aside, so No., Status, File, and the Actions column stay on screen. */
export const NARROW_TABLE_WIDTH = MIN_TABLE_WIDTH

/** The working column each list drops below {@link NARROW_TABLE_WIDTH}; Review's priority 1 columns fit without it. */
const NARROW_DROPS: Readonly<Partial<Record<JobColumnSet, JobColumnId>>> = { queue: 'recipe', run: 'progress', historyResults: 'result' }

/** The header of Run's quick buttons, read only by assistive technology. */
export const QUICK_ACTIONS_LABEL = 'Quick actions'

/** The header of the More actions column, read only by assistive technology. */
export const ACTIONS_LABEL = 'Actions'

const TRACKS: Readonly<Record<JobColumnId, string>> =
{
  no: '52px',
  status: 'minmax(120px, 0.9fr)',
  plan: 'minmax(120px, 0.9fr)',
  file: 'minmax(160px, 2fr)',
  source: 'minmax(160px, 1.4fr)',
  recipe: 'minmax(140px, 1.4fr)',
  duration: '80px',
  size: '80px',
  output: 'minmax(160px, 1.6fr)',
  encoder: 'minmax(104px, 0.8fr)',
  audioPlan: 'minmax(150px, 1fr)',
  progress: 'minmax(150px, 1.3fr)',
  time: '128px',
  speed: '64px',
  out: 'minmax(120px, 0.8fr)',
  batch: '96px',
  finished: '120px',
  result: 'minmax(150px, 1.3fr)',
  actions: GRID_ACTIONS_WIDTH,
  quick: GRID_ACTIONS_WIDTH
}

const END_ALIGNED: ReadonlySet<JobColumnId> = new Set<JobColumnId>(['duration', 'size', 'time', 'speed', 'out'])

type SortKey = (job: JobView, set: JobColumnSet, platform: Platform) => GridSortValue

function stateOrder(job: JobView, set: JobColumnSet, platform: Platform): string
{
  const rank = String(JOB_STATES.indexOf(job.state)).padStart(2, '0')
  return `${rank} ${statusWords(job, { platform, inRunMode: set === 'run' }).label}`
}

const SORT_KEYS: Readonly<Partial<Record<JobColumnId, SortKey>>> =
{
  no: (job) => job.seq,
  status: stateOrder,
  plan: stateOrder,
  file: (job) => job.source.name,
  source: (job) => sourceSummary(job.media),
  recipe: (job) => job.recipeLabel,
  duration: (job) => job.media?.durationSec ?? null,
  size: (job) => job.source.size,
  output: (job) => job.plan?.relativePath ?? null,
  encoder: (job) => job.plan?.encoderLabel ?? null,
  audioPlan: (job) => job.audioPlan?.[0]?.gainDb ?? null,
  batch: (job) => job.runId,
  finished: (job) => job.endedAt
}

/** Whether a column sorts; the live Run columns and the button columns do not. */
export function isSortable(column: string): boolean
{
  return Object.hasOwn(SORT_KEYS, column)
}

/** The value a job sorts by in a column; null sorts last, and strings compare with numeric collation. */
export function sortKey(column: string, job: JobView, set: JobColumnSet, platform: Platform): GridSortValue
{
  const key = Object.hasOwn(SORT_KEYS, column) ? SORT_KEYS[column as JobColumnId] : undefined
  return key === undefined ? null : key(job, set, platform)
}

function headerLabel(id: string, label: string, options: JobColumnOptions): string
{
  if (id === 'progress')
  {
    return options.running === true ? 'Progress' : 'Result'
  }
  return id === 'actions' ? ACTIONS_LABEL : label
}

/** A job list's columns in display order, ready for the DataGrid. */
export function jobColumns(set: JobColumnSet, options: JobColumnOptions): Array<GridColumn<JobRow>>
{
  const columns: Array<GridColumn<JobRow>> = []
  const dropped = options.narrow === true ? NARROW_DROPS[set] : undefined
  for (const entry of BATCH_COLUMNS[set])
  {
    const id = entry.id as JobColumnId
    if (id === dropped)
    {
      continue
    }
    if (id === 'actions' && set === 'run' && options.quickActions === true)
    {
      columns.push({ id: 'quick', label: QUICK_ACTIONS_LABEL, width: TRACKS.quick, priority: 3, optional: false, kind: 'actions' })
    }
    const column: GridColumn<JobRow> =
    {
      id,
      label: headerLabel(id, entry.label, options),
      width: Object.hasOwn(TRACKS, id) ? TRACKS[id] : 'minmax(96px, 1fr)',
      priority: entry.priority,
      optional: entry.optional,
      kind: entry.kind,
      align: END_ALIGNED.has(id) ? 'end' : 'start'
    }
    if (isSortable(id))
    {
      column.sortable = true
      column.sortValue = (row) =>
      {
        const job = options.lookup(row.id)
        return job === null ? null : sortKey(id, job, set, options.platform)
      }
    }
    columns.push(column)
  }
  return columns
}

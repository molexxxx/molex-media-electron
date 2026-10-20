/**
 * The Batch view's filters as pure functions: which facet values a job carries, whether a job passes a view's
 * chips and search, the chip text that names what a filter keeps, and the messages the toolbar and the live
 * region read. Values within one facet widen the view; facets narrow it. Needs attention reads needsAttention
 * only, so the filter counts the same jobs as the header and the sidebar.
 */
import { isEdited, operationLabel, sameRecipeValues, type PresetLookup } from '../../../shared/jobs/describe'
import { formatRunLabel, parseRunId, type RunId } from '../../../shared/jobs/ids'
import { OPERATIONS, type Operation } from '../../../shared/jobs/recipes'
import { needsAttention, STATE_GROUPS } from '../../../shared/jobs/states'
import type { JobView } from '../../../shared/jobs/types'

/** The facets of the Filter menu. Edited and album groups sit under Recipe in the menu but narrow on their own. */
export type FilterFacet = 'type' | 'channels' | 'container' | 'folder' | 'operation' | 'recipe' | 'edited' | 'album' | 'status' | 'batch'

/** Every facet, in menu order. */
export const FILTER_FACETS: readonly FilterFacet[] = ['type', 'channels', 'container', 'folder', 'operation', 'recipe', 'edited', 'album', 'status', 'batch']

/** One active filter, shown as a removable chip. `label` names a folder chip as the menu showed it. */
export interface BatchFilter
{
  facet: FilterFacet
  value: string
  label?: string
}

/** A view's filters: the chips in the order they were added and the search text. */
export interface BatchFilters
{
  chips: readonly BatchFilter[]
  search: string
}

/** What some facets need beyond the row. */
export interface FilterContext
{
  /** Decides Edited; without it, the ", edited" ending of the row's recipe label decides. */
  lookup?: PresetLookup
}

/** A job's media type: with a video stream, audio only, or not known yet. */
export type MediaType = 'video' | 'audio'

/** The channel classes of the Channels facet. */
export type ChannelClass = 'mono' | 'stereo' | '5.1' | '7.1' | 'other'

/** The values of the Status facet: the plan states of jobs not in a batch, Needs attention, and the run states. */
export type StatusValue =
  | 'ready'
  | 'warnings'
  | 'blocked'
  | 'will-skip'
  | 'attention'
  | 'queued'
  | 'running'
  | 'held'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'interrupted'

/** The Batch facet's value for jobs not in a batch; every other value is a run id. */
export const NOT_IN_BATCH = 'none'

/** The ending the shared recipe label gives a recipe that differs from its preset. */
export const EDITED_SUFFIX = ', edited'

/** No chips and no search. */
export const NO_FILTERS: BatchFilters = Object.freeze({ chips: Object.freeze([]) as readonly BatchFilter[], search: '' })

/** Every Status value, in menu order. */
export const STATUS_VALUES: readonly StatusValue[] = ['ready', 'warnings', 'blocked', 'will-skip', 'attention', 'queued', 'running', 'held', 'done', 'failed', 'canceled', 'skipped', 'interrupted']

/** Every channel class, in menu order. */
export const CHANNEL_CLASSES: readonly ChannelClass[] = ['mono', 'stereo', '5.1', '7.1', 'other']

/** Every media type, in menu order. */
export const MEDIA_TYPES: readonly MediaType[] = ['video', 'audio']

/** The extension without its dot, lowercased: "MKV" and ".mkv" are both "mkv". */
export function extensionOf(job: JobView): string
{
  return job.source.ext.replace(/^\./, '').toLowerCase()
}

/** Video when the source has a real video stream, audio when it has audio and no video, null before the probe. */
export function mediaTypeOf(job: JobView): MediaType | null
{
  const media = job.media
  if (media === null)
  {
    return null
  }
  if (media.video !== null)
  {
    return 'video'
  }
  return media.audio.length > 0 ? 'audio' : null
}

/** The channel class of one audio stream: its layout when FFmpeg named one, otherwise its channel count. */
export function channelClass(channels: number, layout: string | null): ChannelClass
{
  if (layout !== null && layout !== '')
  {
    if (layout === 'mono' || layout === 'stereo')
    {
      return layout
    }
    if (layout.startsWith('5.1'))
    {
      return '5.1'
    }
    return layout.startsWith('7.1') ? '7.1' : 'other'
  }
  switch (channels)
  {
    case 1:
      return 'mono'
    case 2:
      return 'stereo'
    case 6:
      return '5.1'
    case 8:
      return '7.1'
    default:
      return 'other'
  }
}

/** The recipe a job came from as the Recipe facet groups it: the row's recipe label without ", edited". */
export function recipeKey(job: JobView): string
{
  const label = job.recipeLabel
  return label.endsWith(EDITED_SUFFIX) ? label.slice(0, -EDITED_SUFFIX.length) : label
}

/** Whether a job's recipe differs from its preset. */
export function isEditedJob(job: JobView, context: FilterContext = {}): boolean
{
  return context.lookup ? isEdited(job.recipe, context.lookup) : job.recipeLabel.endsWith(EDITED_SUFFIX)
}

/** The Status value of a job's state or plan; null for a job not in a batch whose plan has not landed. */
export function planStatusOf(job: JobView): StatusValue | null
{
  if (job.state !== 'pending')
  {
    return STATE_GROUPS[job.state] === 'active' ? 'running' : job.state as StatusValue
  }
  const plan = job.plan
  if (plan === null)
  {
    return null
  }
  if (plan.status === 'ready')
  {
    return plan.warnings > 0 ? 'warnings' : 'ready'
  }
  return plan.status
}

/** The values a job carries for one facet; a job with several audio streams carries each stream's class. */
export function jobFacetValues(job: JobView, facet: FilterFacet, context: FilterContext = {}): string[]
{
  switch (facet)
  {
    case 'type':
    {
      const type = mediaTypeOf(job)
      return type === null ? [] : [type]
    }
    case 'channels':
      return [...new Set((job.media?.audio ?? []).map((stream) => channelClass(stream.channels, stream.layout)))]
    case 'container':
      return [extensionOf(job)]
    case 'folder':
      return [job.source.dir]
    case 'operation':
      return [job.recipe.kind]
    case 'recipe':
      return [recipeKey(job)]
    case 'edited':
      return isEditedJob(job, context) ? ['edited'] : []
    case 'album':
      return job.albumGroupId !== null ? ['album'] : []
    case 'status':
    {
      const values: string[] = []
      const status = planStatusOf(job)
      if (status !== null)
      {
        values.push(status)
      }
      if (needsAttention(job))
      {
        values.push('attention')
      }
      return values
    }
    case 'batch':
      return [job.runId ?? NOT_IN_BATCH]
  }
}

/** Whether a job's file name or folder holds every word of the search, ignoring case. */
export function matchesSearch(job: JobView, search: string): boolean
{
  return hasWords(job, searchWords(search))
}

function searchWords(search: string): string[]
{
  return search.trim().toLocaleLowerCase().split(/\s+/).filter((word) => word !== '')
}

function hasWords(job: JobView, words: readonly string[]): boolean
{
  if (words.length === 0)
  {
    return true
  }
  const haystack = `${job.source.name}\n${job.source.dir}`.toLocaleLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** One test per view: the search words and each facet's wanted values are worked out once, not once per row. */
function matcher(filters: BatchFilters, context: FilterContext): (job: JobView) => boolean
{
  const words = searchWords(filters.search)
  const wanted = new Map<FilterFacet, Set<string>>()
  for (const chip of filters.chips)
  {
    const values = wanted.get(chip.facet) ?? new Set<string>()
    values.add(chip.value)
    wanted.set(chip.facet, values)
  }
  const facets = [...wanted]
  return (job) => hasWords(job, words) && facets.every(([facet, values]) => jobFacetValues(job, facet, context).some((value) => values.has(value)))
}

/** Whether a job passes a view's filters: some chip of every facet in use, and the search. */
export function matchesFilters(job: JobView, filters: BatchFilters, context: FilterContext = {}): boolean
{
  return matcher(filters, context)(job)
}

/** The rows a view's filters keep, in the order given. */
export function filterRows(rows: readonly JobView[], filters: BatchFilters, context: FilterContext = {}): JobView[]
{
  if (!filtersActive(filters))
  {
    return [...rows]
  }
  return rows.filter(matcher(filters, context))
}

/** Whether any chip or search text narrows the view. */
export function filtersActive(filters: BatchFilters): boolean
{
  return filters.chips.length > 0 || filters.search.trim() !== ''
}

/** Whether two filters keep the same rows; a folder's label does not count. */
export function sameFilter(a: BatchFilter, b: BatchFilter): boolean
{
  return a.facet === b.facet && a.value === b.value
}

/** Whether a view's chips include a filter. */
export function hasFilter(filters: BatchFilters, filter: BatchFilter): boolean
{
  return filters.chips.some((chip) => sameFilter(chip, filter))
}

/** The filters with one more chip; the same object when the chip is already there. */
export function withFilter(filters: BatchFilters, filter: BatchFilter): BatchFilters
{
  return hasFilter(filters, filter) ? filters : { ...filters, chips: [...filters.chips, { ...filter }] }
}

/** The filters without a chip; the same object when the chip is not there. */
export function withoutFilter(filters: BatchFilters, filter: BatchFilter): BatchFilters
{
  return hasFilter(filters, filter) ? { ...filters, chips: filters.chips.filter((chip) => !sameFilter(chip, filter)) } : filters
}

/** The filters with a chip added, or removed when it is there, as a check item in the menu does. */
export function toggledFilter(filters: BatchFilters, filter: BatchFilter): BatchFilters
{
  return hasFilter(filters, filter) ? withoutFilter(filters, filter) : withFilter(filters, filter)
}

/** The filters with new search text; the same object when it is unchanged. */
export function withSearch(filters: BatchFilters, search: string): BatchFilters
{
  return filters.search === search ? filters : { ...filters, search }
}

const STATUS_CHIPS: Readonly<Record<StatusValue, string>> =
{
  'ready': 'Ready',
  'warnings': 'With warnings',
  'blocked': 'Blocked',
  'will-skip': 'Will skip',
  'attention': 'Needs attention',
  'queued': 'Queued',
  'running': 'Running',
  'held': 'Held for a decision',
  'done': 'Done',
  'failed': 'Failed',
  'canceled': 'Canceled',
  'skipped': 'Skipped',
  'interrupted': 'Interrupted'
}

const CHANNEL_CHIPS: Readonly<Record<ChannelClass, string>> =
{
  'mono': 'Mono audio',
  'stereo': 'Stereo audio',
  '5.1': '5.1 audio',
  '7.1': '7.1 audio',
  'other': 'Other channel layouts'
}

/** A folder as the menu and its chip name it: the last two folders of the path. */
export function folderLabel(dir: string): string
{
  const parts = dir.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length <= 2)
  {
    return dir
  }
  const separator = dir.includes('\\') ? '\\' : '/'
  return parts.slice(-2).join(separator)
}

/** The chip text, which names what the filter keeps: "Audio only", "Folder: Season 3\Extras", "Needs attention". */
export function filterChipLabel(filter: BatchFilter): string
{
  const value = filter.value
  switch (filter.facet)
  {
    case 'type':
      return value === 'video' ? 'With video' : 'Audio only'
    case 'channels':
      return CHANNEL_CHIPS[value as ChannelClass] ?? `${value} audio`
    case 'container':
      return value === '' ? 'Files without an extension' : `${value.toUpperCase()} files`
    case 'folder':
      return `Folder: ${filter.label ?? folderLabel(value)}`
    case 'operation':
      return `${operationLabel(value as Operation) ?? value} jobs`
    case 'recipe':
      return `Operation: ${value}`
    case 'edited':
      return 'Edited presets'
    case 'album':
      return 'In an album group'
    case 'status':
      return STATUS_CHIPS[value as StatusValue] ?? value
    case 'batch':
      return value === NOT_IN_BATCH ? 'Not in a batch' : `In ${formatRunLabel(value as RunId)}`
  }
}

/** A view's chips with their text, in the order they were added. */
export function filterChips(filters: BatchFilters): Array<{ filter: BatchFilter; label: string }>
{
  return filters.chips.map((filter) => ({ filter, label: filterChipLabel(filter) }))
}

/** The groups of the Filter menu; Edited and In an album group sit in Recipe. */
export type FilterMenuGroupId = 'type' | 'channels' | 'container' | 'folder' | 'operation' | 'recipe' | 'status' | 'batch'

/** One check item of the Filter menu, with the number of rows it would keep. */
export interface FilterOption
{
  filter: BatchFilter
  label: string
  count: number
  checked: boolean
}

/** One group of the Filter menu. */
export interface FilterMenuGroup
{
  id: FilterMenuGroupId
  label: string
  options: FilterOption[]
}

const GROUP_LABELS: Readonly<Record<FilterMenuGroupId, string>> =
{
  type: 'Type',
  channels: 'Channels',
  container: 'Container',
  folder: 'Folder',
  operation: 'Operation',
  recipe: 'Recipe',
  status: 'Status',
  batch: 'Batch'
}

const TYPE_OPTIONS: Readonly<Record<MediaType, string>> = { video: 'Video', audio: 'Audio only' }

const CHANNEL_OPTIONS: Readonly<Record<ChannelClass, string>> = { 'mono': 'Mono', 'stereo': 'Stereo', '5.1': '5.1', '7.1': '7.1', 'other': 'Other' }

const STATUS_OPTIONS: Readonly<Record<StatusValue, string>> =
{
  'ready': 'Ready',
  'warnings': 'Warnings',
  'blocked': 'Blocked',
  'will-skip': 'Will skip',
  'attention': 'Needs attention',
  'queued': 'Queued',
  'running': 'Running',
  'held': 'Held',
  'done': 'Done',
  'failed': 'Failed',
  'canceled': 'Canceled',
  'skipped': 'Skipped',
  'interrupted': 'Interrupted'
}

/** Status items the menu always lists; the run states and Will skip appear once a row or a chip has them. */
const STATUS_ALWAYS: ReadonlySet<StatusValue> = new Set(['ready', 'warnings', 'blocked', 'attention'])

type FacetCounts = Map<FilterFacet, Map<string, number>>

function countFacets(rows: readonly JobView[], context: FilterContext): FacetCounts
{
  const counts: FacetCounts = new Map(FILTER_FACETS.map((facet) => [facet, new Map<string, number>()]))
  for (const job of rows)
  {
    for (const facet of FILTER_FACETS)
    {
      const values = counts.get(facet) as Map<string, number>
      for (const value of jobFacetValues(job, facet, context))
      {
        values.set(value, (values.get(value) ?? 0) + 1)
      }
    }
  }
  return counts
}

/** The values a data-driven group lists: those some row carries, then those a chip keeps although no row has them. */
function presentValues(counts: FacetCounts, active: BatchFilters, facet: FilterFacet): string[]
{
  const values = new Set((counts.get(facet) as Map<string, number>).keys())
  for (const chip of active.chips)
  {
    if (chip.facet === facet)
    {
      values.add(chip.value)
    }
  }
  return [...values]
}

function option(counts: FacetCounts, active: BatchFilters, filter: BatchFilter, label: string): FilterOption
{
  return { filter, label, count: (counts.get(filter.facet) as Map<string, number>).get(filter.value) ?? 0, checked: hasFilter(active, filter) }
}

/** Folder items read as their last two folders; folders that would read alike show their whole path. */
function folderOptions(counts: FacetCounts, active: BatchFilters): FilterOption[]
{
  const dirs = presentValues(counts, active, 'folder')
  const short = new Map(dirs.map((dir) => [dir, folderLabel(dir)]))
  const uses = new Map<string, number>()
  for (const label of short.values())
  {
    uses.set(label, (uses.get(label) ?? 0) + 1)
  }
  return dirs
    .map((dir) =>
    {
      const shortLabel = short.get(dir) as string
      const label = (uses.get(shortLabel) as number) > 1 ? dir : shortLabel
      return option(counts, active, { facet: 'folder', value: dir, label }, label)
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.filter.value.localeCompare(b.filter.value))
}

function runOrder(value: string): number
{
  return value === NOT_IN_BATCH ? Number.POSITIVE_INFINITY : parseRunId(value) ?? -1
}

/**
 * The Filter menu over a mode's rows (before its filters), each item with the number of rows it keeps and whether
 * a chip already keeps it. Type, Channels, Ready, Warnings, Blocked, Needs attention, Edited, In an album group,
 * and Not in a batch are always listed; containers, folders, operations, recipes, run states, and batches only
 * when a row or a chip has them. Recipes are listed by count, batches newest first.
 */
export function filterMenu(rows: readonly JobView[], active: BatchFilters = NO_FILTERS, context: FilterContext = {}): FilterMenuGroup[]
{
  const counts = countFacets(rows, context)
  const group = (id: FilterMenuGroupId, options: FilterOption[]): FilterMenuGroup => ({ id, label: GROUP_LABELS[id], options })
  const containers = presentValues(counts, active, 'container')
    .sort((a, b) => a.localeCompare(b))
    .map((value) => option(counts, active, { facet: 'container', value }, value === '' ? 'No extension' : value.toUpperCase()))
  const operations = new Set(presentValues(counts, active, 'operation'))
  const recipes = presentValues(counts, active, 'recipe')
    .map((value) => option(counts, active, { facet: 'recipe', value }, value))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const statusPresent = new Set(presentValues(counts, active, 'status'))
  const batches = new Set([NOT_IN_BATCH, ...presentValues(counts, active, 'batch')])
  return [
    group('type', MEDIA_TYPES.map((value) => option(counts, active, { facet: 'type', value }, TYPE_OPTIONS[value]))),
    group('channels', CHANNEL_CLASSES.map((value) => option(counts, active, { facet: 'channels', value }, CHANNEL_OPTIONS[value]))),
    group('container', containers),
    group('folder', folderOptions(counts, active)),
    group('operation', OPERATIONS.filter((op) => operations.has(op)).map((value) => option(counts, active, { facet: 'operation', value }, operationLabel(value)))),
    group('recipe', [
      ...recipes,
      option(counts, active, { facet: 'edited', value: 'edited' }, 'Edited'),
      option(counts, active, { facet: 'album', value: 'album' }, 'In an album group')
    ]),
    group('status', STATUS_VALUES
      .filter((value) => STATUS_ALWAYS.has(value) || statusPresent.has(value))
      .map((value) => option(counts, active, { facet: 'status', value }, STATUS_OPTIONS[value]))),
    group('batch', [...batches]
      .sort((a, b) => runOrder(b) - runOrder(a))
      .map((value) => option(counts, active, { facet: 'batch', value }, value === NOT_IN_BATCH ? 'Not in a batch' : `In ${formatRunLabel(value as RunId)}`)))
  ]
}

/** What Select similar compares with the focused row. */
export type SimilarBasis = 'type' | 'recipe' | 'folder' | 'extension'

/** Every Select similar item, in menu order. */
export const SIMILAR_BASES: readonly SimilarBasis[] = ['type', 'recipe', 'folder', 'extension']

const SIMILAR_ITEMS: Readonly<Record<SimilarBasis, string>> =
{
  type: 'Same type',
  recipe: 'Same operation',
  folder: 'Same folder',
  extension: 'Same extension'
}

const SIMILAR_PHRASES: Readonly<Record<SimilarBasis, string>> =
{
  type: 'with the same type',
  recipe: 'with the same recipe',
  folder: 'in the same folder',
  extension: 'with the same extension'
}

/** The row menu item for a basis: "Same type", "Same recipe", "Same folder", "Same extension". */
export function similarItemLabel(basis: SimilarBasis): string
{
  return SIMILAR_ITEMS[basis]
}

/** Whether two rows match on a basis; the same recipe means the same label and the same values. */
export function isSimilar(a: JobView, b: JobView, basis: SimilarBasis): boolean
{
  switch (basis)
  {
    case 'type':
      return mediaTypeOf(a) === mediaTypeOf(b)
    case 'recipe':
      return a.recipeLabel === b.recipeLabel && sameRecipeValues(a.recipe, b.recipe)
    case 'folder':
      return a.source.dir === b.source.dir
    case 'extension':
      return extensionOf(a) === extensionOf(b)
  }
}

/** Select similar: every visible row that matches the focused row on the basis, in the order shown. */
export function similarRowIds(focused: JobView, visible: readonly JobView[], basis: SimilarBasis): string[]
{
  return visible.filter((row) => isSimilar(focused, row, basis)).map((row) => row.id)
}

const COUNT_FORMAT = new Intl.NumberFormat('en-US')

/** A count as the page writes it: "1,000". */
export function formatCount(count: number): string
{
  return COUNT_FORMAT.format(count)
}

function jobs(count: number): string
{
  return `${formatCount(count)} ${count === 1 ? 'job' : 'jobs'}`
}

/** The polite announcement after Select similar: "Selected 12 jobs in the same folder." */
export function selectedSimilarMessage(count: number, basis: SimilarBasis): string
{
  return `Selected ${jobs(count)} ${SIMILAR_PHRASES[basis]}.`
}

/** The polite announcement when a filter hides selected rows; null when it hid none. */
export function hiddenSelectionMessage(count: number): string | null
{
  if (count <= 0)
  {
    return null
  }
  return count === 1
    ? '1 selected job is hidden by the filter and was deselected.'
    : `${formatCount(count)} selected jobs are hidden by the filter and were deselected.`
}

/** The toolbar's count of what the filters keep: "Showing 12 of 40". */
export function showingLabel(visible: number, total: number): string
{
  return `Showing ${formatCount(visible)} of ${formatCount(total)}`
}

/** The toolbar's selection count: "8 selected". */
export function selectedLabel(count: number): string
{
  return `${formatCount(count)} selected`
}

/** What the toolbar shows after the chips. */
export interface ToolbarCounts
{
  showing: string | null
  selected: string | null
}

/**
 * The counts after the chips: "Showing {k} of {n}" while any filter is active, and "{s} selected" whenever more
 * than one row is selected, or any row while a filter is active.
 */
export function toolbarCounts(filters: BatchFilters, visible: number, total: number, selected: number): ToolbarCounts
{
  const active = filtersActive(filters)
  return {
    showing: active ? showingLabel(visible, total) : null,
    selected: selected > 1 || (active && selected > 0) ? selectedLabel(selected) : null
  }
}

/**
 * Guards the Batch view's filter rules: facet values per job, chips that combine within a facet and narrow across
 * facets, the search over names and folders, chip text that names what a filter keeps, Needs attention read from
 * needsAttention alone, Select similar over visible rows, and the counts the toolbar and live region read.
 */
import { describe, expect, it } from 'vitest'
import {
  channelClass,
  EDITED_SUFFIX,
  extensionOf,
  filterChipLabel,
  filterChips,
  filterMenu,
  filterRows,
  filtersActive,
  folderLabel,
  formatCount,
  hasFilter,
  hiddenSelectionMessage,
  isEditedJob,
  isSimilar,
  selectedLabel,
  selectedSimilarMessage,
  showingLabel,
  SIMILAR_BASES,
  similarItemLabel,
  similarRowIds,
  toolbarCounts,
  jobFacetValues,
  matchesFilters,
  matchesSearch,
  mediaTypeOf,
  NO_FILTERS,
  NOT_IN_BATCH,
  planStatusOf,
  recipeKey,
  sameFilter,
  toggledFilter,
  withFilter,
  withoutFilter,
  withSearch,
  type BatchFilter,
  type BatchFilters
} from '../../src/renderer/src/stores/batchFilters'
import type { JobView } from '../../src/shared/jobs/types'

type Over = Partial<Omit<JobView, 'source' | 'media'>> & { source?: Partial<JobView['source']>; media?: Partial<NonNullable<JobView['media']>> | null }

const stereo = { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: null, isDefault: true }

function job(id: string, over: Over = {}): JobView
{
  const { source, media, ...rest } = over
  return {
    id,
    seq: 1,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Media\\Show\\Season 3\\${id}.mkv`, name: `${id}.mkv`, ext: '.mkv', dir: 'D:\\Media\\Show\\Season 3', size: 1000, mtimeMs: 1, origin: 'files', subdir: '', ...source },
    recipe: { kind: 'normalize', presetId: 'ebu-r128', userPreset: null },
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    reason: null,
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: media === null ? null : { container: 'matroska', durationSec: 60, video: { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 25 }, audio: [stereo], subtitles: 0, attachments: 0, chapters: 0, cover: false, ...media },
    probe: null,
    plan: null,
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
    ...rest
  } as unknown as JobView
}

function plan(status: 'ready' | 'blocked' | 'will-skip', warnings = 0): JobView['plan']
{
  return { status, current: true, finalName: 'a.mkv', relativePath: 'a.mkv', container: 'mkv', resolution: null, encoderLabel: 'copy', errors: status === 'blocked' ? 1 : 0, warnings, firstIssue: null } as unknown as JobView['plan']
}

const warning = { code: 'w', short: 'w', message: 'w' }

function filters(chips: BatchFilter[], search = ''): BatchFilters
{
  return { chips, search }
}

describe('facet values', () =>
{
  it('normalizes the extension without its dot', () =>
  {
    expect(extensionOf(job('a', { source: { ext: '.MKV' } }))).toBe('mkv')
    expect(extensionOf(job('a', { source: { ext: 'flac' } }))).toBe('flac')
    expect(extensionOf(job('a', { source: { ext: '' } }))).toBe('')
  })

  it('reads the media type from the probe summary', () =>
  {
    expect(mediaTypeOf(job('a'))).toBe('video')
    expect(mediaTypeOf(job('a', { media: { video: null } }))).toBe('audio')
    expect(mediaTypeOf(job('a', { media: { video: null, audio: [] } }))).toBeNull()
    expect(mediaTypeOf(job('a', { media: null }))).toBeNull()
  })

  it('classes channels by layout first and by count without one', () =>
  {
    expect(channelClass(1, 'mono')).toBe('mono')
    expect(channelClass(2, 'stereo')).toBe('stereo')
    expect(channelClass(6, '5.1(side)')).toBe('5.1')
    expect(channelClass(8, '7.1(wide)')).toBe('7.1')
    expect(channelClass(6, '6.0')).toBe('other')
    expect(channelClass(1, null)).toBe('mono')
    expect(channelClass(2, '')).toBe('stereo')
    expect(channelClass(6, null)).toBe('5.1')
    expect(channelClass(8, null)).toBe('7.1')
    expect(channelClass(3, null)).toBe('other')
  })

  it('groups edited recipes under the recipe they came from', () =>
  {
    expect(recipeKey(job('a', { recipeLabel: `Normalize · Podcast${EDITED_SUFFIX}` }))).toBe('Normalize · Podcast')
    expect(recipeKey(job('a', { recipeLabel: 'Normalize · Podcast' }))).toBe('Normalize · Podcast')
  })

  it('decides Edited from the label, or from the preset lookup when one is given', () =>
  {
    const edited = job('a', { recipeLabel: `Normalize · Podcast${EDITED_SUFFIX}` })
    expect(isEditedJob(edited)).toBe(true)
    expect(isEditedJob(job('a'))).toBe(false)
    const lookup = (): { label: string; recipe: JobView['recipe'] } => ({ label: 'Podcast', recipe: { kind: 'normalize', presetId: 'ebu-r128', userPreset: null, extra: 1 } as unknown as JobView['recipe'] })
    expect(isEditedJob(job('a'), { lookup })).toBe(true)
    expect(isEditedJob(edited, { lookup: () => null })).toBe(false)
  })

  it('gives jobs not in a batch their plan status and other jobs their run state', () =>
  {
    expect(planStatusOf(job('a'))).toBeNull()
    expect(planStatusOf(job('a', { plan: plan('ready') }))).toBe('ready')
    expect(planStatusOf(job('a', { plan: plan('ready', 2) }))).toBe('warnings')
    expect(planStatusOf(job('a', { plan: plan('blocked') }))).toBe('blocked')
    expect(planStatusOf(job('a', { plan: plan('will-skip') }))).toBe('will-skip')
    expect(planStatusOf(job('a', { state: 'queued', plan: plan('ready') }))).toBe('queued')
    expect(planStatusOf(job('a', { state: 'encoding' }))).toBe('running')
    expect(planStatusOf(job('a', { state: 'analyzing' }))).toBe('running')
    expect(planStatusOf(job('a', { state: 'failed' }))).toBe('failed')
  })

  it('lists each facet value a job carries', () =>
  {
    const surround = { ...stereo, channels: 6, layout: '5.1' }
    const multi = job('a', { media: { audio: [stereo, surround, stereo] }, runId: 'R-0031' as JobView['runId'], albumGroupId: 'g1' })
    expect(jobFacetValues(multi, 'type')).toEqual(['video'])
    expect(jobFacetValues(job('a', { media: null }), 'type')).toEqual([])
    expect(jobFacetValues(multi, 'channels')).toEqual(['stereo', '5.1'])
    expect(jobFacetValues(job('a', { media: null }), 'channels')).toEqual([])
    expect(jobFacetValues(multi, 'container')).toEqual(['mkv'])
    expect(jobFacetValues(multi, 'folder')).toEqual(['D:\\Media\\Show\\Season 3'])
    expect(jobFacetValues(multi, 'operation')).toEqual(['normalize'])
    expect(jobFacetValues(multi, 'recipe')).toEqual(['Normalize · Streaming (EBU R 128 s2)'])
    expect(jobFacetValues(multi, 'edited')).toEqual([])
    expect(jobFacetValues(job('a', { recipeLabel: `X${EDITED_SUFFIX}` }), 'edited')).toEqual(['edited'])
    expect(jobFacetValues(multi, 'album')).toEqual(['album'])
    expect(jobFacetValues(job('a'), 'album')).toEqual([])
    expect(jobFacetValues(multi, 'batch')).toEqual(['R-0031'])
    expect(jobFacetValues(job('a'), 'batch')).toEqual([NOT_IN_BATCH])
    expect(jobFacetValues(job('a'), 'status')).toEqual([])
    expect(jobFacetValues(job('a', { state: 'failed' }), 'status')).toEqual(['failed', 'attention'])
  })
})

describe('Needs attention', () =>
{
  const attention: BatchFilter = { facet: 'status', value: 'attention' }

  it('keeps exactly the jobs needsAttention names', () =>
  {
    const rows = [
      job('held', { state: 'held' }),
      job('held-ack', { state: 'held', acknowledged: true }),
      job('failed', { state: 'failed' }),
      job('failed-ack', { state: 'failed', acknowledged: true }),
      job('interrupted', { state: 'interrupted' }),
      job('done-warn', { state: 'done', warnings: [warning] as JobView['warnings'] }),
      job('done-warn-ack', { state: 'done', warnings: [warning] as JobView['warnings'], acknowledged: true }),
      job('done', { state: 'done' }),
      job('blocked', { plan: plan('blocked') }),
      job('canceled', { state: 'canceled' })
    ]
    expect(filterRows(rows, filters([attention])).map((row) => row.id)).toEqual(['held', 'held-ack', 'failed', 'interrupted', 'done-warn'])
  })
})

describe('matching', () =>
{
  it('matches every search word against the file name or the folder, ignoring case', () =>
  {
    const row = job('Interview-03', { source: { name: 'Interview-03.wav', dir: 'D:\\Podcasts\\Season 3' } })
    expect(matchesSearch(row, '')).toBe(true)
    expect(matchesSearch(row, '   ')).toBe(true)
    expect(matchesSearch(row, 'interview')).toBe(true)
    expect(matchesSearch(row, 'PODCASTS interview')).toBe(true)
    expect(matchesSearch(row, 'season  03')).toBe(true)
    expect(matchesSearch(row, 'concert')).toBe(false)
  })

  it('widens within a facet and narrows across facets', () =>
  {
    const rows = [
      job('a', { source: { ext: '.mkv' } }),
      job('b', { source: { ext: '.mp4' } }),
      job('c', { source: { ext: '.wav' }, media: { video: null } }),
      job('d', { source: { ext: '.mp4' }, media: { video: null } })
    ]
    const mkv: BatchFilter = { facet: 'container', value: 'mkv' }
    const mp4: BatchFilter = { facet: 'container', value: 'mp4' }
    const video: BatchFilter = { facet: 'type', value: 'video' }
    expect(filterRows(rows, filters([mkv, mp4])).map((row) => row.id)).toEqual(['a', 'b', 'd'])
    expect(filterRows(rows, filters([mkv, mp4, video])).map((row) => row.id)).toEqual(['a', 'b'])
    expect(filterRows(rows, filters([mp4], 'd.mkv')).map((row) => row.id)).toEqual(['d'])
    expect(matchesFilters(rows[2], filters([video]))).toBe(false)
    expect(matchesFilters(rows[2], filters([], 'zzz'))).toBe(false)
  })

  it('returns a copy of the rows when nothing narrows them', () =>
  {
    const rows = [job('a'), job('b')]
    const kept = filterRows(rows, NO_FILTERS)
    expect(kept).toEqual(rows)
    expect(kept).not.toBe(rows)
  })

  it('passes the preset lookup to the Edited facet', () =>
  {
    const row = job('a')
    const lookup = (): { label: string; recipe: JobView['recipe'] } => ({ label: 'P', recipe: { kind: 'normalize', presetId: 'p', userPreset: null, other: true } as unknown as JobView['recipe'] })
    expect(matchesFilters(row, filters([{ facet: 'edited', value: 'edited' }]))).toBe(false)
    expect(matchesFilters(row, filters([{ facet: 'edited', value: 'edited' }]), { lookup })).toBe(true)
  })
})

describe('filter edits', () =>
{
  const mkv: BatchFilter = { facet: 'container', value: 'mkv' }

  it('tells whether any chip or search text is active', () =>
  {
    expect(filtersActive(NO_FILTERS)).toBe(false)
    expect(filtersActive(filters([], '  '))).toBe(false)
    expect(filtersActive(filters([], 'a'))).toBe(true)
    expect(filtersActive(filters([mkv]))).toBe(true)
  })

  it('compares filters by facet and value, not by label', () =>
  {
    expect(sameFilter({ facet: 'folder', value: 'D:\\a', label: 'a' }, { facet: 'folder', value: 'D:\\a' })).toBe(true)
    expect(sameFilter(mkv, { facet: 'container', value: 'mp4' })).toBe(false)
    expect(sameFilter(mkv, { facet: 'folder', value: 'mkv' })).toBe(false)
  })

  it('adds, removes, and toggles chips, and keeps the same object when nothing changes', () =>
  {
    const one = withFilter(NO_FILTERS, mkv)
    expect(one.chips).toEqual([mkv])
    expect(hasFilter(one, { ...mkv })).toBe(true)
    expect(withFilter(one, { ...mkv })).toBe(one)
    expect(withoutFilter(NO_FILTERS, mkv)).toBe(NO_FILTERS)
    expect(withoutFilter(one, mkv).chips).toEqual([])
    expect(toggledFilter(one, mkv).chips).toEqual([])
    expect(toggledFilter(NO_FILTERS, mkv).chips).toEqual([mkv])
    expect(withSearch(one, '')).toBe(one)
    expect(withSearch(one, 'abc')).toEqual({ chips: [mkv], search: 'abc' })
    expect(NO_FILTERS.chips).toEqual([])
  })
})

describe('chip text', () =>
{
  it('shortens a folder to its last two folders', () =>
  {
    expect(folderLabel('D:\\Media\\Show\\Season 3\\Extras')).toBe('Season 3\\Extras')
    expect(folderLabel('/home/me/music/live')).toBe('music/live')
    expect(folderLabel('D:\\Media')).toBe('D:\\Media')
  })

  it('names what each filter keeps', () =>
  {
    const label = (facet: BatchFilter['facet'], value: string, extra?: string): string => filterChipLabel({ facet, value, label: extra })
    expect(label('type', 'video')).toBe('With video')
    expect(label('type', 'audio')).toBe('Audio only')
    expect(label('channels', 'mono')).toBe('Mono audio')
    expect(label('channels', 'stereo')).toBe('Stereo audio')
    expect(label('channels', '5.1')).toBe('5.1 audio')
    expect(label('channels', '7.1')).toBe('7.1 audio')
    expect(label('channels', 'other')).toBe('Other channel layouts')
    expect(label('channels', 'quad')).toBe('quad audio')
    expect(label('container', 'mkv')).toBe('MKV files')
    expect(label('container', '')).toBe('Files without an extension')
    expect(label('folder', 'D:\\Media\\Show\\Season 3\\Extras')).toBe('Folder: Season 3\\Extras')
    expect(label('folder', 'D:\\Media\\Show\\Season 3\\Extras', 'Show\\Season 3\\Extras')).toBe('Folder: Show\\Season 3\\Extras')
    expect(label('operation', 'boost')).toBe('Gain jobs')
    expect(label('operation', 'normalize')).toBe('Normalize jobs')
    expect(label('operation', 'unknown')).toBe('unknown jobs')
    expect(label('recipe', 'Compress · Web 1080p')).toBe('Operation: Compress · Web 1080p')
    expect(label('edited', 'edited')).toBe('Edited presets')
    expect(label('album', 'album')).toBe('In an album group')
    expect(label('status', 'attention')).toBe('Needs attention')
    expect(label('status', 'warnings')).toBe('With warnings')
    expect(label('status', 'held')).toBe('Held for a decision')
    expect(label('status', 'odd')).toBe('odd')
    expect(label('batch', NOT_IN_BATCH)).toBe('Not in a batch')
    expect(label('batch', 'R-0031')).toBe('In Batch 31')
  })

  it('lists the chips in the order they were added', () =>
  {
    const chips = filterChips(filters([{ facet: 'status', value: 'attention' }, { facet: 'type', value: 'audio' }]))
    expect(chips.map((chip) => chip.label)).toEqual(['Needs attention', 'Audio only'])
  })
})

describe('filter menu', () =>
{
  const surround = { ...stereo, channels: 6, layout: '5.1' }
  const rows = [
    job('a', { source: { ext: '.mkv', dir: 'D:\\Media\\Show\\Season 3' }, plan: plan('ready') }),
    job('b', { source: { ext: '.MP4', dir: 'E:\\Backup\\Show\\Season 3' }, plan: plan('blocked'), media: { audio: [surround] } }),
    job('c', { source: { ext: '.wav', dir: 'D:\\Music' }, media: { video: null }, recipe: { kind: 'boost', presetId: 'gentle', userPreset: null } as unknown as JobView['recipe'], recipeLabel: `Gain · Gentle lift${EDITED_SUFFIX}`, albumGroupId: 'g' }),
    job('d', { state: 'failed', runId: 'R-0009' as JobView['runId'], recipeLabel: 'Gain · Gentle lift', recipe: { kind: 'boost', presetId: 'gentle', userPreset: null } as unknown as JobView['recipe'] }),
    job('e', { state: 'done', runId: 'R-0031' as JobView['runId'], recipeLabel: 'Gain · Gentle lift', recipe: { kind: 'boost', presetId: 'gentle', userPreset: null } as unknown as JobView['recipe'] })
  ]

  function groupOf(menu: ReturnType<typeof filterMenu>, id: string): ReturnType<typeof filterMenu>[number]
  {
    return menu.find((group) => group.id === id) as ReturnType<typeof filterMenu>[number]
  }

  function items(menu: ReturnType<typeof filterMenu>, id: string): Array<[string, number]>
  {
    return groupOf(menu, id).options.map((item) => [item.label, item.count])
  }

  it('lists every group in menu order with its caption', () =>
  {
    const menu = filterMenu(rows)
    expect(menu.map((group) => group.label)).toEqual(['Type', 'Channels', 'Container', 'Folder', 'Operation', 'Recipe', 'Status', 'Batch'])
  })

  it('counts the fixed groups, listing empty items too', () =>
  {
    const menu = filterMenu(rows)
    expect(items(menu, 'type')).toEqual([['Video', 4], ['Audio only', 1]])
    expect(items(menu, 'channels')).toEqual([['Mono', 0], ['Stereo', 4], ['5.1', 1], ['7.1', 0], ['Other', 0]])
  })

  it('lists each container, folder, operation, and recipe present, with counts', () =>
  {
    const menu = filterMenu(rows)
    expect(items(menu, 'container')).toEqual([['MKV', 3], ['MP4', 1], ['WAV', 1]])
    expect(items(menu, 'folder')).toEqual([['D:\\Media\\Show\\Season 3', 3], ['D:\\Music', 1], ['E:\\Backup\\Show\\Season 3', 1]])
    expect(items(menu, 'operation')).toEqual([['Normalize', 2], ['Gain', 3]])
    expect(items(menu, 'recipe')).toEqual([['Gain · Gentle lift', 3], ['Normalize · Streaming (EBU R 128 s2)', 2], ['Edited', 1], ['In an album group', 1]])
  })

  it('keeps folder chips named as the menu showed them', () =>
  {
    const menu = filterMenu([job('x', { source: { dir: 'D:\\Media\\Show\\Season 3\\Extras' } })])
    const folder = groupOf(menu, 'folder').options[0]
    expect(folder.label).toBe('Season 3\\Extras')
    expect(filterChipLabel(folder.filter)).toBe('Folder: Season 3\\Extras')
  })

  it('lists the run states and batches only when present, batches newest first', () =>
  {
    const menu = filterMenu(rows)
    expect(items(menu, 'status')).toEqual([['Ready', 1], ['Warnings', 0], ['Blocked', 1], ['Needs attention', 1], ['Done', 1], ['Failed', 1]])
    expect(items(menu, 'batch')).toEqual([['Not in a batch', 3], ['In Batch 31', 1], ['In Batch 9', 1]])
    const empty = filterMenu([])
    expect(items(empty, 'status')).toEqual([['Ready', 0], ['Warnings', 0], ['Blocked', 0], ['Needs attention', 0]])
    expect(items(empty, 'batch')).toEqual([['Not in a batch', 0]])
    expect(items(empty, 'container')).toEqual([])
  })

  it('marks the items a chip keeps and lists a chip whose rows are gone', () =>
  {
    const active = filters([{ facet: 'container', value: 'flac' }, { facet: 'container', value: '' }, { facet: 'type', value: 'audio' }, { facet: 'operation', value: 'extract' }, { facet: 'status', value: 'held' }, { facet: 'batch', value: 'R-0040' }, { facet: 'folder', value: 'F:\\Gone' }])
    const menu = filterMenu(rows, active)
    expect(groupOf(menu, 'container').options.map((item) => [item.label, item.count, item.checked])).toEqual([['No extension', 0, true], ['FLAC', 0, true], ['MKV', 3, false], ['MP4', 1, false], ['WAV', 1, false]])
    expect(groupOf(menu, 'type').options.map((item) => item.checked)).toEqual([false, true])
    expect(items(menu, 'operation')).toEqual([['Normalize', 2], ['Gain', 3], ['Extract', 0]])
    expect(items(menu, 'status')).toContainEqual(['Held', 0])
    expect(items(menu, 'batch')[1]).toEqual(['In Batch 40', 0])
    expect(items(menu, 'folder')).toContainEqual(['F:\\Gone', 0])
  })

  it('orders a malformed batch value last', () =>
  {
    const menu = filterMenu([job('x', { runId: 'odd' as JobView['runId'] }), job('y', { runId: 'R-0002' as JobView['runId'] })])
    expect(items(menu, 'batch').map(([label]) => label)).toEqual(['Not in a batch', 'In Batch 2', 'In odd'])
  })
})

describe('Select similar', () =>
{
  const lift = { kind: 'boost', presetId: 'gentle', userPreset: null } as unknown as JobView['recipe']
  const rows = [
    job('a', { recipe: lift, recipeLabel: 'Gain · Gentle lift' }),
    job('b', { recipe: lift, recipeLabel: 'Gain · Gentle lift', source: { dir: 'E:\\Other', ext: '.mp4' } }),
    job('c', { recipe: { ...lift, gainDb: 3 } as unknown as JobView['recipe'], recipeLabel: 'Gain · Gentle lift', media: { video: null } }),
    job('d', { media: null, source: { ext: '.MKV' } })
  ]

  it('names each basis as the row menu does', () =>
  {
    expect(SIMILAR_BASES.map(similarItemLabel)).toEqual(['Same type', 'Same operation', 'Same folder', 'Same extension'])
  })

  it('matches type, recipe values and label, folder, and extension', () =>
  {
    expect(similarRowIds(rows[0], rows, 'type')).toEqual(['a', 'b'])
    expect(similarRowIds(rows[3], rows, 'type')).toEqual(['d'])
    expect(similarRowIds(rows[0], rows, 'recipe')).toEqual(['a', 'b'])
    expect(similarRowIds(rows[0], rows, 'folder')).toEqual(['a', 'c', 'd'])
    expect(similarRowIds(rows[0], rows, 'extension')).toEqual(['a', 'c', 'd'])
    expect(isSimilar(rows[0], rows[3], 'recipe')).toBe(false)
  })

  it('selects only from the rows given, which are the visible ones', () =>
  {
    expect(similarRowIds(rows[0], rows.slice(0, 1), 'folder')).toEqual(['a'])
  })
})

describe('messages', () =>
{
  it('formats counts with separators', () =>
  {
    expect(formatCount(1000)).toBe('1,000')
    expect(formatCount(7)).toBe('7')
  })

  it('says how many hidden rows a filter deselected', () =>
  {
    expect(hiddenSelectionMessage(0)).toBeNull()
    expect(hiddenSelectionMessage(1)).toBe('1 selected job is hidden by the filter and was deselected.')
    expect(hiddenSelectionMessage(3)).toBe('3 selected jobs are hidden by the filter and were deselected.')
    expect(hiddenSelectionMessage(1200)).toBe('1,200 selected jobs are hidden by the filter and were deselected.')
  })

  it('announces Select similar', () =>
  {
    expect(selectedSimilarMessage(12, 'folder')).toBe('Selected 12 jobs in the same folder.')
    expect(selectedSimilarMessage(1, 'recipe')).toBe('Selected 1 job with the same recipe.')
    expect(selectedSimilarMessage(2, 'type')).toBe('Selected 2 jobs with the same type.')
    expect(selectedSimilarMessage(2, 'extension')).toBe('Selected 2 jobs with the same extension.')
  })

  it('writes the toolbar counts', () =>
  {
    expect(showingLabel(12, 1040)).toBe('Showing 12 of 1,040')
    expect(selectedLabel(8)).toBe('8 selected')
    const active = filters([{ facet: 'type', value: 'audio' }])
    expect(toolbarCounts(NO_FILTERS, 40, 40, 0)).toEqual({ showing: null, selected: null })
    expect(toolbarCounts(NO_FILTERS, 40, 40, 1)).toEqual({ showing: null, selected: null })
    expect(toolbarCounts(NO_FILTERS, 40, 40, 3)).toEqual({ showing: null, selected: '3 selected' })
    expect(toolbarCounts(active, 12, 40, 0)).toEqual({ showing: 'Showing 12 of 40', selected: null })
    expect(toolbarCounts(active, 12, 40, 1)).toEqual({ showing: 'Showing 12 of 40', selected: '1 selected' })
    expect(toolbarCounts(filters([], 'live'), 2, 40, 0)).toEqual({ showing: 'Showing 2 of 40', selected: null })
  })
})

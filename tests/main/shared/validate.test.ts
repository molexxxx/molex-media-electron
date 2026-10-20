/**
 * Request and recipe validation at the IPC boundary: every command accepts its smallest valid request and answers
 * wrong types, out-of-range numbers, unknown enums, relative paths, and oversized lists with one issue per problem at
 * its JSON path; every recipe kind passes at its range limits and fails one step outside each.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_PAGE,
  MAX_PATH_LENGTH,
  MAX_REQUEST_ITEMS,
  MAX_TEMPLATE_LENGTH,
  REQUEST_VALIDATORS,
  createRequestValidators,
  isAbsolutePath,
  normalizePath,
  reservedFolderName,
  validateRecipe
} from '../../../src/shared/jobs/validate'
import { JOB_COMMAND_NAMES, type JobCommandName } from '../../../src/shared/jobs/contract'
import { formatCatalog, formatRunId } from '../../../src/shared/jobs/ids'
import { CRF_RANGES, JOB_LIMITS } from '../../../src/shared/jobs/limits'
import { VIDEO_ENCODERS } from '../../../src/shared/jobs/recipes'
import { AUDIO_LIMITS } from '../../../src/shared/audio/limits'
import { DEFAULT_LOUDNESS_PRESET, applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'

type Plain = Record<string, unknown>

const ID = formatCatalog(1)
const ID2 = formatCatalog(2)
const RUN = formatRunId(1)

const CONVERT: Plain = { kind: 'convert', presetId: null, userPreset: null, container: 'mp4', video: null, audio: { kind: 'copy' }, channels: 'keep', subtitles: 'keep' }

const OVERSIZED_IDS = Array.from({ length: MAX_REQUEST_ITEMS + 1 }, (_, i) => formatCatalog(i))

/** The smallest valid request of every command. */
const SMALLEST: Record<JobCommandName, Plain> =
{
  subscribe: { clientId: 'c' },
  unsubscribe: { clientId: 'c' },
  get: { jobId: ID },
  add: { paths: ['/m/a.mkv'], recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false },
  pasteFiles: { recipe: null, recursive: false },
  cancelScan: { scanId: 's' },
  forgetFolder: { path: '/m' },
  clearRecentFolders: {},
  remove: { ids: [ID] },
  restore: { tombstone: 't' },
  reorder: { ids: [ID], before: null },
  assignRecipe: { assignments: [{ jobId: ID, recipe: CONVERT }] },
  duplicate: { ids: [ID], recipe: null },
  locate: { jobId: ID, path: '/m/a.mkv' },
  relink: { fromDir: '/a', toDir: '/b', ids: 'missing' },
  reprobe: { ids: [ID] },
  setPolicy: { policy: { destination: { mode: 'next-to-source' }, template: '', conflict: 'skip', displaced: 'trash', gpu: 'off' } },
  setDefaultRecipe: { recipe: CONVERT },
  preflight: { ids: 'pending' },
  analyze: { ids: [ID] },
  cancelAnalyze: { ids: 'all' },
  start: { preflightId: 'p', ack: null, resume: false },
  pause: { mode: 'finish-running' },
  resume: { ack: null },
  cancelRun: {},
  setWorkers: { workers: { mode: 'auto' }, gpuSessions: null },
  setSettings: { settings: {} },
  dismissAlert: { alertId: 'a' },
  revealAlert: { alertId: 'a' },
  cancel: { ids: [ID] },
  skip: { ids: [ID] },
  unqueue: { ids: [ID] },
  retry: { ids: 'failed', recipe: null, ack: null, start: false },
  keepOutput: { ids: [ID], placement: 'planned', confirm: null },
  discardOutput: { ids: [ID] },
  acknowledge: { ids: [ID] },
  clear: { scope: { kind: 'done' } },
  log: { jobId: ID, attempt: null },
  reveal: { jobId: ID, target: 'source' },
  exportReport: { scope: { runId: RUN }, format: 'csv' },
  listRuns: { before: null, limit: 1 },
  getRun: { runId: RUN, offset: 0, limit: 1 },
  searchRuns: { query: 'a', limit: 1, before: null },
  rerun: { runId: RUN, jobIds: 'all', force: false },
  deleteRuns: { runIds: 'all' },
  revealRecord: { runId: RUN, jobId: ID, attempt: 1, target: 'output' },
  savePreset: { id: null, name: 'A', recipe: CONVERT, pin: null },
  renamePreset: { id: 'u', name: 'A' },
  removePreset: { id: 'u' },
  setPin: { key: 1, presetId: null }
}

type Case = [string, Plain, string[]]

const ID_LIST_CASES = (key: string): Case[] => [
  ['a single id instead of a list', { [key]: ID }, [key]],
  ['an empty list', { [key]: [] }, [key]],
  ['an oversized list', { [key]: OVERSIZED_IDS }, [key]],
  ['malformed and wrongly typed ids', { [key]: ['MM-1', ID, 7] }, [`${key}[0]`, `${key}[2]`]]
]

const BAD_RECIPE: Plain = { ...CONVERT, container: 'MP4!', channels: 'surround' }

/** Bad requests per command: the change from the smallest valid request and the issue paths it must produce. */
const BAD: Record<JobCommandName, Case[]> =
{
  subscribe: [['a number', { clientId: 5 }, ['clientId']], ['an empty id', { clientId: '' }, ['clientId']], ['an oversized id', { clientId: 'x'.repeat(201) }, ['clientId']]],
  unsubscribe: [['a missing id', { clientId: undefined }, ['clientId']]],
  get: [['a malformed id', { jobId: 'MM-1' }, ['jobId']], ['a number', { jobId: 7 }, ['jobId']]],
  add: [
    ['a path instead of a list', { paths: '/m/a.mkv' }, ['paths']],
    ['an empty list', { paths: [] }, ['paths']],
    ['an oversized list', { paths: Array.from({ length: MAX_REQUEST_ITEMS + 1 }, (_, i) => `/m/${i}.mkv`) }, ['paths']],
    ['relative and wrongly typed paths', { paths: ['/m/a.mkv', 'a.mkv', 5, './b.mkv', 'C:b.mkv'] }, ['paths[1]', 'paths[2]', 'paths[3]', 'paths[4]']],
    ['a path with a NUL character', { paths: ['/m/a\0.mkv'] }, ['paths[0]']],
    ['an overlong path', { paths: [`/${'a'.repeat(MAX_PATH_LENGTH)}`] }, ['paths[0]']],
    ['a bad recipe', { recipe: BAD_RECIPE }, ['recipe.container', 'recipe.channels']],
    ['an unknown origin', { origin: 'paste' }, ['origin']],
    ['a malformed after', { after: 'MM-1' }, ['after']],
    ['flags that are not booleans', { recursive: 'yes', allowSecondJobs: 1, force: null }, ['recursive', 'allowSecondJobs', 'force']]
  ],
  pasteFiles: [['an unknown recipe kind', { recipe: { kind: 'trim' } }, ['recipe.kind']], ['a flag that is not a boolean', { recursive: 'no' }, ['recursive']]],
  cancelScan: [['a null id', { scanId: null }, ['scanId']]],
  forgetFolder: [['a relative path', { path: 'music' }, ['path']], ['a number', { path: 5 }, ['path']]],
  clearRecentFolders: [['an unknown field', { all: true }, ['all']]],
  remove: ID_LIST_CASES('ids'),
  restore: [['an empty token', { tombstone: '' }, ['tombstone']]],
  reorder: [...ID_LIST_CASES('ids'), ['a malformed before', { before: 'R-0001' }, ['before']]],
  assignRecipe: [
    ['an empty list', { assignments: [] }, ['assignments']],
    ['an oversized list', { assignments: OVERSIZED_IDS.map((jobId) => ({ jobId, recipe: CONVERT })) }, ['assignments']],
    ['an entry that is not an object', { assignments: [5] }, ['assignments[0]']],
    ['a malformed job id', { assignments: [{ jobId: 'x', recipe: CONVERT }] }, ['assignments[0].jobId']],
    ['a missing recipe', { assignments: [{ jobId: ID }] }, ['assignments[0].recipe']],
    ['a bad recipe in the second entry', { assignments: [{ jobId: ID, recipe: CONVERT }, { jobId: ID2, recipe: BAD_RECIPE }] },
      ['assignments[1].recipe.container', 'assignments[1].recipe.channels']],
    ['the same job twice', { assignments: [{ jobId: ID, recipe: CONVERT }, { jobId: ID, recipe: CONVERT }] }, ['assignments[1].jobId']],
    ['an unknown field', { assignments: [{ jobId: ID, recipe: CONVERT, note: 'x' }] }, ['assignments[0].note']]
  ],
  duplicate: [...ID_LIST_CASES('ids'), ['a bad recipe', { recipe: { ...CONVERT, subtitles: 'burn' } }, ['recipe.subtitles']]],
  locate: [['a relative path', { path: 'a.mkv' }, ['path']], ['a malformed id', { jobId: 'MM-01' }, ['jobId']]],
  relink: [
    ['relative folders', { fromDir: 'old', toDir: 5 }, ['fromDir', 'toDir']],
    ['an unknown word', { ids: 'all' }, ['ids']],
    ...ID_LIST_CASES('ids')
  ],
  reprobe: ID_LIST_CASES('ids'),
  setPolicy: [
    ['no policy', { policy: null }, ['policy']],
    ['an unknown destination', { policy: { ...(SMALLEST.setPolicy.policy as Plain), destination: { mode: 'cloud' } } }, ['policy.destination.mode']],
    ['a relative folder', { policy: { ...(SMALLEST.setPolicy.policy as Plain), destination: { mode: 'folder', folder: 'out' } } }, ['policy.destination.folder']],
    ['a folder on a next-to-source destination', { policy: { ...(SMALLEST.setPolicy.policy as Plain), destination: { mode: 'next-to-source', folder: '/out' } } },
      ['policy.destination.folder']],
    ['a template that is not a string', { policy: { ...(SMALLEST.setPolicy.policy as Plain), template: 5 } }, ['policy.template']],
    ['an overlong template', { policy: { ...(SMALLEST.setPolicy.policy as Plain), template: 'x'.repeat(MAX_TEMPLATE_LENGTH + 1) } }, ['policy.template']],
    ['unknown rules', { policy: { ...(SMALLEST.setPolicy.policy as Plain), conflict: 'ask', displaced: 'delete', gpu: 'on' } },
      ['policy.conflict', 'policy.displaced', 'policy.gpu']],
    ['a revision', { policy: { ...(SMALLEST.setPolicy.policy as Plain), rev: 3 } }, ['policy.rev']]
  ],
  setDefaultRecipe: [['no recipe', { recipe: null }, ['recipe']], ['a list', { recipe: [CONVERT] }, ['recipe']]],
  preflight: [['an unknown word', { ids: 'all' }, ['ids']], ...ID_LIST_CASES('ids')],
  analyze: ID_LIST_CASES('ids'),
  cancelAnalyze: [['an unknown word', { ids: 'pending' }, ['ids']], ...ID_LIST_CASES('ids')],
  start: [
    ['a number id', { preflightId: 5 }, ['preflightId']],
    ['an acknowledgment that is not an object', { ack: 'yes' }, ['ack']],
    ['negative and fractional counts', { ack: { preflightId: 'p', originalsAffected: -1, overwrites: 1.5 } }, ['ack.originalsAffected', 'ack.overwrites']],
    ['a count past the queue', { ack: { preflightId: 'p', originalsAffected: MAX_REQUEST_ITEMS + 1, overwrites: 0 } }, ['ack.originalsAffected']],
    ['a flag that is not a boolean', { resume: null }, ['resume']]
  ],
  pause: [['an unknown mode', { mode: 'now' }, ['mode']]],
  resume: [['an unknown acknowledgment field', { ack: { preflightId: 'p', originalsAffected: 0, overwrites: 0, all: true } }, ['ack.all']]],
  cancelRun: [['an unknown field', { now: true }, ['now']]],
  setWorkers: [
    ['a number', { workers: 4 }, ['workers']],
    ['an unknown mode', { workers: { mode: 'max' } }, ['workers.mode']],
    ['zero workers', { workers: { mode: 'fixed', count: 0 } }, ['workers.count']],
    ['too many workers', { workers: { mode: 'fixed', count: 65 } }, ['workers.count']],
    ['a fractional count', { workers: { mode: 'fixed', count: 2.5 } }, ['workers.count']],
    ['a count on auto', { workers: { mode: 'auto', count: 2 } }, ['workers.count']],
    ['too many GPU sessions', { gpuSessions: { mode: 'fixed', count: 17 } }, ['gpuSessions.count']]
  ],
  setSettings: [
    ['no settings', { settings: null }, ['settings']],
    ['an unknown priority', { settings: { priority: 'high' } }, ['settings.priority']],
    ['an unknown depth', { settings: { verifyVideo: 'none' } }, ['settings.verifyVideo']],
    ['flags that are not booleans', { settings: { keepAwake: 'yes', measureOnReview: 1, includeSubfolders: null } },
      ['settings.keepAwake', 'settings.measureOnReview', 'settings.includeSubfolders']],
    ['half a notification setting', { settings: { notify: { completion: true } } }, ['settings.notify.firstFailure']],
    ['a notification setting that is not an object', { settings: { notify: true } }, ['settings.notify']],
    ['a setting main keeps elsewhere', { settings: { workers: 4 } }, ['settings.workers']]
  ],
  dismissAlert: [['a number', { alertId: 5 }, ['alertId']]],
  revealAlert: [['an empty id', { alertId: '' }, ['alertId']]],
  cancel: ID_LIST_CASES('ids'),
  skip: ID_LIST_CASES('ids'),
  unqueue: ID_LIST_CASES('ids'),
  retry: [
    ['an unknown word', { ids: 'returned' }, ['ids']],
    ...ID_LIST_CASES('ids'),
    ['a bad recipe', { recipe: { ...CONVERT, kind: 'remux' } }, ['recipe.kind']],
    ['a bad acknowledgment', { ack: { preflightId: '', originalsAffected: 0, overwrites: 0 } }, ['ack.preflightId']],
    ['a flag that is not a boolean', { start: 'now' }, ['start']]
  ],
  keepOutput: [
    ...ID_LIST_CASES('ids'),
    ['an unknown placement', { placement: 'beside' }, ['placement']],
    ['a negative confirmation', { confirm: { displaces: -1 } }, ['confirm.displaces']],
    ['a confirmation that is not an object', { confirm: 2 }, ['confirm']]
  ],
  discardOutput: ID_LIST_CASES('ids'),
  acknowledge: ID_LIST_CASES('ids'),
  clear: [
    ['an unknown scope', { scope: { kind: 'all' } }, ['scope.kind']],
    ['a scope that is not an object', { scope: 'done' }, ['scope']],
    ['an empty id scope', { scope: { kind: 'ids', ids: [] } }, ['scope.ids']],
    ['ids on a done scope', { scope: { kind: 'done', ids: [ID] } }, ['scope.ids']],
    ['a malformed id in the scope', { scope: { kind: 'ids', ids: ['x'] } }, ['scope.ids[0]']]
  ],
  log: [['attempt 0', { attempt: 0 }, ['attempt']], ['a fractional attempt', { attempt: 1.5 }, ['attempt']], ['a malformed id', { jobId: '' }, ['jobId']]],
  reveal: [['an unknown target', { target: 'folder' }, ['target']]],
  exportReport: [
    ['a malformed run', { scope: { runId: 'R-1' } }, ['scope.runId']],
    ['an empty job list', { scope: { ids: [] } }, ['scope.ids']],
    ['both a run and jobs', { scope: { runId: RUN, ids: [ID] } }, ['scope.ids']],
    ['a scope that is not an object', { scope: RUN }, ['scope']],
    ['an unknown format', { format: 'xml' }, ['format']]
  ],
  listRuns: [['a zero limit', { limit: 0 }, ['limit']], ['a limit past a page', { limit: MAX_PAGE + 1 }, ['limit']], ['a malformed before', { before: 'R-1' }, ['before']]],
  getRun: [['a negative offset', { offset: -1 }, ['offset']], ['a limit past a page', { limit: MAX_PAGE + 1 }, ['limit']], ['a malformed run', { runId: ID }, ['runId']]],
  searchRuns: [
    ['an empty query', { query: '' }, ['query']],
    ['a blank query', { query: '   ' }, ['query']],
    ['a query that is not a string', { query: 5 }, ['query']],
    ['an overlong query', { query: 'q'.repeat(MAX_PATH_LENGTH + 1) }, ['query']],
    ['half a position', { before: { runId: RUN } }, ['before.jobId']],
    ['a position that is not an object', { before: RUN }, ['before']],
    ['a limit past a page', { limit: MAX_PAGE + 1 }, ['limit']]
  ],
  rerun: [['an unknown word', { jobIds: 'failed' }, ['jobIds']], ['a flag that is not a boolean', { force: 1 }, ['force']], ...ID_LIST_CASES('jobIds')],
  deleteRuns: [
    ['an unknown word', { runIds: 'some' }, ['runIds']],
    ['an empty list', { runIds: [] }, ['runIds']],
    ['an oversized list', { runIds: Array.from({ length: MAX_REQUEST_ITEMS + 1 }, (_, i) => formatRunId(i)) }, ['runIds']],
    ['a malformed run id', { runIds: [RUN, 'R-1'] }, ['runIds[1]']]
  ],
  revealRecord: [['attempt 0', { attempt: 0 }, ['attempt']], ['an unknown target', { target: 'x' }, ['target']], ['a malformed run', { runId: 'R1' }, ['runId']]],
  savePreset: [
    ['an empty name', { name: '' }, ['name']],
    ['a blank name', { name: '   ' }, ['name']],
    ['a name past 60 characters', { name: 'x'.repeat(61) }, ['name']],
    ['a name that is not a string', { name: 7 }, ['name']],
    ['pin 0', { pin: 0 }, ['pin']],
    ['pin 10', { pin: 10 }, ['pin']],
    ['an empty id', { id: '' }, ['id']],
    ['a bad recipe', { recipe: { ...CONVERT, audio: { kind: 'codec', codec: 'dts', kbpsPerPair: 256 } } }, ['recipe.audio.codec']]
  ],
  renamePreset: [['a name that is not a string', { name: 5 }, ['name']], ['a null id', { id: null }, ['id']]],
  removePreset: [['a number id', { id: 5 }, ['id']]],
  setPin: [['key 0', { key: 0 }, ['key']], ['key 10', { key: 10 }, ['key']], ['a fractional key', { key: 1.5 }, ['key']], ['an empty preset id', { presetId: '' }, ['presetId']]]
}

function paths(result: { ok: boolean; issues?: Array<{ path: string; message: string }> }): string[]
{
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.path)
}

/** A list of the given length holding only the given items; every other index is a hole. */
function sparse(length: number, items: Record<number, unknown>): unknown[]
{
  const list: unknown[] = new Array(length)
  for (const [index, item] of Object.entries(items))
  {
    list[Number(index)] = item
  }
  return list
}

describe('the request validators', () =>
{
  it('cover every command', () =>
  {
    expect(Object.keys(REQUEST_VALIDATORS).sort()).toEqual([...JOB_COMMAND_NAMES].sort())
    expect(Object.keys(SMALLEST).sort()).toEqual([...JOB_COMMAND_NAMES].sort())
    expect(Object.keys(BAD).sort()).toEqual([...JOB_COMMAND_NAMES].sort())
  })

  it.each(JOB_COMMAND_NAMES)('%s accepts its smallest valid request unchanged', (name) =>
  {
    expect(REQUEST_VALIDATORS[name](SMALLEST[name])).toEqual({ ok: true, value: SMALLEST[name] })
  })

  it.each(JOB_COMMAND_NAMES)('%s refuses a request that is not an object, and unknown fields', (name) =>
  {
    for (const raw of [null, undefined, 'request', 5, [SMALLEST[name]]])
    {
      const result = REQUEST_VALIDATORS[name](raw)
      expect(result, String(raw)).toEqual({ ok: false, issues: [{ path: '', message: 'Must be a request object.' }] })
    }
    expect(paths(REQUEST_VALIDATORS[name]({ ...SMALLEST[name], extra: 1 }))).toEqual(['extra'])
  })

  it.each(JOB_COMMAND_NAMES)('%s answers each bad request with one issue per problem', (name) =>
  {
    for (const [label, change, expected] of BAD[name])
    {
      const result = REQUEST_VALIDATORS[name]({ ...SMALLEST[name], ...change })
      expect(paths(result), `${name}: ${label}`).toEqual(expected)
      if (!result.ok)
      {
        for (const issue of result.issues)
        {
          expect(issue.message, `${name}: ${label}`).toMatch(/^[A-Z].*\.$/)
        }
      }
    }
  })

  it('reports every problem of one request', () =>
  {
    const result = REQUEST_VALIDATORS.add({ ...SMALLEST.add, paths: ['a.mkv'], origin: 'clipboard', recursive: 'yes', note: 1 })
    expect(paths(result)).toEqual(['note', 'paths[0]', 'origin', 'recursive'])
  })

  it('accepts full requests with every optional part set', () =>
  {
    const full: Array<[JobCommandName, Plain]> = [
      ['add', { paths: ['/m/a.mkv', 'C:\\m\\b.mkv', '\\\\nas\\share\\c.mkv'], recipe: CONVERT, origin: 'drop', after: ID, recursive: true, allowSecondJobs: true, force: true }],
      ['reorder', { ids: [ID, ID2], before: formatCatalog(3) }],
      ['relink', { fromDir: '/a', toDir: '/b', ids: [ID] }],
      ['setPolicy', { policy: { destination: { mode: 'folder', folder: '/out' }, template: '{name}-{op}', conflict: 'rename', displaced: 'keep', gpu: 'require' } }],
      ['setPolicy', { policy: { destination: { mode: 'replace-originals' }, template: '{name}', conflict: 'overwrite', displaced: 'trash', gpu: 'auto' } }],
      ['preflight', { ids: [ID] }],
      ['cancelAnalyze', { ids: [ID] }],
      ['start', { preflightId: 'p', ack: { preflightId: 'p', originalsAffected: 3, overwrites: MAX_REQUEST_ITEMS }, resume: true }],
      ['pause', { mode: 'stop-running' }],
      ['setWorkers', { workers: { mode: 'fixed', count: 64 }, gpuSessions: { mode: 'fixed', count: 16 } }],
      ['setWorkers', { workers: { mode: 'fixed', count: 1 }, gpuSessions: { mode: 'auto' } }],
      ['setSettings', { settings: { priority: 'normal', keepAwake: true, verifyVideo: 'sampled', notify: { completion: false, firstFailure: true }, measureOnReview: false, includeSubfolders: true } }],
      ['retry', { ids: [ID], recipe: CONVERT, ack: { preflightId: 'p', originalsAffected: 0, overwrites: 0 }, start: true }],
      ['keepOutput', { ids: [ID], placement: 'renamed', confirm: { displaces: 2 } }],
      ['clear', { scope: { kind: 'finished' } }],
      ['clear', { scope: { kind: 'ids', ids: [ID] } }],
      ['log', { jobId: ID, attempt: 3 }],
      ['exportReport', { scope: { ids: [ID] }, format: 'json' }],
      ['listRuns', { before: RUN, limit: MAX_PAGE }],
      ['getRun', { runId: RUN, offset: 1000, limit: MAX_PAGE }],
      ['searchRuns', { query: 'MM-0142', limit: MAX_PAGE, before: { runId: RUN, jobId: ID } }],
      ['rerun', { runId: RUN, jobIds: [ID], force: true }],
      ['rerun', { runId: RUN, jobIds: 'returned', force: false }],
      ['deleteRuns', { runIds: [RUN] }],
      ['savePreset', { id: 'user-1', name: 'x'.repeat(60), recipe: CONVERT, pin: 9 }],
      ['setPin', { key: 9, presetId: 'mp4-h264-aac' }]
    ]
    for (const [name, request] of full)
    {
      expect(REQUEST_VALIDATORS[name](request), name).toEqual({ ok: true, value: request })
    }
  })

  it('normalizes paths, names, and repeated ids', () =>
  {
    const add = REQUEST_VALIDATORS.add({ ...SMALLEST.add, paths: ['  "C:\\Media\\a b.mkv"  ', '\'/home/me/c.mp4\'', ' /m/d.mkv '] })
    expect(add.ok && add.value.paths).toEqual(['C:\\Media\\a b.mkv', '/home/me/c.mp4', '/m/d.mkv'])
    const policy = REQUEST_VALIDATORS.setPolicy({ policy: { ...(SMALLEST.setPolicy.policy as Plain), destination: { mode: 'folder', folder: ' "D:\\Out" ' } } })
    expect(policy.ok && policy.value.policy.destination).toEqual({ mode: 'folder', folder: 'D:\\Out' })
    const save = REQUEST_VALIDATORS.savePreset({ ...SMALLEST.savePreset, name: '  Late podcasts  ' })
    expect(save.ok && save.value.name).toBe('Late podcasts')
    const remove = REQUEST_VALIDATORS.remove({ ids: [ID, ID2, ID] })
    expect(remove.ok && remove.value.ids).toEqual([ID, ID2])
    const deleted = REQUEST_VALIDATORS.deleteRuns({ runIds: [RUN, RUN] })
    expect(deleted.ok && deleted.value.runIds).toEqual([RUN])
    const search = REQUEST_VALIDATORS.searchRuns({ ...SMALLEST.searchRuns, query: '  podcast ' })
    expect(search.ok && search.value.query).toBe('podcast')
  })

  it('checks absolute paths for the platform it was built for', () =>
  {
    const win = createRequestValidators('win32')
    const linux = createRequestValidators('linux')
    const mac = createRequestValidators('darwin')
    expect(paths(win.locate({ jobId: ID, path: 'C:\\m\\a.mkv' }))).toEqual([])
    expect(paths(win.locate({ jobId: ID, path: '\\\\nas\\media\\a.mkv' }))).toEqual([])
    expect(paths(win.locate({ jobId: ID, path: '/m/a.mkv' }))).toEqual(['path'])
    expect(paths(linux.locate({ jobId: ID, path: '/m/a.mkv' }))).toEqual([])
    expect(paths(linux.locate({ jobId: ID, path: 'C:\\m\\a.mkv' }))).toEqual(['path'])
    expect(paths(mac.forgetFolder({ path: '/Users/me/Music' }))).toEqual([])
    expect(paths(mac.forgetFolder({ path: 'D:/Music' }))).toEqual(['path'])
  })

  it('refuses a destination folder that names a Windows device, on Windows paths only', () =>
  {
    const win = createRequestValidators('win32')
    const linux = createRequestValidators('linux')
    const policy = (folder: string): Plain => ({ policy: { ...(SMALLEST.setPolicy.policy as Plain), destination: { mode: 'folder', folder } } })
    const reserved = ['D:\\Exports\\CON', 'D:\\NUL', 'D:\\Exports\\aux\\x', 'd:/exports/Com1', 'D:\\Exports\\nul.', 'D:\\Exports\\PRN .\\x',
      '\\\\nas\\share\\LPT9\\out', '\\\\?\\D:\\Exports\\con']
    for (const folder of reserved)
    {
      expect(paths(win.setPolicy(policy(folder))), folder).toEqual(['policy.destination.folder'])
      expect(paths(REQUEST_VALIDATORS.setPolicy(policy(folder))), folder).toEqual(['policy.destination.folder'])
    }
    expect(win.setPolicy(policy('D:\\NUL'))).toEqual({
      ok: false,
      issues: [{ path: 'policy.destination.folder', message: 'Must not contain a folder named NUL; Windows reserves that name for a device.' }]
    })
    for (const folder of ['D:\\Exports\\CONSOLE', 'D:\\Exports\\COM10', 'D:\\Exports\\LPT0', 'D:\\Exports\\CON.txt', 'D:\\Movies\\Con.Air.1997', '\\\\con\\nul\\Exports', 'C:\\'])
    {
      expect(paths(win.setPolicy(policy(folder))), folder).toEqual([])
    }
    expect(paths(linux.setPolicy(policy('/home/me/CON')))).toEqual([])
    expect(paths(REQUEST_VALIDATORS.setPolicy(policy('/srv/aux/NUL')))).toEqual([])
    expect(win.setPolicy(policy('/Exports/CON'))).toEqual({ ok: false, issues: [{ path: 'policy.destination.folder', message: 'Must be an absolute path.' }] })
  })

  it('reads a hole in a structured-cloned list as a missing item, with one issue per hole', () =>
  {
    const remove = structuredClone({ ids: sparse(3, { 1: ID }) })
    expect(Object.hasOwn(remove.ids, 0)).toBe(false)
    expect(REQUEST_VALIDATORS.remove(remove)).toEqual({
      ok: false,
      issues: [
        { path: 'ids[0]', message: 'Must be a catalog number such as MM-0142.' },
        { path: 'ids[2]', message: 'Must be a catalog number such as MM-0142.' }
      ]
    })
    const add = structuredClone({ ...SMALLEST.add, paths: sparse(3, { 2: '/m/a.mkv' }) })
    expect(REQUEST_VALIDATORS.add(add)).toEqual({
      ok: false,
      issues: [{ path: 'paths[0]', message: 'Must be an absolute path.' }, { path: 'paths[1]', message: 'Must be an absolute path.' }]
    })
    const assign = structuredClone({ assignments: sparse(2, { 1: { jobId: ID, recipe: CONVERT } }) })
    expect(REQUEST_VALIDATORS.assignRecipe(assign)).toEqual({ ok: false, issues: [{ path: 'assignments[0]', message: 'Must be an assignment.' }] })
    expect(paths(REQUEST_VALIDATORS.rerun(structuredClone({ ...SMALLEST.rerun, jobIds: sparse(2, { 0: ID }) })))).toEqual(['jobIds[1]'])
    expect(paths(REQUEST_VALIDATORS.deleteRuns(structuredClone({ runIds: sparse(2, { 1: RUN }) })))).toEqual(['runIds[0]'])
    expect(paths(REQUEST_VALIDATORS.clear(structuredClone({ scope: { kind: 'ids', ids: sparse(1, {}) } })))).toEqual(['scope.ids[0]'])
  })
})

describe('paths', () =>
{
  it('trims spaces and one pair of matching quotes', () =>
  {
    expect(normalizePath('  "C:\\a\\b.mkv"  ')).toBe('C:\\a\\b.mkv')
    expect(normalizePath('\'/a/b.mkv\'')).toBe('/a/b.mkv')
    expect(normalizePath('" /a/b.mkv "')).toBe('/a/b.mkv')
    expect(normalizePath('"/a/b.mkv\'')).toBe('"/a/b.mkv\'')
    expect(normalizePath('/a/it\'s.mkv')).toBe('/a/it\'s.mkv')
    expect(normalizePath('"')).toBe('"')
    expect(normalizePath('""')).toBe('')
  })

  it.each([
    ['C:\\Media', true, false, true],
    ['c:/Media', true, false, true],
    ['\\\\nas\\share\\a.mkv', true, false, true],
    ['//nas/share', true, true, true],
    ['\\\\?\\C:\\very\\long', true, false, true],
    ['/home/me', false, true, true],
    ['\\Media', false, false, false],
    ['C:Media', false, false, false],
    ['Media\\a.mkv', false, false, false],
    ['./a.mkv', false, false, false],
    ['\\\\nas', false, false, false],
    ['', false, false, false]
  ])('%s is absolute on win32 %s, on linux and darwin %s, on any %s', (path, win32, posix, any) =>
  {
    expect(isAbsolutePath(path, 'win32')).toBe(win32)
    expect(isAbsolutePath(path, 'linux')).toBe(posix)
    expect(isAbsolutePath(path, 'darwin')).toBe(posix)
    expect(isAbsolutePath(path, null)).toBe(any)
  })

  it('finds the first folder of a Windows path that names a device, past the drive or the share', () =>
  {
    expect(reservedFolderName('D:\\a\\nul\\CON')).toBe('nul')
    expect(reservedFolderName('D:\\a\\Aux.. ')).toBe('Aux')
    expect(reservedFolderName('\\\\lpt1\\com1\\a')).toBeNull()
    expect(reservedFolderName('\\\\?\\C:\\a\\COM9')).toBe('COM9')
    expect(reservedFolderName('C:\\')).toBeNull()
    expect(reservedFolderName('C:\\CON.d\\COM')).toBeNull()
  })
})

function clone<T>(value: T): T
{
  return structuredClone(value)
}

function withPath(recipe: Plain, path: string, value: unknown): Plain
{
  const copy = clone(recipe)
  const keys = path.split('.')
  let node = copy as Plain
  for (const key of keys.slice(0, -1))
  {
    node = node[key] as Plain
  }
  node[keys[keys.length - 1]] = value
  return copy
}

function recipeIssues(recipe: unknown): string[]
{
  return paths(validateRecipe(recipe))
}

const BASE = { presetId: null, userPreset: null }

const NORMALIZE = applyLoudnessPreset(DEFAULT_LOUDNESS_PRESET, { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }) as unknown as Plain
const BOOST = applyGainPreset('gentle-lift', { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 }) as unknown as Plain
const CONVERT_VIDEO: Plain =
{
  kind: 'convert', ...BASE, container: 'mp4',
  video: { encoder: 'libx264', bitrateKbps: 5000, fit: { maxWidth: 1920, maxHeight: 1080, mode: 'fit' }, fps: 30, pixelFormat: 'yuv420p' },
  audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 192 }, channels: 'stereo', subtitles: 'drop'
}
const COMPRESS: Plain =
{
  kind: 'compress', ...BASE, target: { mode: 'crf', crf: 23 }, encoder: 'libx264', speed: 'medium', pixelFormat: 'yuv420p', tune: 'film',
  fit: { maxWidth: null, maxHeight: 1080, mode: 'pad' }, audio: { kind: 'same-as-source' }, container: 'source'
}
const SIZE: Plain = { ...COMPRESS, target: { mode: 'size', targetBytes: 25_000_000, twoPass: true } }
const EXTRACT_AUDIO: Plain =
{
  kind: 'extract', ...BASE, mode: 'audio', stream: { by: 'ordinal', ordinal: 2 }, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 },
  container: 'mp3', sampleRate: 48000, channels: 'mono', range: { startSec: 10, durationSec: 30 }
}
const EXTRACT_VIDEO: Plain = { kind: 'extract', ...BASE, mode: 'video', container: 'mp4', reencode: { encoder: 'libx264', crf: 20 }, range: { startSec: 0, durationSec: null } }
const GIF: Plain = { kind: 'extract', ...BASE, mode: 'gif', fps: 15, width: 480, dither: 'bayer', plays: 3, range: null }
const FRAMES: Plain = { kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'interval', seconds: 1 }, format: 'jpg', jpgQuality: 2, range: null }
const SUBTITLES: Plain = { kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'language', language: 'eng' }, format: 'srt' }

describe('recipes', () =>
{
  it.each([
    ['normalize', NORMALIZE], ['gain', BOOST], ['convert', CONVERT], ['convert with video', CONVERT_VIDEO], ['compress at a CRF', COMPRESS],
    ['compress to a size', SIZE], ['extract audio', EXTRACT_AUDIO], ['extract video', EXTRACT_VIDEO], ['GIF', GIF], ['frames', FRAMES],
    ['subtitles', SUBTITLES]
  ])('a valid %s recipe passes unchanged', (_label, recipe) =>
  {
    expect(validateRecipe(recipe)).toEqual({ ok: true, value: recipe })
  })

  it('refuses what is not a recipe', () =>
  {
    expect(validateRecipe(null)).toEqual({ ok: false, issues: [{ path: '', message: 'Must be a recipe.' }] })
    expect(recipeIssues([CONVERT])).toEqual([''])
    expect(recipeIssues({ ...CONVERT, kind: 'trim' })).toEqual(['kind'])
    expect(recipeIssues({ kind: 'extract', ...BASE, mode: 'thumbnail' })).toEqual(['mode'])
  })

  /** [recipe, field path, minimum, maximum or null, step]: passes at both limits and fails one step outside each. */
  const LIMITS: Array<[string, Plain, string, number, number | null, number]> = [
    ['normalize', NORMALIZE, 'target.integratedLufs', AUDIO_LIMITS.integratedLufs.min, AUDIO_LIMITS.integratedLufs.max, AUDIO_LIMITS.integratedLufs.step],
    ['normalize', NORMALIZE, 'target.maxTruePeakDbtp', AUDIO_LIMITS.maxTruePeakDbtp.min, AUDIO_LIMITS.maxTruePeakDbtp.max, AUDIO_LIMITS.maxTruePeakDbtp.step],
    ['normalize', NORMALIZE, 'maxLimitingDb', AUDIO_LIMITS.normalizeMaxLimitingDb.min, AUDIO_LIMITS.normalizeMaxLimitingDb.max, AUDIO_LIMITS.normalizeMaxLimitingDb.step],
    ['normalize', NORMALIZE, 'output.kbpsPerPair', AUDIO_LIMITS.kbpsPerPair.min, AUDIO_LIMITS.kbpsPerPair.max, AUDIO_LIMITS.kbpsPerPair.step],
    ['gain', BOOST, 'gainDb', AUDIO_LIMITS.gainDb.min, AUDIO_LIMITS.gainDb.max, AUDIO_LIMITS.gainDb.step],
    ['gain', BOOST, 'maxTruePeakDbtp', AUDIO_LIMITS.boostMaxTruePeakDbtp.min, AUDIO_LIMITS.boostMaxTruePeakDbtp.max, AUDIO_LIMITS.boostMaxTruePeakDbtp.step],
    ['gain', BOOST, 'maxLimitingDb', AUDIO_LIMITS.boostMaxLimitingDb.min, AUDIO_LIMITS.boostMaxLimitingDb.max, AUDIO_LIMITS.boostMaxLimitingDb.step],
    ['convert', CONVERT_VIDEO, 'video.bitrateKbps', 100, 200_000, 1],
    ['convert', CONVERT_VIDEO, 'video.fps', 1, 240, 1],
    ['convert', CONVERT_VIDEO, 'video.fit.maxWidth', 16, 7680, 1],
    ['convert', CONVERT_VIDEO, 'video.fit.maxHeight', 16, 7680, 1],
    ['convert', CONVERT_VIDEO, 'audio.kbpsPerPair', 32, 640, 1],
    ['compress', SIZE, 'target.targetBytes', 1_000_000, null, 1],
    ['compress', COMPRESS, 'fit.maxHeight', 16, 7680, 1],
    ['extract audio', EXTRACT_AUDIO, 'stream.ordinal', 1, 64, 1],
    ['extract audio', EXTRACT_AUDIO, 'range.startSec', 0, null, 0.001],
    ['extract audio', EXTRACT_AUDIO, 'range.durationSec', 0.01, null, 0.001],
    ['extract video', { ...EXTRACT_VIDEO, reencode: { encoder: 'libvpx-vp9', crf: 30 } }, 'reencode.crf', 0, 63, 1],
    ['GIF', GIF, 'fps', 1, 60, 1],
    ['GIF', GIF, 'width', 1, 3840, 1],
    ['GIF', GIF, 'plays', 1, 65_536, 1],
    ['frames', FRAMES, 'sampling.seconds', 0.05, null, 0.01],
    ['frames', { ...FRAMES, sampling: { by: 'fps', fps: 1 } }, 'sampling.fps', 0.01, null, 0.001],
    ['frames', { ...FRAMES, sampling: { by: 'count', count: 10 } }, 'sampling.count', 1, 1000, 1],
    ['frames', FRAMES, 'jpgQuality', 2, 31, 1]
  ]

  it.each(LIMITS)('%s: %s passes at its limits and fails one step outside', (_label, recipe, field, min, max, step) =>
  {
    expect(recipeIssues(withPath(recipe, field, min)), `${field} = ${min}`).toEqual([])
    expect(recipeIssues(withPath(recipe, field, min - step)), `${field} = ${min - step}`).toEqual([field])
    if (max === null)
    {
      expect(recipeIssues(withPath(recipe, field, 1e12)), `${field} large`).toEqual([])
    }
    else
    {
      expect(recipeIssues(withPath(recipe, field, max)), `${field} = ${max}`).toEqual([])
      expect(recipeIssues(withPath(recipe, field, max + step)), `${field} = ${max + step}`).toEqual([field])
    }
  })

  it('agrees with the shared limits it reads', () =>
  {
    expect(JOB_LIMITS.videoBitrateKbps).toEqual({ min: 100, max: 200_000 })
    expect(JOB_LIMITS.frameIntervalSec.min).toBe(0.05)
    expect(JOB_LIMITS.frameCount).toEqual({ min: 1, max: 1000 })
    expect(JOB_LIMITS.gifFps).toEqual({ min: 1, max: 60 })
  })

  it.each(VIDEO_ENCODERS)('compresses with %s at the ends of its CRF range, or refuses a CRF it has none of', (encoder) =>
  {
    const range = CRF_RANGES[encoder]
    const at = (crf: number): string[] => recipeIssues({ ...COMPRESS, encoder, tune: null, target: { mode: 'crf', crf } })
    if (range === null)
    {
      expect(at(20)).toEqual(['target.crf'])
      expect(recipeIssues({ ...COMPRESS, encoder, tune: null, target: { mode: 'quality', tier: 'lossless' } })).toEqual([])
      return
    }
    expect(at(range.min)).toEqual([])
    expect(at(range.max as number)).toEqual([])
    expect(at(range.min - 1)).toEqual(['target.crf'])
    expect(at((range.max as number) + 1)).toEqual(['target.crf'])
    expect(at(20.5)).toEqual(['target.crf'])
  })

  it('re-encodes extracted video with x264 at CRF 0 to 51', () =>
  {
    expect(recipeIssues({ ...EXTRACT_VIDEO, reencode: { encoder: 'libx264', crf: 51 } })).toEqual([])
    expect(recipeIssues({ ...EXTRACT_VIDEO, reencode: { encoder: 'libx264', crf: 52 } })).toEqual(['reencode.crf'])
    expect(recipeIssues({ ...EXTRACT_VIDEO, reencode: { encoder: 'libx265', crf: 20 } })).toEqual(['reencode.encoder'])
    expect(recipeIssues({ ...EXTRACT_VIDEO, reencode: 'x264' })).toEqual(['reencode'])
    expect(recipeIssues({ ...EXTRACT_VIDEO, reencode: null, range: null })).toEqual([])
  })

  it('refuses unknown enums and wrong types with one issue each', () =>
  {
    expect(recipeIssues({ ...CONVERT_VIDEO, video: { ...(CONVERT_VIDEO.video as Plain), encoder: 'h264_nvenc', pixelFormat: 'rgb24' } }))
      .toEqual(['video.encoder', 'video.pixelFormat'])
    expect(recipeIssues({ ...CONVERT_VIDEO, video: { ...(CONVERT_VIDEO.video as Plain), fit: { maxWidth: 1920, maxHeight: null, mode: 'stretch' } } }))
      .toEqual(['video.fit.mode'])
    expect(recipeIssues({ ...CONVERT_VIDEO, video: { ...(CONVERT_VIDEO.video as Plain), fit: 'fit' } })).toEqual(['video.fit'])
    expect(recipeIssues({ ...CONVERT_VIDEO, video: 'copy' })).toEqual(['video'])
    expect(recipeIssues({ ...CONVERT, container: '.mp4' })).toEqual(['container'])
    expect(recipeIssues({ ...CONVERT, container: 'source' })).toEqual(['container'])
    expect(recipeIssues({ ...CONVERT, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: null } })).toEqual([])
    expect(recipeIssues({ ...CONVERT, audio: { kind: 'opus' } })).toEqual(['audio.kind'])
    expect(recipeIssues({ ...CONVERT, audio: 'copy' })).toEqual(['audio'])
    expect(recipeIssues({ ...CONVERT, audio: { kind: 'copy', codec: 'aac' } })).toEqual(['audio.codec'])
    expect(recipeIssues({ ...CONVERT, subtitles: 'burn', extra: 1 })).toEqual(['extra', 'subtitles'])
    expect(recipeIssues({ ...COMPRESS, speed: 'placebo', tune: 'psnr', container: 'MKV' })).toEqual(['speed', 'tune', 'container'])
    expect(recipeIssues({ ...COMPRESS, target: { mode: 'bitrate', kbps: 5000 } })).toEqual(['target.mode'])
    expect(recipeIssues({ ...COMPRESS, target: { mode: 'quality', tier: 'ultra' } })).toEqual(['target.tier'])
    expect(recipeIssues({ ...COMPRESS, target: { mode: 'size', targetBytes: 25_000_000, twoPass: 'yes' } })).toEqual(['target.twoPass'])
    expect(recipeIssues({ ...COMPRESS, target: 23 })).toEqual(['target'])
    expect(recipeIssues({ ...COMPRESS, encoder: 'x264' })).toEqual(['encoder'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, stream: { by: 'index', index: 1 } })).toEqual(['stream.by'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, stream: { by: 'language', language: 'english language' } })).toEqual(['stream.language'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, stream: { by: 'language', language: 'en-US' } })).toEqual([])
    expect(recipeIssues({ ...EXTRACT_AUDIO, stream: { by: 'default' } })).toEqual([])
    expect(recipeIssues({ ...EXTRACT_AUDIO, sampleRate: 22050 })).toEqual(['sampleRate'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, range: { startSec: '0:10', durationSec: null } })).toEqual(['range.startSec'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, range: [0, 10] })).toEqual(['range'])
    expect(recipeIssues({ ...GIF, dither: 'random', plays: 'forever' })).toEqual(['dither', 'plays'])
    expect(recipeIssues({ ...GIF, plays: 'infinite', width: null })).toEqual([])
    expect(recipeIssues({ ...FRAMES, sampling: { by: 'scene' } })).toEqual(['sampling.by'])
    expect(recipeIssues({ ...FRAMES, sampling: { by: 'thumbnail' }, format: 'bmp' })).toEqual(['format'])
    expect(recipeIssues({ ...FRAMES, sampling: null })).toEqual(['sampling'])
    expect(recipeIssues({ ...SUBTITLES, format: 'sub' })).toEqual(['format'])
    expect(recipeIssues({ ...SUBTITLES, range: null })).toEqual(['range'])
  })

  it('refuses settings that contradict each other', () =>
  {
    const copy = { encoder: 'copy', bitrateKbps: 5000, fit: { maxWidth: 1280, maxHeight: null, mode: 'fit' }, fps: 30, pixelFormat: 'yuv420p' }
    expect(recipeIssues({ ...CONVERT_VIDEO, video: copy }))
      .toEqual(['video.bitrateKbps', 'video.fit', 'video.fps', 'video.pixelFormat'])
    expect(recipeIssues({ ...CONVERT_VIDEO, video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } })).toEqual([])
    expect(recipeIssues({ ...CONVERT_VIDEO, video: { encoder: 'copy', bitrateKbps: 5, fit: null, fps: null, pixelFormat: 'rgb' } }))
      .toEqual(['video.pixelFormat', 'video.bitrateKbps'])
    expect(recipeIssues({ ...CONVERT_VIDEO, video: { encoder: 'libx265', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'yuv420p10le' } })).toEqual([])
    expect(recipeIssues({ ...COMPRESS, fit: null })).toEqual([])
    expect(recipeIssues({ ...CONVERT, channels: 'stereo' })).toEqual(['channels'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, audio: { kind: 'copy' } })).toEqual(['sampleRate', 'channels'])
    expect(recipeIssues({ ...EXTRACT_AUDIO, audio: { kind: 'copy' }, sampleRate: null, channels: 'keep' })).toEqual([])
    expect(recipeIssues({ ...FRAMES, format: 'png', jpgQuality: 2 })).toEqual(['jpgQuality'])
    expect(recipeIssues({ ...FRAMES, format: 'png', jpgQuality: null })).toEqual([])
    expect(recipeIssues({ ...COMPRESS, fit: { maxWidth: null, maxHeight: null, mode: 'fit' } })).toEqual(['fit'])
  })

  it('accepts a fractional bitrate per channel pair, as the audio validator does, so a 5.1 total can be exact', () =>
  {
    const surround = { ...CONVERT, container: 'ac3', audio: { kind: 'codec', codec: 'ac3', kbpsPerPair: 448 / 3 } }
    expect(recipeIssues(surround)).toEqual([])
    expect(recipeIssues({ ...NORMALIZE, output: { kind: 'codec', codec: 'ac3', kbpsPerPair: 448 / 3 } })).toEqual([])
    expect(recipeIssues({ ...surround, audio: { kind: 'codec', codec: 'ac3', kbpsPerPair: Number.NaN } })).toEqual(['audio.kbpsPerPair'])
  })

  it('checks preset references on every kind', () =>
  {
    expect(recipeIssues({ ...CONVERT, presetId: 'mp4-h264-aac', userPreset: { id: 'user-1', name: 'Late podcasts' } })).toEqual([])
    expect(recipeIssues({ ...CONVERT, presetId: '' })).toEqual(['presetId'])
    expect(recipeIssues({ ...COMPRESS, userPreset: { id: '', name: 'x' } })).toEqual(['userPreset.id'])
    expect(recipeIssues({ ...GIF, userPreset: { id: 'u', name: 'x'.repeat(61) } })).toEqual(['userPreset.name'])
    expect(recipeIssues({ ...SUBTITLES, userPreset: 'u' })).toEqual(['userPreset'])
    expect(recipeIssues({ ...SUBTITLES, userPreset: { id: 'u', name: 'n', extra: 1 } })).toEqual(['userPreset.extra'])
  })

  it('hands audio recipes to the audio validator and keeps its paths', () =>
  {
    expect(recipeIssues({ ...NORMALIZE, presetId: 'loudest' })).toEqual(['presetId'])
    expect(recipeIssues({ ...BOOST, highpassHz: 50 })).toEqual(['highpassHz'])
    expect(recipeIssues({ ...NORMALIZE, output: { kind: 'copy' } })).toEqual(['output.kind'])
    const nested = REQUEST_VALIDATORS.assignRecipe({ assignments: [{ jobId: ID, recipe: withPath(NORMALIZE, 'target.integratedLufs', -61) }] })
    expect(paths(nested)).toEqual(['assignments[0].recipe.target.integratedLufs'])
    expect(paths(REQUEST_VALIDATORS.setDefaultRecipe({ recipe: { ...BOOST, gainDb: 13 } }))).toEqual(['recipe.gainDb'])
  })
})

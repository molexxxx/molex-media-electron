/**
 * Job and run identifiers. A job's id is its catalog number ("MM-0142"), its handle in rows, logs,
 * notifications, file names, reports, and history; a run's id ("R-0031") stays a machine id, and users read it as
 * "Batch 31".
 */

/** A job's catalog number. */
export type JobId = string & { readonly __kind: 'JobId' }

/** A run's machine id. */
export type RunId = string & { readonly __kind: 'RunId' }

/** The prefix of every catalog number. */
export const CATALOG_PREFIX = 'MM'

/** The prefix of every run id. */
export const RUN_PREFIX = 'R'

const CATALOG_PATTERN = /^MM-\d{4,}$/
const RUN_PATTERN = /^R-\d{4,}$/

function formatSequence(prefix: string, seq: number): string
{
  if (!Number.isSafeInteger(seq) || seq < 0)
  {
    throw new RangeError(`A sequence number must be a whole number of 0 or more, not ${seq}`)
  }
  return `${prefix}-${String(seq).padStart(4, '0')}`
}

function parseSequence(pattern: RegExp, id: unknown): number | null
{
  if (typeof id !== 'string' || !pattern.test(id))
  {
    return null
  }
  const seq = Number(id.slice(id.indexOf('-') + 1))
  return Number.isSafeInteger(seq) ? seq : null
}

/** The catalog number of a sequence: four digits at least, growing past them (142 is MM-0142, 12345 is MM-12345). */
export function formatCatalog(seq: number): JobId
{
  return formatSequence(CATALOG_PREFIX, seq) as JobId
}

/** The sequence of a catalog number; null for anything but MM- followed by four or more digits. */
export function parseCatalog(id: string): number | null
{
  return parseSequence(CATALOG_PATTERN, id)
}

/** Whether a value is a well-formed catalog number. */
export function isJobId(id: unknown): id is JobId
{
  return parseSequence(CATALOG_PATTERN, id) !== null
}

/** The run id of a sequence (31 is R-0031). */
export function formatRunId(seq: number): RunId
{
  return formatSequence(RUN_PREFIX, seq) as RunId
}

/** The sequence of a run id; null for anything but R- followed by four or more digits. */
export function parseRunId(id: string): number | null
{
  return parseSequence(RUN_PATTERN, id)
}

/** Whether a value is a well-formed run id. */
export function isRunId(id: unknown): id is RunId
{
  return parseSequence(RUN_PATTERN, id) !== null
}

/** The one name users read for a run: R-0031 is "Batch 31". A malformed id is returned unchanged. */
export function formatRunLabel(runId: RunId): string
{
  const seq = parseRunId(runId)
  return seq === null ? runId : `Batch ${seq}`
}

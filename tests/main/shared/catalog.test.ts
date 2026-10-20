/**
 * Catalog numbers and run ids: four digits at least and growing past them, strict parsing, and the one name
 * users read for a run ("Batch 31").
 */
import { describe, it, expect } from 'vitest'
import {
  CATALOG_PREFIX,
  RUN_PREFIX,
  formatCatalog,
  formatRunId,
  formatRunLabel,
  isJobId,
  isRunId,
  parseCatalog,
  parseRunId,
  type RunId
} from '../../../src/shared/jobs/ids'

describe('catalog numbers', () =>
{
  it('pads to four digits and grows past them', () =>
  {
    expect(CATALOG_PREFIX).toBe('MM')
    expect(formatCatalog(0)).toBe('MM-0000')
    expect(formatCatalog(7)).toBe('MM-0007')
    expect(formatCatalog(142)).toBe('MM-0142')
    expect(formatCatalog(9999)).toBe('MM-9999')
    expect(formatCatalog(10000)).toBe('MM-10000')
    expect(formatCatalog(12345)).toBe('MM-12345')
  })

  it('refuses a sequence that is not a whole number of 0 or more', () =>
  {
    for (const seq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    {
      expect(() => formatCatalog(seq), String(seq)).toThrow(RangeError)
    }
  })

  it('parses what it formats', () =>
  {
    for (const seq of [0, 1, 142, 9999, 10000, 123456789])
    {
      expect(parseCatalog(formatCatalog(seq))).toBe(seq)
    }
  })

  it('accepts only MM- followed by four or more digits', () =>
  {
    for (const id of ['MM-142', 'mm-0142', 'Mm-0142', ' MM-0142', 'MM-0142 ', 'MM-01a2', 'MM-', 'MM-+142', 'MM--142', 'MM_0142',
      'XX-0142', 'MM-0142-2', 'MM-0\uff1142', 'R-0142', '0142', ''])
    {
      expect(parseCatalog(id), JSON.stringify(id)).toBeNull()
    }
    expect(parseCatalog('MM-00042')).toBe(42)
  })

  it('rejects a number past the safe integers', () =>
  {
    expect(parseCatalog('MM-99999999999999999999')).toBeNull()
  })

  it('tells well-formed ids from anything else', () =>
  {
    expect(isJobId('MM-0142')).toBe(true)
    expect(isJobId('MM-142')).toBe(false)
    expect(isJobId(142)).toBe(false)
    expect(isJobId(null)).toBe(false)
  })
})

describe('run ids', () =>
{
  it('formats and parses R- with four or more digits', () =>
  {
    expect(RUN_PREFIX).toBe('R')
    expect(formatRunId(31)).toBe('R-0031')
    expect(formatRunId(12345)).toBe('R-12345')
    expect(parseRunId('R-0031')).toBe(31)
    expect(parseRunId('R-31')).toBeNull()
    expect(parseRunId('MM-0031')).toBeNull()
    expect(() => formatRunId(-3)).toThrow(RangeError)
    expect(isRunId('R-0031')).toBe(true)
    expect(isRunId('R-031')).toBe(false)
  })

  it('names a run for users as Batch and its number', () =>
  {
    expect(formatRunLabel('R-0031' as RunId)).toBe('Batch 31')
    expect(formatRunLabel(formatRunId(1))).toBe('Batch 1')
    expect(formatRunLabel(formatRunId(10432))).toBe('Batch 10432')
  })

  it('returns a malformed run id unchanged', () =>
  {
    expect(formatRunLabel('run-7' as RunId)).toBe('run-7')
  })
})

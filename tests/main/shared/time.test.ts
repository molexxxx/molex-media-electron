/**
 * Time codes for the time-range fields. The plain-seconds, mm:ss, hh:mm:ss.mmm, blank, and garbage cases are the
 * ones the extract processor's time parser was pinned with; blanks and garbage now return null instead of 0, so a
 * field can tell "empty" and "invalid" from the start of the file.
 */
import { describe, it, expect } from 'vitest'
import { formatTimecode, parseTimecode } from '../../../src/shared/jobs/time'

describe('parseTimecode, cases carried over from the extract time parser', () =>
{
  it('parses plain seconds', () =>
  {
    expect(parseTimecode('12')).toBe(12)
    expect(parseTimecode('1.5')).toBe(1.5)
  })

  it('parses mm:ss and hh:mm:ss', () =>
  {
    expect(parseTimecode('01:30')).toBe(90)
    expect(parseTimecode('00:01:30')).toBe(90)
    expect(parseTimecode('01:00:00')).toBe(3600)
    expect(parseTimecode('00:00:02.500')).toBeCloseTo(2.5, 6)
  })

  it('returns null for absent or unparseable values', () =>
  {
    for (const value of [undefined, null, '', '   ', 'abc', '1:xx'])
    {
      expect(parseTimecode(value), String(value)).toBeNull()
    }
  })
})

describe('parseTimecode', () =>
{
  it('accepts the field examples and surrounding spaces', () =>
  {
    expect(parseTimecode('90')).toBe(90)
    expect(parseTimecode('1:30')).toBe(90)
    expect(parseTimecode('00:01:30.5')).toBe(90.5)
    expect(parseTimecode('  2:05  ')).toBe(125)
    expect(parseTimecode('0')).toBe(0)
  })

  it('lets the leading part grow past 59', () =>
  {
    expect(parseTimecode('90:00')).toBe(5400)
    expect(parseTimecode('125:00:00')).toBe(450000)
  })

  it('rejects malformed codes', () =>
  {
    for (const value of ['1:60', '1:75', '1:00:60', '1:60:00', '-5', '+5', '1.', '.5', '1:2:3:4', '1::30', '1:30.', '1,5', '5s', 'Infinity', 'NaN', '1e3'])
    {
      expect(parseTimecode(value), value).toBeNull()
    }
  })
})

describe('formatTimecode', () =>
{
  it('writes the shortest code to the millisecond', () =>
  {
    expect(formatTimecode(0)).toBe('0')
    expect(formatTimecode(5.5)).toBe('5.5')
    expect(formatTimecode(59.25)).toBe('59.25')
    expect(formatTimecode(90)).toBe('1:30')
    expect(formatTimecode(65.05)).toBe('1:05.05')
    expect(formatTimecode(3600)).toBe('1:00:00')
    expect(formatTimecode(3661.25)).toBe('1:01:01.25')
    expect(formatTimecode(59.9996)).toBe('1:00')
    expect(formatTimecode(0.001)).toBe('0.001')
  })

  it('writes nothing for a negative or non-finite value', () =>
  {
    expect(formatTimecode(-1)).toBe('')
    expect(formatTimecode(Number.NaN)).toBe('')
    expect(formatTimecode(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('reads back what it writes', () =>
  {
    for (const sec of [0, 0.5, 12, 59.999, 60, 90.125, 3599.5, 3600, 86399.999, 360000])
    {
      expect(parseTimecode(formatTimecode(sec)), String(sec)).toBeCloseTo(sec, 6)
    }
  })
})

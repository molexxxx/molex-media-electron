/**
 * Time codes for the time-range fields: plain seconds ("90", "1.5"), minutes and seconds ("1:30"), and hours,
 * minutes, and seconds ("00:01:30.5"). The inspector and the validators both read them here.
 */

const SECONDS = /^\d+(?:\.\d+)?$/
const MINUTES_SECONDS = /^(\d+):([0-5]?\d(?:\.\d+)?)$/
const HOURS_MINUTES_SECONDS = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/

/**
 * Seconds from a time code, or null for a blank or malformed one. Minutes and seconds after a colon stay under 60;
 * the leading part may be any size ("90:00" is 90 minutes).
 */
export function parseTimecode(text: string | null | undefined): number | null
{
  if (typeof text !== 'string')
  {
    return null
  }
  const value = text.trim()
  if (SECONDS.test(value))
  {
    return Number(value)
  }
  const hms = HOURS_MINUTES_SECONDS.exec(value)
  if (hms)
  {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])
  }
  const ms = MINUTES_SECONDS.exec(value)
  if (ms)
  {
    return Number(ms[1]) * 60 + Number(ms[2])
  }
  return null
}

function seconds(totalMs: number, pad: boolean): string
{
  const whole = Math.floor(totalMs / 1000)
  const fraction = totalMs % 1000
  const head = pad ? String(whole).padStart(2, '0') : String(whole)
  return fraction === 0 ? head : `${head}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`
}

/** The shortest time code for a number of seconds, to the millisecond ("5.5", "1:30", "1:01:01.25"); '' when invalid. */
export function formatTimecode(totalSec: number): string
{
  if (!Number.isFinite(totalSec) || totalSec < 0)
  {
    return ''
  }
  const totalMs = Math.round(totalSec * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const restMs = totalMs % 60_000
  if (hours > 0)
  {
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds(restMs, true)}`
  }
  if (minutes > 0)
  {
    return `${minutes}:${seconds(restMs, true)}`
  }
  return seconds(restMs, false)
}

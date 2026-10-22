/**
 * @module editor/shared/format
 * Plain-words formatting for the editor: when a file was opened, sizes, bit rates, frame rates, and durations.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function timeOfDay(date: Date): string
{
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function startOfDay(ms: number): number
{
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** When a file was opened: "Today, 13:40", "Yesterday, 09:12", "Oct 14, 22:10", or "Oct 14, 2025" in another year. */
export function formatOpened(ms: number, now: number = Date.now()): string
{
  if (!Number.isFinite(ms))
  {
    return ''
  }
  const date = new Date(ms)
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (days === 0)
  {
    return `Today, ${timeOfDay(date)}`
  }
  if (days === 1)
  {
    return `Yesterday, ${timeOfDay(date)}`
  }
  if (date.getFullYear() !== new Date(now).getFullYear())
  {
    return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${timeOfDay(date)}`
}

/** A media length as a clock to the second: "0:08", "4:12", "1:59:24"; empty when unknown. */
export function formatLength(seconds: number | undefined | null): string
{
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds <= 0)
  {
    return ''
  }
  const whole = Math.round(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** A duration with milliseconds: "00:30.000", "1:02:03.250"; empty when unknown. */
export function formatPreciseLength(seconds: number | string | undefined): string
{
  const value = typeof seconds === 'string' ? parseFloat(seconds) : seconds
  if (value === undefined || !Number.isFinite(value) || value <= 0)
  {
    return ''
  }
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const rest = (value % 60).toFixed(3).padStart(6, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${String(minutes).padStart(2, '0')}:${rest}`
}

/** A file size in the units Explorer shows (1 KB is 1024 bytes): "980 KB", "12.1 MB"; empty when unknown. */
export function formatFileSize(bytes: number | string | undefined): string
{
  const value = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes
  if (value === undefined || !Number.isFinite(value) || value <= 0)
  {
    return ''
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1)
  {
    scaled /= 1024
    unit += 1
  }
  const digits = unit === 0 || scaled >= 100 ? 0 : 1
  return `${scaled.toFixed(digits).replace(/\.0$/, '')} ${units[unit]}`
}

/** A bit rate: "3.4 Mb/s", "128 kb/s"; empty when unknown. */
export function formatBitRate(bitsPerSecond: number | string | undefined): string
{
  const value = typeof bitsPerSecond === 'string' ? parseInt(bitsPerSecond, 10) : bitsPerSecond
  if (value === undefined || !Number.isFinite(value) || value <= 0)
  {
    return ''
  }
  if (value >= 1_000_000)
  {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')} Mb/s`
  }
  if (value >= 1_000)
  {
    return `${Math.round(value / 1_000)} kb/s`
  }
  return `${value} b/s`
}

/** An FFprobe rational frame rate ("30000/1001") as frames per second: "29.97 fps", "30 fps"; empty when unknown. */
export function formatFrameRate(rate: string | undefined): string
{
  if (!rate)
  {
    return ''
  }
  const [numerator, denominator] = rate.split('/').map(Number)
  const value = denominator === undefined ? numerator : denominator > 0 ? numerator / denominator : NaN
  if (!Number.isFinite(value) || value <= 0)
  {
    return ''
  }
  return `${Number(value.toFixed(3))} fps`
}

/** A sample rate: "48 kHz", "44.1 kHz"; empty when unknown. */
export function formatSampleRate(hertz: number | string | undefined): string
{
  const value = typeof hertz === 'string' ? parseInt(hertz, 10) : hertz
  if (value === undefined || !Number.isFinite(value) || value <= 0)
  {
    return ''
  }
  return `${Number((value / 1000).toFixed(1))} kHz`
}

/**
 * Subtitles as the player shows them: WebVTT from FFmpeg read into timed cues, the cue at a moment found by
 * binary search, and cue text reduced to plain lines, so they draw over the picture and the visualization alike.
 */

/** One subtitle line or block, in source seconds. */
export interface Cue
{
  start: number
  end: number
  text: string
}

/** "01:02:03.456" or "02:03.456" as seconds; null when it is not a WebVTT time. */
export function parseVttTime(text: string): number | null
{
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text.trim())
  if (!match)
  {
    return null
  }
  const hours = match[1] === undefined ? 0 : Number(match[1])
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' }

/** Cue text without WebVTT tags (italics, voices, classes, timestamps) and with its entities decoded. */
export function plainCueText(text: string): string
{
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (entity) => ENTITIES[entity] ?? entity)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** The cues of a WebVTT file in start order; blocks without a valid timing line are skipped. */
export function parseVtt(text: string): Cue[]
{
  const cues: Cue[] = []
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks)
  {
    const lines = block.split('\n')
    const timing = lines.findIndex((line) => line.includes('-->'))
    if (timing < 0)
    {
      continue
    }
    const [from, rest] = lines[timing].split('-->')
    const start = parseVttTime(from)
    const end = parseVttTime((rest ?? '').trim().split(/\s+/)[0] ?? '')
    const body = plainCueText(lines.slice(timing + 1).join('\n'))
    if (start === null || end === null || end <= start || body === '')
    {
      continue
    }
    cues.push({ start, end, text: body })
  }
  return cues.sort((a, b) => a.start - b.start)
}

/** The text showing at `time`: every cue that covers it, joined in start order; empty when none does. */
export function cueTextAt(cues: readonly Cue[], time: number): string
{
  let low = 0
  let high = cues.length
  while (low < high)
  {
    const mid = (low + high) >> 1
    if (cues[mid].start <= time)
    {
      low = mid + 1
    }
    else
    {
      high = mid
    }
  }
  const shown: string[] = []
  for (let i = low - 1; i >= 0 && shown.length < 3; i--)
  {
    if (cues[i].end > time && cues[i].start <= time)
    {
      shown.unshift(cues[i].text)
    }
    if (time - cues[i].start > 60)
    {
      break
    }
  }
  return shown.join('\n')
}

import React from 'react'
import { codecLabel } from '../../../../../shared/audio/messages'
import type { AudioFacts, MediaFacts } from '../../../../../shared/audio/types'
import { containerLabel } from '../../../../../shared/jobs/describe'
import type { JobPlan } from '../../../../../shared/jobs/types'
import { countOf, PART_SEPARATOR } from '../../../copy/batch'
import { cx } from '../../../ui'

/** One line of a stream list: the stream's name and what the plan does with it, or why it is not kept. */
export interface StreamLine
{
  key: string
  term: string
  detail: string
}

/** The kept and not-kept lines of one job's plan. */
export interface StreamLines
{
  kept: StreamLine[]
  dropped: StreamLine[]
}

type Kept = JobPlan['streams']['kept'][number]
type Dropped = JobPlan['streams']['dropped'][number]

const KIND_TERMS: Readonly<Record<string, string>> =
{
  video: 'Video',
  cover: 'Cover art',
  audio: 'Audio',
  subtitle: 'Subtitle',
  attachment: 'Attachments',
  data: 'Data streams'
}

const COUNTED_KINDS: Readonly<Record<string, readonly [string, string]>> =
{
  attachment: ['attachment', 'attachments'],
  data: ['data stream', 'data streams'],
  cover: ['cover image', 'cover images']
}

const ACTION_WORDS: Readonly<Record<Kept['action'], string>> = { copy: 'copied', encode: 'encoded', convert: 'converted' }

let languageNames: Intl.DisplayNames | null | undefined

/** A stream's language in words ("English" for eng); null when unknown or undetermined. */
export function languageName(code: string | null): string | null
{
  if (code === null || code === '' || code === 'und')
  {
    return null
  }
  if (languageNames === undefined)
  {
    try
    {
      languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
    }
    catch
    {
      languageNames = null
    }
  }
  try
  {
    return languageNames?.of(code) ?? code
  }
  catch
  {
    return code
  }
}

function kindTerm(kind: string): string
{
  return KIND_TERMS[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

function sentence(text: string): string
{
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

/** Main's drop reason in words for the output container, as its streams issue words it. */
export function dropReasonText(reason: string, container: string): string
{
  const label = containerLabel(container)
  switch (reason)
  {
    case 'container-no-video':
      return sentence(`${label} holds no video`)
    case 'container-one-audio':
      return sentence(`${label} holds one audio stream`)
    case 'subtitle-unsupported':
      return sentence(`${label} cannot hold these subtitles`)
    case 'bitmap-subtitle':
      return sentence(`${label} cannot hold bitmap subtitles`)
    case 'attachments-unsupported':
      return sentence(`${label} cannot hold attachments`)
    case 'cover-unsupported':
      return sentence(`${label} cannot hold cover art`)
    case 'data-stream':
      return 'Data streams are not kept.'
    case 'policy':
      return 'These settings drop it.'
    default:
      return /[.!?]$/.test(reason) ? reason : sentence(reason)
  }
}

function title(text: string | null): string | null
{
  return text === null || text === '' ? null : `“${text}”`
}

function joinParts(parts: ReadonlyArray<string | null>): string
{
  return parts.filter((part): part is string => part !== null && part !== '').join(PART_SEPARATOR)
}

function audioOutput(plan: JobPlan, facts: AudioFacts | undefined, action: Kept['action']): string
{
  const out = facts === undefined ? undefined : plan.audio.find((stream) => stream.audioIndex === facts.audioIndex)
  if (action === 'copy' || out === undefined || out.encoder === 'copy')
  {
    return ACTION_WORDS[action]
  }
  const rate = out.bitrateKbps === null ? '' : ` ${out.bitrateKbps} kb/s`
  return `${ACTION_WORDS[action]} as ${codecLabel(out.encoder)}${rate}`
}

function videoOutput(plan: JobPlan, action: Kept['action']): string
{
  return action === 'copy' || plan.video === null ? ACTION_WORDS[action] : `${ACTION_WORDS[action]} as ${plan.video.encoder}`
}

/** Names one source stream and describes it from the probe: kind and number, then codec, layout, language, title. */
function describeStream(kind: string, source: number, media: MediaFacts | null): { term: string; parts: Array<string | null> }
{
  if (kind === 'audio')
  {
    const facts = media?.audio.find((stream) => stream.streamIndex === source)
    if (facts !== undefined)
    {
      return {
        term: `Audio ${facts.audioIndex + 1}`,
        parts: [codecLabel(facts.codecName), facts.layout, languageName(facts.language), title(facts.title)]
      }
    }
  }
  if (kind === 'video')
  {
    const pictures = media?.video.filter((stream) => !stream.cover) ?? []
    const at = pictures.findIndex((stream) => stream.streamIndex === source)
    if (at !== -1)
    {
      return { term: `Video ${at + 1}`, parts: [pictures[at].codecName] }
    }
  }
  if (kind === 'subtitle')
  {
    const facts = media?.subtitles.find((stream) => stream.streamIndex === source)
    if (facts !== undefined)
    {
      return {
        term: `Subtitle ${facts.subIndex + 1}`,
        parts: [facts.codecName, facts.bitmap ? 'bitmap' : null, languageName(facts.language)]
      }
    }
  }
  return { term: `${kindTerm(kind)}, stream ${source}`, parts: [] }
}

function countedLines(entries: ReadonlyArray<{ kind: string; detail: (count: string) => string; group: string }>, prefix: string): StreamLine[]
{
  const groups = new Map<string, { kind: string; count: number; detail: (count: string) => string }>()
  for (const entry of entries)
  {
    const existing = groups.get(entry.group)
    if (existing === undefined)
    {
      groups.set(entry.group, { kind: entry.kind, count: 1, detail: entry.detail })
    }
    else
    {
      existing.count += 1
    }
  }
  return [...groups.entries()].map(([group, { kind, count, detail }]) =>
  {
    const [one, many] = COUNTED_KINDS[kind]
    return { key: `${prefix}-${group}`, term: kindTerm(kind), detail: detail(countOf(count, one, many)) }
  })
}

function keptLine(stream: Kept, plan: JobPlan, media: MediaFacts | null): StreamLine
{
  const { term, parts } = describeStream(stream.kind, stream.source, media)
  const action = stream.kind === 'audio'
    ? audioOutput(plan, media?.audio.find((facts) => facts.streamIndex === stream.source), stream.action)
    : stream.kind === 'video' ? videoOutput(plan, stream.action) : ACTION_WORDS[stream.action]
  return { key: `kept-${stream.source}-${stream.output}`, term, detail: joinParts([...parts, action]) }
}

function droppedLine(stream: Dropped, container: string, media: MediaFacts | null): StreamLine
{
  const { term, parts } = describeStream(stream.kind, stream.source, media)
  const described = joinParts(parts)
  const reason = dropReasonText(stream.reason, container)
  return { key: `dropped-${stream.source}`, term, detail: described === '' ? reason : `${described}: ${reason}` }
}

/**
 * What one job's plan keeps and leaves out, one line per video, audio, and subtitle stream, with attachments, data
 * streams, cover art, and chapters counted.
 */
export function streamLines(plan: JobPlan, media: MediaFacts | null): StreamLines
{
  const container = plan.output.container
  const kept: StreamLine[] = []
  const keptCounted: Array<{ kind: string; detail: (count: string) => string; group: string }> = []
  for (const stream of plan.streams.kept)
  {
    if (Object.hasOwn(COUNTED_KINDS, stream.kind))
    {
      keptCounted.push({ kind: stream.kind, group: `${stream.kind}-${stream.action}`, detail: (count) => `${count}, ${ACTION_WORDS[stream.action]}` })
    }
    else
    {
      kept.push(keptLine(stream, plan, media))
    }
  }
  const dropped: StreamLine[] = []
  const droppedCounted: Array<{ kind: string; detail: (count: string) => string; group: string }> = []
  for (const stream of plan.streams.dropped)
  {
    if (Object.hasOwn(COUNTED_KINDS, stream.kind))
    {
      const reason = dropReasonText(stream.reason, container)
      droppedCounted.push({ kind: stream.kind, group: `${stream.kind}-${stream.reason}`, detail: (count) => `${count}: ${reason}` })
    }
    else
    {
      dropped.push(droppedLine(stream, container, media))
    }
  }
  kept.push(...countedLines(keptCounted, 'kept'))
  dropped.push(...countedLines(droppedCounted, 'dropped'))
  const chapters = media?.chapters ?? 0
  if (plan.streams.chapters === 'kept')
  {
    kept.push({ key: 'kept-chapters', term: 'Chapters', detail: chapters > 0 ? countOf(chapters, 'chapter') : 'kept' })
  }
  else if (plan.streams.chapters === 'dropped')
  {
    const count = chapters > 0 ? `${countOf(chapters, 'chapter')}: ` : ''
    dropped.push({ key: 'dropped-chapters', term: 'Chapters', detail: `${count}${containerLabel(container)} cannot hold chapters.` })
  }
  return { kept, dropped }
}

export interface StreamListProps
{
  lines: readonly StreamLine[]
  /** Names the list for assistive technology, such as "Streams kept". */
  label: string
  className?: string
}

/** A definition list of streams: each stream's name, then what the plan does with it or why it is not kept. */
export function StreamList({ lines, label, className }: StreamListProps): React.JSX.Element
{
  return (
    <dl aria-label={label} className={cx('grid select-text grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-label', className)}>
      {lines.map((line) => (
        <div key={line.key} className='contents'>
          <dt className='tabular-nums text-ink-2'>{line.term}</dt>
          <dd className='text-ink wrap-anywhere'>{line.detail}</dd>
        </div>
      ))}
    </dl>
  )
}

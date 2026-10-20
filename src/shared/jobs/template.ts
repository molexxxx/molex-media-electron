/**
 * The output naming template: parsed into text and tokens, rendered against one job's values, and sanitized segment
 * by segment the same way on every platform so names stay portable. The planner renders final paths with it and the
 * Output popover previews them with it, so the preview is the plan. The platform only picks the separator.
 */
import type { Platform } from '../text/platform'
import { operationWord, presetSlug } from './describe'
import type { Recipe } from './recipes'
import { TEMPLATE_TOKENS } from './types'

/** A token a template may use. */
export type TemplateToken = typeof TEMPLATE_TOKENS[number]

/** Each token's value for one job; subdir is the one value whose separators make folders. */
export type TemplateValues = Readonly<Record<TemplateToken, string>>

/** A piece of a parsed template: literal text, a known token, or an unknown one ({album}). */
export type TemplatePart =
  | { kind: 'text'; text: string }
  | { kind: 'token'; token: TemplateToken }
  | { kind: 'unknown'; text: string }

/** A problem with a rendered name: errors block the job, sanitizing is a warning. */
export interface TemplateIssue
{
  code: 'template-unknown-token' | 'template-empty' | 'template-escapes' | 'template-sanitized'
  severity: 'error' | 'warning'
  message: string
}

/** A rendered name: the folders under the destination, then the file stem (or the frames folder). */
export interface RenderedName
{
  /** False when an error blocks the name; the segments are then a best-effort preview. */
  ok: boolean
  segments: string[]
  /** The segments joined with the platform's separator. */
  relativePath: string
  issues: TemplateIssue[]
}

/** The most UTF-8 bytes a rendered segment keeps, leaving room for " (12)", the extension, and the work prefix. */
export const MAX_SEGMENT_BYTES = 200

const TOKEN_PATTERN = /\{([^{}]+)\}/g
const UNSAFE_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/g
const SEPARATORS = /[\\/]/
const DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
const ABSOLUTE = /^([\\/]|[A-Za-z]:)/

function isToken(name: string): name is TemplateToken
{
  return (TEMPLATE_TOKENS as readonly string[]).includes(name)
}

/** The parts of a template in order; any {word} that is not a token is an unknown part. */
export function parseTemplate(template: string): TemplatePart[]
{
  const parts: TemplatePart[] = []
  let last = 0
  for (const match of template.matchAll(TOKEN_PATTERN))
  {
    if (match.index > last)
    {
      parts.push({ kind: 'text', text: template.slice(last, match.index) })
    }
    parts.push(isToken(match[1]) ? { kind: 'token', token: match[1] } : { kind: 'unknown', text: match[0] })
    last = match.index + match[0].length
  }
  if (last < template.length)
  {
    parts.push({ kind: 'text', text: template.slice(last) })
  }
  return parts
}

/** The unknown tokens of a template, each once, in order. */
export function unknownTokens(template: string): string[]
{
  return [...new Set(parseTemplate(template).flatMap((part) => (part.kind === 'unknown' ? [part.text] : [])))]
}

function utf8Bytes(char: string): number
{
  const code = char.codePointAt(0) as number
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

/** A segment cut to at most MAX_SEGMENT_BYTES UTF-8 bytes, never inside a character. */
export function truncateSegment(segment: string, maxBytes: number = MAX_SEGMENT_BYTES): string
{
  let bytes = 0
  let end = 0
  for (const char of segment)
  {
    bytes += utf8Bytes(char)
    if (bytes > maxBytes)
    {
      return segment.slice(0, end)
    }
    end += char.length
  }
  return segment
}

function trimEnd(segment: string): string
{
  return segment.replace(/[. ]+$/, '')
}

/** What sanitizing changed in a segment. */
interface Changes
{
  characters: boolean
  trimmed: boolean
  device: string | null
  truncated: boolean
}

function sanitizeSegment(raw: string, changes: Changes): string
{
  if (raw === '' || raw === '.')
  {
    return ''
  }
  let segment = raw.replace(UNSAFE_CHARACTERS, '_')
  changes.characters ||= segment !== raw
  const trimmed = trimEnd(segment)
  changes.trimmed ||= trimmed !== segment
  segment = trimmed
  const device = DEVICE_NAME.exec(segment)
  if (device)
  {
    changes.device = device[1]
    segment = `${device[1]}_${device[2] ?? ''}`
  }
  const cut = truncateSegment(segment)
  if (cut !== segment)
  {
    changes.truncated = true
    segment = trimEnd(cut)
  }
  return segment
}

function sanitizeIssues(changes: Changes): TemplateIssue[]
{
  const issues: TemplateIssue[] = []
  const warn = (message: string): void =>
  {
    issues.push({ code: 'template-sanitized', severity: 'warning', message })
  }
  if (changes.characters)
  {
    warn('Characters that file names cannot hold were replaced with _.')
  }
  if (changes.trimmed)
  {
    warn('Dots and spaces at the end of a name were removed.')
  }
  if (changes.device !== null)
  {
    warn(`${changes.device.toUpperCase()} is a reserved name on Windows, so the name ends with _.`)
  }
  if (changes.truncated)
  {
    warn(`A name longer than ${MAX_SEGMENT_BYTES} bytes was shortened.`)
  }
  return issues
}

function noChanges(): Changes
{
  return { characters: false, trimmed: false, device: null, truncated: false }
}

/**
 * Every segment of a name sanitized the same way on every platform: the characters <>:"|?* and control characters
 * become _, trailing dots and spaces are trimmed, Windows device names get a trailing _, and a segment over
 * MAX_SEGMENT_BYTES is cut. Each kind of change adds one warning.
 */
export function sanitizeSegments(segments: readonly string[]): { segments: string[]; issues: TemplateIssue[] }
{
  const changes = noChanges()
  const clean = segments.map((segment) => sanitizeSegment(segment, changes))
  return { segments: clean, issues: sanitizeIssues(changes) }
}

/** The separator of a platform's paths. */
export function pathSeparator(platform: Platform): string
{
  return platform === 'win32' ? '\\' : '/'
}

function rawSegments(parts: readonly TemplatePart[], values: TemplateValues, changes: Changes): string[]
{
  const segments: string[] = ['']
  const write = (text: string): void =>
  {
    text.split(SEPARATORS).forEach((piece, index) =>
    {
      if (index > 0)
      {
        segments.push('')
      }
      segments[segments.length - 1] += piece
    })
  }
  for (const part of parts)
  {
    if (part.kind !== 'token')
    {
      write(part.text)
    }
    else if (part.token === 'subdir')
    {
      write(values.subdir)
    }
    else
    {
      const value = values[part.token]
      const flat = value.replace(/[\\/]/g, '_')
      changes.characters ||= flat !== value
      segments[segments.length - 1] += flat
    }
  }
  return segments
}

function error(code: TemplateIssue['code'], message: string): TemplateIssue
{
  return { code, severity: 'error', message }
}

/**
 * Renders a template for one job. Literal / and \ separate segments and empty segments collapse, so {subdir}/{name}
 * works for files added one by one; a separator inside a token value is sanitized, except in {subdir}. Unknown
 * tokens, an empty stem, '..', and a template that starts at a root or a drive are errors.
 */
export function renderTemplate(template: string, values: TemplateValues, platform: Platform): RenderedName
{
  const issues: TemplateIssue[] = unknownTokens(template).map((token) => error('template-unknown-token', `Unknown token ${token} in the file name.`))
  if (ABSOLUTE.test(template))
  {
    issues.push(error('template-escapes', 'The file name cannot be a full path; choose the folder under Destination.'))
  }
  const changes = noChanges()
  const raw = rawSegments(parseTemplate(template), values, changes)
  const climbs = raw.map((segment) => segment.trim() === '..')
  if (climbs.includes(true))
  {
    issues.push(error('template-escapes', 'File names cannot climb out of the folder (..).'))
  }
  const sanitized = raw.map((segment, index) => (climbs[index] ? '' : sanitizeSegment(segment, changes)))
  if (sanitized[sanitized.length - 1] === '' && !climbs[climbs.length - 1])
  {
    issues.push(error('template-empty', 'The file name is empty; add {name} or {catalog}.'))
  }
  issues.push(...sanitizeIssues(changes))
  const segments = sanitized.filter((segment) => segment !== '')
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    segments,
    relativePath: segments.join(pathSeparator(platform)),
    issues
  }
}

/** The {date} value: a local calendar date as YYYY-MM-DD. */
export function templateDate(epochMs: number): string
{
  const date = new Date(epochMs)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** A file name without its last extension; a leading dot starts no extension. */
export function stemOf(fileName: string): string
{
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

/** The values of every token for one job. */
export function templateValues(job: { catalog: string; stem: string; ext: string; subdir: string; recipe: Recipe; date: string }): TemplateValues
{
  return {
    name: job.stem,
    ext: job.ext,
    op: operationWord(job.recipe.kind),
    preset: presetSlug(job.recipe),
    catalog: job.catalog,
    date: job.date,
    subdir: job.subdir
  }
}

/** A path with every % doubled, so FFmpeg's image2 muxer reads it literally. */
export function escapePercent(path: string): string
{
  return path.replace(/%/g, '%%')
}

/** The image2 output pattern inside a frames folder: frame_%04d.<format>, with every % of the folder doubled. */
export function frameSequencePattern(folder: string, format: 'png' | 'jpg' | 'webp', platform: Platform): string
{
  const separator = pathSeparator(platform)
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`
  return `${escapePercent(base)}frame_%04d.${format}`
}

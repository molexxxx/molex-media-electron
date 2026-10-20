/**
 * The Output popover's file name field: the naming template with "Insert field" at the caret, the fixed
 * "+ output extension" suffix, the check items that add a leading folder token, and a live preview of one job's
 * resolved path through the same renderTemplate the planner uses.
 */
import React, { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { Platform } from '../../../../../shared/text/platform'
import type { Recipe } from '../../../../../shared/jobs/recipes'
import
{
  parseTemplate,
  pathSeparator,
  renderTemplate,
  stemOf,
  templateValues,
  type TemplateIssue,
  type TemplateToken
} from '../../../../../shared/jobs/template'
import { Button, Checkbox, FieldCaption, FieldMessage, Menu } from '../../../ui'

/** A job as the preview needs it: catalog number, source name and folder, subfolder, recipe, and output extension. */
export interface TemplatePreviewJob
{
  catalog: string
  /** The source file's name with its extension. */
  fileName: string
  /** The source file's folder, where Next to each source writes. */
  directory: string
  subdir: string
  recipe: Recipe
  /** The output extension without the dot; null until the plan knows it. */
  outputExt: string | null
}

/** One entry of the "Insert field" menu. */
export interface TemplateFieldEntry
{
  token: TemplateToken
  label: string
  hint?: string
}

/** The "Insert field" menu, in the order the menu lists them. */
export const TEMPLATE_FIELDS: readonly TemplateFieldEntry[] = [
  { token: 'name', label: 'Name ({name})' },
  { token: 'ext', label: 'Source extension ({ext})' },
  { token: 'op', label: 'Operation ({op})', hint: 'normalize, gain, convert, compress, or extract' },
  { token: 'preset', label: 'Preset ({preset})' },
  { token: 'catalog', label: 'Job number ({catalog})' },
  { token: 'date', label: 'Date ({date})' },
  { token: 'subdir', label: 'Source subfolder ({subdir})' }
]

/** The tokens a check item adds as a leading folder, in the order they stack. */
export type LeadingToken = 'preset' | 'subdir'

const LEADING_ORDER: readonly LeadingToken[] = ['preset', 'subdir']

/** Replaces the selection (or inserts at the caret) with a token; returns the new text and the caret after it. */
export function insertToken(text: string, start: number, end: number, token: TemplateToken): { text: string; caret: number }
{
  const from = Math.max(0, Math.min(start, end, text.length))
  const to = Math.min(text.length, Math.max(start, end))
  const inserted = `{${token}}`
  return { text: text.slice(0, from) + inserted + text.slice(to), caret: from + inserted.length }
}

/** Splits the leading run of {preset}/ and {subdir}/ folders from the rest of a template. */
function splitLeading(template: string): { leading: Set<LeadingToken>; rest: string }
{
  const leading = new Set<LeadingToken>()
  let rest = template
  for (;;)
  {
    const match = /^\{(preset|subdir)\}[/\\]/.exec(rest)
    if (match === null)
    {
      return { leading, rest }
    }
    leading.add(match[1] as LeadingToken)
    rest = rest.slice(match[0].length)
  }
}

/** Whether the template starts with the token as a folder, as its check item shows. */
export function hasLeadingToken(template: string, token: LeadingToken): boolean
{
  return splitLeading(template).leading.has(token)
}

/** Adds or removes a leading folder token, keeping {preset}/ before {subdir}/ and the rest of the text as typed. */
export function withLeadingToken(template: string, token: LeadingToken, on: boolean): string
{
  const { leading, rest } = splitLeading(template)
  if (on)
  {
    leading.add(token)
  }
  else
  {
    leading.delete(token)
  }
  return LEADING_ORDER.filter((entry) => leading.has(entry)).map((entry) => `{${entry}}/`).join('') + rest
}

/** Joins a folder and a relative path with the platform's separator, never doubling one. */
function joinPath(base: string, relative: string, platform: Platform): string
{
  const separator = pathSeparator(platform)
  if (base === '')
  {
    return relative
  }
  return /[/\\]$/.test(base) ? base + relative : base + separator + relative
}

/** What the preview shows: the resolved path (null when nothing renders) and the template's issues for that job. */
export interface TemplatePreview
{
  path: string | null
  issues: TemplateIssue[]
}

/**
 * Resolves one job's output path with the shared template renderer: the folder (or the job's own folder when no
 * folder applies), the rendered segments, then the output extension.
 */
export function previewPath(template: string, job: TemplatePreviewJob, options: { folder: string | null; platform: Platform; date: string }): TemplatePreview
{
  const values = templateValues({
    catalog: job.catalog,
    stem: stemOf(job.fileName),
    ext: extensionOf(job.fileName),
    subdir: job.subdir,
    recipe: job.recipe,
    date: options.date
  })
  const rendered = renderTemplate(template, values, options.platform)
  if (rendered.relativePath === '')
  {
    return { path: null, issues: rendered.issues }
  }
  const file = job.outputExt === null || job.outputExt === '' ? rendered.relativePath : `${rendered.relativePath}.${job.outputExt}`
  return { path: joinPath(options.folder ?? job.directory, file, options.platform), issues: rendered.issues }
}

/** A file name's last extension without the dot; a leading dot starts no extension. */
export function extensionOf(fileName: string): string
{
  const stem = stemOf(fileName)
  return stem.length < fileName.length ? fileName.slice(stem.length + 1) : ''
}

/** Main's warning for a template that names every output the same. */
export const SHARED_NAME_WARNING = 'Without {name} or {catalog} in the name, outputs from different sources share a name and are numbered (2).'

/** Whether a template names outputs by source or job, so different sources never share a name. */
export function namesEachOutput(template: string): boolean
{
  return parseTemplate(template).some((part) => part.kind === 'token' && (part.token === 'name' || part.token === 'catalog'))
}

const PLACEHOLDER_VALUES = { name: 'name', ext: 'ext', op: 'op', preset: 'preset', catalog: 'MM-0001', date: '2000-01-01', subdir: '' } as const

/** The errors and warnings a template shows: main's refusal first, then the shared renderer's issues for the job. */
export function templateMessages(template: string, preview: TemplatePreview | null, platform: Platform, refusal: string | null): { error: string | null; notes: string[] }
{
  const issues = preview?.issues ?? renderTemplate(template, PLACEHOLDER_VALUES, platform).issues
  const firstError = issues.find((issue) => issue.severity === 'error')?.message ?? null
  const notes = issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message)
  if (firstError === null && !namesEachOutput(template))
  {
    notes.push(SHARED_NAME_WARNING)
  }
  return { error: refusal ?? firstError, notes: [...new Set(notes)] }
}

const FIELD_FRAME = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken px-2 font-mono text-body text-ink',
  'transition-colors duration-fast ease-out',
  'enabled:not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill',
  'disabled:border-line disabled:text-ink-disabled read-only:border-line'
].join(' ')

/** Props for {@link NameTemplateField}. */
export interface NameTemplateFieldProps
{
  /** The input's id; the messages and preview derive theirs from it. */
  id: string
  /** "File name", or "File name for Extract jobs" in Replace mode. */
  caption: string
  /** The committed template. */
  value: string
  /** Sends a changed template; a refusal comes back through `error`. */
  onCommit(template: string): void
  /** The job the preview resolves: the focused job, or the first. */
  job: TemplatePreviewJob | null
  /** The folder outputs land in; null writes beside each source. */
  folder: string | null
  platform: Platform
  /** The {date} value of the preview: today. */
  date: string
  /** Main's refusal of the last template sent. */
  error?: string | null
  /** Read-only while a batch runs: the text stays selectable, nothing edits it. */
  readOnly?: boolean
}

/**
 * The file name template: typing commits on Enter or blur, "Insert field" and the check items commit at once, and
 * the preview resolves the job's real path through the shared renderer as the text changes.
 */
export function NameTemplateField({ id, caption, value, onCommit, job, folder, platform, date, error = null, readOnly = false }: NameTemplateFieldProps): React.JSX.Element
{
  const [draft, setDraft] = useState(value)
  const [sent, setSent] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  const caret = useRef({ start: value.length, end: value.length })
  const cancelFocus = useRef<(() => void) | null>(null)

  useEffect(() =>
  {
    setSent(null)
    if (!focused.current)
    {
      setDraft(value)
    }
  }, [value])
  useEffect(() => () => cancelFocus.current?.(), [])

  const commit = (text: string): void =>
  {
    if (!readOnly && text !== value && text !== sent)
    {
      setSent(text)
      onCommit(text)
    }
  }
  const remember = (): void =>
  {
    const element = input.current
    if (element !== null && element.selectionStart !== null)
    {
      caret.current = { start: element.selectionStart, end: element.selectionEnd ?? element.selectionStart }
    }
  }
  const insert = (token: TemplateToken): void =>
  {
    const next = insertToken(draft, caret.current.start, caret.current.end, token)
    setDraft(next.text)
    caret.current = { start: next.caret, end: next.caret }
    commit(next.text)
    cancelFocus.current?.()
    const handle = window.requestAnimationFrame(() =>
    {
      input.current?.focus()
      input.current?.setSelectionRange(next.caret, next.caret)
    })
    cancelFocus.current = () => window.cancelAnimationFrame(handle)
  }
  const toggle = (token: LeadingToken, on: boolean): void =>
  {
    const next = withLeadingToken(draft, token, on)
    setDraft(next)
    commit(next)
  }

  const preview = job === null ? null : previewPath(draft, job, { folder, platform, date })
  const messages = templateMessages(draft, preview, platform, draft === (sent ?? value) ? error : null)
  const errorId = `${id}-error`
  const notesId = `${id}-notes`
  const previewId = `${id}-preview`
  const previewText = preview?.path ?? null
  const describedBy = [messages.error !== null ? errorId : '', messages.notes.length > 0 ? notesId : '', previewText !== null ? previewId : '']
    .filter((part) => part !== '')
    .join(' ')

  return (
    <div className="flex flex-col gap-2">
      <FieldCaption htmlFor={id}>{caption}</FieldCaption>
      <div className="flex items-center gap-2">
        <input
          ref={input}
          id={id}
          type="text"
          spellCheck={false}
          autoComplete="off"
          className={FIELD_FRAME}
          value={draft}
          readOnly={readOnly}
          aria-invalid={messages.error !== null || undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onFocus={() =>
          {
            focused.current = true
          }}
          onBlur={() =>
          {
            focused.current = false
            remember()
            commit(draft)
          }}
          onSelect={remember}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) =>
          {
            if (event.key === 'Enter')
            {
              event.preventDefault()
              commit(draft)
            }
          }}
        />
        <span className="shrink-0 font-mono text-label text-ink-3">+ output extension</span>
        <Menu
          label="Insert field"
          align="end"
          trigger={<Button iconEnd="action.openMenu" disabled={readOnly}>Insert field</Button>}
          items={TEMPLATE_FIELDS.map((entry) => ({ id: entry.token, label: entry.label, description: entry.hint, onSelect: () => insert(entry.token) }))}
        />
      </div>
      {messages.error !== null && <FieldMessage id={errorId} tone="error">{messages.error}</FieldMessage>}
      {messages.notes.length > 0 && (
        <div id={notesId} className="flex flex-col gap-1">
          {messages.notes.map((note, index) => <FieldMessage key={note} id={`${notesId}-${index}`} tone="note">{note}</FieldMessage>)}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Checkbox checked={hasLeadingToken(draft, 'subdir')} disabled={readOnly} onChange={(event) => toggle('subdir', event.target.checked)}>Keep source subfolders</Checkbox>
        <Checkbox checked={hasLeadingToken(draft, 'preset')} disabled={readOnly} onChange={(event) => toggle('preset', event.target.checked)}>One folder per preset</Checkbox>
      </div>
      {previewText !== null && <p id={previewId} className="font-mono text-label break-all text-ink-2">{`Example: ${previewText}`}</p>}
    </div>
  )
}

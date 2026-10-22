/**
 * @module editor/shared/Field
 * The editor's inspector fields: a caption above its control with an optional note under it, and the
 * More settings disclosure that folds rare fields away, as in the Batch inspector.
 */
import { useCallback, useId, useState, type ReactElement, type ReactNode } from 'react'
import { Button } from '../../../ui/Button'
import { FieldCaption } from '../../../ui/FieldCaption'
import { FieldMessage } from '../../../ui/NumberField'
import { Switch } from '../../../ui/Switch'

/** Props of {@link EditorField}. */
export interface EditorFieldProps
{
  /** The caption, which names the control through `htmlFor` or `captionId`. */
  label: string
  /** The control's id, for a control the caption labels with `<label for>`. */
  htmlFor?: string
  /** The caption's id, for a group such as a segmented control that names itself with `aria-labelledby`. */
  captionId?: string
  /** A plain sentence under the control. */
  note?: string
  noteId?: string
  children: ReactNode
}

/** One field: caption, control, and note. */
export function EditorField({ label, htmlFor, captionId, note, noteId, children }: EditorFieldProps): ReactElement
{
  const fallbackId = useId()
  return (
    <div className="flex min-w-0 flex-col">
      <FieldCaption htmlFor={htmlFor} id={captionId}>{label}</FieldCaption>
      {children}
      {note ? <FieldMessage id={noteId ?? `${fallbackId}-note`} tone="note" className="mt-1.5">{note}</FieldMessage> : null}
    </div>
  )
}

/** Props of {@link SwitchRow}. */
export interface SwitchRowProps
{
  label: string
  /** A plain sentence under the label. */
  note?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}

/** A switch with its label and note on one row, the label naming the switch. */
export function SwitchRow({ label, note, checked, onChange, disabled }: SwitchRowProps): ReactElement
{
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-body text-ink">{label}</label>
        {note ? <p id={`${id}-note`} className="text-label text-ink-3">{note}</p> : null}
      </div>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} describedBy={note ? `${id}-note` : undefined} />
    </div>
  )
}

function readOpen(key: string): boolean
{
  try
  {
    return window.localStorage.getItem(key) === 'open'
  }
  catch
  {
    return false
  }
}

function writeOpen(key: string, open: boolean): void
{
  try
  {
    window.localStorage.setItem(key, open ? 'open' : 'closed')
  }
  catch
  {
    return
  }
}

/** Whether a More settings disclosure is open; the choice is remembered per scope where storage allows. */
export function useDisclosure(scope: string): [boolean, (open: boolean) => void]
{
  const key = `molexMedia.editor.moreSettings.${scope}`
  const [open, setOpenState] = useState(() => readOpen(key))
  const setOpen = useCallback((next: boolean) =>
  {
    writeOpen(key, next)
    setOpenState(next)
  }, [key])
  return [open, setOpen]
}

/** Props of {@link MoreSettings}. */
export interface MoreSettingsProps
{
  /** Names the remembered state. */
  scope: string
  children: ReactNode
}

/** "More settings": rare fields, folded away until asked for. */
export function MoreSettings({ scope, children }: MoreSettingsProps): ReactElement
{
  const [open, setOpen] = useDisclosure(scope)
  const regionId = useId()
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        icon={open ? 'action.collapse' : 'action.expand'}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        className="-ms-2 self-start"
      >
        {open ? 'Fewer settings' : 'More settings'}
      </Button>
      <div id={regionId} hidden={!open} className={open ? 'flex flex-col gap-4' : undefined}>
        {open ? children : null}
      </div>
    </div>
  )
}

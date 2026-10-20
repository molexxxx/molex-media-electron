/**
 * @module components/layout/CloseConfirmModal
 * @description The question main asks when the window closes with minimize
 * to tray on: keep molexMedia running in the tray, or quit. The shell mounts
 * it above its initializing and setup screens, so a close during first run
 * asks too.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, Checkbox, Dialog } from '../../ui'

/** The answer main acts on. */
export type CloseChoice = 'minimize' | 'quit'

/**
 * Opens on main's close request with focus on "Minimize to tray", the choice that keeps every batch
 * running. Escape keeps the window open and sends no answer.
 */
export function CloseConfirmModal(): ReactElement
{
  const [open, setOpen] = useState(false)
  const [dontAsk, setDontAsk] = useState(false)
  const minimizeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => window.api.onCloseConfirm(() =>
  {
    setDontAsk(false)
    setOpen(true)
  }), [])

  const respond = (choice: CloseChoice): void =>
  {
    setOpen(false)
    window.api.closeConfirmResponse(choice, dontAsk)
  }

  const actions = (
    <>
      <Button variant="secondary" onClick={() => respond('quit')}>Quit</Button>
      <Button ref={minimizeRef} variant="primary" onClick={() => respond('minimize')}>Minimize to tray</Button>
    </>
  )

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Minimize to tray?"
      description="molexMedia keeps running in the system tray, and a running batch carries on. Restore it by double-clicking the tray icon, or quit from the tray menu."
      initialFocusRef={minimizeRef}
      actions={actions}
    >
      <Checkbox checked={dontAsk} onChange={(event) => setDontAsk(event.currentTarget.checked)}>
        Don&apos;t ask again
      </Checkbox>
    </Dialog>
  )
}

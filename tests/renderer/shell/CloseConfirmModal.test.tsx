/**
 * CloseConfirmModal: a native modal Dialog opened by main's close request, focus on the safe action,
 * a real Checkbox for "Don't ask again", each answer sent once, and Escape keeping the window open.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { CloseConfirmModal } from '../../../src/renderer/src/components/layout/CloseConfirmModal'

let openRequest: (() => void) | null = null
const closeConfirmResponse = vi.fn()
const unsubscribe = vi.fn()

beforeEach(() =>
{
  openRequest = null
  closeConfirmResponse.mockReset()
  unsubscribe.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    onCloseConfirm: (cb: () => void) =>
    {
      openRequest = cb
      return unsubscribe
    },
    closeConfirmResponse
  }
})

afterEach(() =>
{
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function requestClose(): void
{
  act(() => openRequest?.())
}

function dialog(): HTMLDialogElement
{
  return document.querySelector('dialog') as HTMLDialogElement
}

describe('CloseConfirmModal', () =>
{
  it('stays closed until main asks, then opens as a modal dialog with its title and description', () =>
  {
    render(<CloseConfirmModal />)
    expect(dialog().open).toBe(false)
    requestClose()
    expect(dialog().open).toBe(true)
    const titled = screen.getByRole('dialog', { name: 'Minimize to tray?' })
    expect(titled).toHaveAccessibleDescription(/keeps running in the system tray/)
  })

  it('starts focus on Minimize to tray, the safe action', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    expect(screen.getByRole('button', { name: 'Minimize to tray' })).toHaveFocus()
  })

  it('offers a real checkbox for not asking again', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    const box = screen.getByRole('checkbox', { name: "Don't ask again" })
    expect(box).toBeInstanceOf(HTMLInputElement)
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    expect(box).toBeChecked()
  })

  it('sends minimize with the checkbox state and closes', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    fireEvent.click(screen.getByRole('button', { name: 'Minimize to tray' }))
    expect(closeConfirmResponse).toHaveBeenCalledTimes(1)
    expect(closeConfirmResponse).toHaveBeenCalledWith('minimize', true)
    expect(dialog().open).toBe(false)
  })

  it('sends quit without the checkbox when it is left clear', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    fireEvent.click(screen.getByRole('button', { name: 'Quit' }))
    expect(closeConfirmResponse).toHaveBeenCalledWith('quit', false)
  })

  it('keeps the window open on Escape and sends no answer', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    fireEvent(dialog(), new Event('cancel', { cancelable: true }))
    expect(dialog().open).toBe(false)
    expect(closeConfirmResponse).not.toHaveBeenCalled()
  })

  it('clears the checkbox for the next close request', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    fireEvent(dialog(), new Event('cancel', { cancelable: true }))
    requestClose()
    expect(screen.getByRole('checkbox', { name: "Don't ask again" })).not.toBeChecked()
  })

  it('puts the secondary action first and the primary last in the footer', () =>
  {
    render(<CloseConfirmModal />)
    requestClose()
    const names = Array.from(dialog().querySelectorAll('button')).map((b) => b.textContent)
    expect(names.indexOf('Quit')).toBeLessThan(names.indexOf('Minimize to tray'))
  })

  it('stops listening for close requests on unmount', () =>
  {
    const { unmount } = render(<CloseConfirmModal />)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

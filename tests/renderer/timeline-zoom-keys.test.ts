import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useTimelineKeyboard } from '@renderer/components/editor/hooks/useTimelineKeyboard'
import { useAppStore } from '@renderer/stores/appStore'
import { useEditorStore } from '@renderer/stores/editorStore'

type Coords = Parameters<typeof useTimelineKeyboard>[0]['coords']

function makeCoords(): Coords & { zoomIn: ReturnType<typeof vi.fn>, zoomOut: ReturnType<typeof vi.fn>, fitToView: ReturnType<typeof vi.fn> }
{
  return { zoomIn: vi.fn(), zoomOut: vi.fn(), fitToView: vi.fn() } as never
}

function pressWithCtrl(key: string): KeyboardEvent
{
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('timeline zoom keys', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('claims Ctrl+Plus, Ctrl+=, Ctrl+Minus, and Ctrl+0 while the editor timeline is the visible view', () =>
  {
    useAppStore.setState({ currentView: 'editor' })
    useEditorStore.setState({ mode: 'edit' })
    const coords = makeCoords()
    renderHook(() => useTimelineKeyboard({ coords }))

    for (const key of ['+', '=', '-', '0'])
    {
      expect(pressWithCtrl(key).defaultPrevented).toBe(true)
    }
    expect(coords.zoomIn).toHaveBeenCalledTimes(2)
    expect(coords.zoomOut).toHaveBeenCalledTimes(1)
    expect(coords.fitToView).toHaveBeenCalledTimes(1)
  })

  it('leaves every zoom key to app zoom while another view is visible and the editor stays mounted', () =>
  {
    useAppStore.setState({ currentView: 'dashboard' })
    useEditorStore.setState({ mode: 'edit' })
    const coords = makeCoords()
    renderHook(() => useTimelineKeyboard({ coords }))

    for (const key of ['+', '=', '-', '0'])
    {
      expect(pressWithCtrl(key).defaultPrevented).toBe(false)
    }
    expect(coords.zoomIn).not.toHaveBeenCalled()
    expect(coords.zoomOut).not.toHaveBeenCalled()
    expect(coords.fitToView).not.toHaveBeenCalled()
  })
})

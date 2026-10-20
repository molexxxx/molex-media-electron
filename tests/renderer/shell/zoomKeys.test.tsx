/**
 * App zoom keys: Ctrl+Plus, Ctrl+=, and Ctrl+Minus step the page zoom through the bridge, Ctrl+0 returns
 * to the Interface size setting, and every key another handler claimed is left alone, including the
 * visible editor timeline's own zoom whichever listener was added first.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import {
  appZoomCommand,
  applyAppZoom,
  interfaceZoomFactor,
  listenUnclaimedKeys,
  useAppZoomKeys
} from '../../../src/renderer/src/hooks/useAppZoomKeys'
import { useTimelineKeyboard } from '../../../src/renderer/src/components/editor/hooks/useTimelineKeyboard'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import type { AppConfig } from '../../../src/renderer/src/stores/types'

type Coords = Parameters<typeof useTimelineKeyboard>[0]['coords']

const api = {
  zoomIn: vi.fn(() => 1.1),
  zoomOut: vi.fn(() => 0.9),
  setZoomFactor: vi.fn((factor: number) => factor)
}

function makeCoords(): Coords & { zoomIn: ReturnType<typeof vi.fn>, zoomOut: ReturnType<typeof vi.fn>, fitToView: ReturnType<typeof vi.fn> }
{
  return { zoomIn: vi.fn(), zoomOut: vi.fn(), fitToView: vi.fn() } as never
}

function press(key: string, init: KeyboardEventInit = { ctrlKey: true }, target: EventTarget = window): KeyboardEvent
{
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function withScale(interfaceScale: number): void
{
  useAppStore.setState({ config: { interfaceScale } as AppConfig })
}

beforeEach(() =>
{
  api.zoomIn.mockClear()
  api.zoomOut.mockClear()
  api.setZoomFactor.mockClear()
  ;(window as unknown as { api: unknown }).api = api
  useAppStore.setState({ currentView: 'dashboard', config: null })
  useEditorStore.setState({ mode: 'edit' })
})

afterEach(() =>
{
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('appZoomCommand', () =>
{
  it('reads Plus and = as in, Minus as out, and 0 as reset with Ctrl or Cmd', () =>
  {
    expect(appZoomCommand({ key: '+', ctrlKey: true, metaKey: false, altKey: false })).toBe('in')
    expect(appZoomCommand({ key: '=', ctrlKey: true, metaKey: false, altKey: false })).toBe('in')
    expect(appZoomCommand({ key: '-', ctrlKey: true, metaKey: false, altKey: false })).toBe('out')
    expect(appZoomCommand({ key: '0', ctrlKey: false, metaKey: true, altKey: false })).toBe('reset')
  })

  it('ignores the keys without the modifier, with Alt, and any other key', () =>
  {
    expect(appZoomCommand({ key: '=', ctrlKey: false, metaKey: false, altKey: false })).toBeNull()
    expect(appZoomCommand({ key: '=', ctrlKey: true, metaKey: false, altKey: true })).toBeNull()
    expect(appZoomCommand({ key: 'k', ctrlKey: true, metaKey: false, altKey: false })).toBeNull()
  })
})

describe('applyAppZoom', () =>
{
  it('steps through the bridge and answers the factor applied', () =>
  {
    expect(applyAppZoom('in', 100)).toBe(1.1)
    expect(applyAppZoom('out', 100)).toBe(0.9)
    expect(api.zoomIn).toHaveBeenCalledTimes(1)
    expect(api.zoomOut).toHaveBeenCalledTimes(1)
  })

  it('resets to the Interface size, or 100 percent when it is unusable', () =>
  {
    expect(applyAppZoom('reset', 150)).toBe(1.5)
    expect(applyAppZoom('reset', undefined)).toBe(1)
    expect(interfaceZoomFactor(Number.NaN)).toBe(1)
    expect(interfaceZoomFactor(-5)).toBe(1)
    expect(interfaceZoomFactor(200)).toBe(2)
  })
})

describe('listenUnclaimedKeys', () =>
{
  it('runs after a window listener added later and skips the key it claimed', () =>
  {
    const seen = vi.fn()
    const stop = listenUnclaimedKeys(seen)
    const claim = (event: KeyboardEvent): void => event.preventDefault()
    window.addEventListener('keydown', claim)
    press('x')
    expect(seen).not.toHaveBeenCalled()
    window.removeEventListener('keydown', claim)
    press('x')
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
    press('x')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('skips a key claimed on its target and survives a stopped propagation', () =>
  {
    const seen = vi.fn()
    const stop = listenUnclaimedKeys(seen)
    const field = document.createElement('input')
    document.body.append(field)
    field.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
    press('a', {}, field)
    expect(seen).not.toHaveBeenCalled()
    field.addEventListener('keydown', (event) => event.stopPropagation(), { once: true })
    press('b', {}, field)
    expect(seen).not.toHaveBeenCalled()
    press('c', {}, field)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0].key).toBe('c')
    stop()
    field.remove()
  })
})

describe('useAppZoomKeys', () =>
{
  it('steps the zoom on Ctrl+Plus, Ctrl+=, and Ctrl+Minus and claims each key', () =>
  {
    renderHook(() => useAppZoomKeys())
    expect(press('+').defaultPrevented).toBe(true)
    expect(press('=').defaultPrevented).toBe(true)
    expect(press('-').defaultPrevented).toBe(true)
    expect(api.zoomIn).toHaveBeenCalledTimes(2)
    expect(api.zoomOut).toHaveBeenCalledTimes(1)
  })

  it('returns to the Interface size setting on Ctrl+0', () =>
  {
    withScale(125)
    renderHook(() => useAppZoomKeys())
    press('0')
    expect(api.setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('returns to 100 percent on Ctrl+0 before the config loads', () =>
  {
    renderHook(() => useAppZoomKeys())
    press('0')
    expect(api.setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('leaves plain keys and keys without the modifier alone', () =>
  {
    renderHook(() => useAppZoomKeys())
    expect(press('=', {}).defaultPrevented).toBe(false)
    expect(press('s').defaultPrevented).toBe(false)
    expect(api.zoomIn).not.toHaveBeenCalled()
  })

  it('stops on unmount', () =>
  {
    const { unmount } = renderHook(() => useAppZoomKeys())
    unmount()
    press('=')
    expect(api.zoomIn).not.toHaveBeenCalled()
  })
})

describe('app zoom beside the editor timeline', () =>
{
  for (const order of ['app zoom first', 'timeline first'] as const)
  {
    it(`lets the visible editor timeline claim its zoom keys (${order})`, () =>
    {
      withScale(150)
      useAppStore.setState({ currentView: 'editor' })
      const coords = makeCoords()
      if (order === 'app zoom first')
      {
        renderHook(() => useAppZoomKeys())
        renderHook(() => useTimelineKeyboard({ coords }))
      }
      else
      {
        renderHook(() => useTimelineKeyboard({ coords }))
        renderHook(() => useAppZoomKeys())
      }
      for (const key of ['+', '=', '-', '0'])
      {
        expect(press(key).defaultPrevented).toBe(true)
      }
      expect(coords.zoomIn).toHaveBeenCalledTimes(2)
      expect(coords.zoomOut).toHaveBeenCalledTimes(1)
      expect(coords.fitToView).toHaveBeenCalledTimes(1)
      expect(api.zoomIn).not.toHaveBeenCalled()
      expect(api.zoomOut).not.toHaveBeenCalled()
      expect(api.setZoomFactor).not.toHaveBeenCalled()
    })

    it(`zooms the page while the editor is mounted but hidden (${order})`, () =>
    {
      withScale(150)
      useAppStore.setState({ currentView: 'batch' })
      const coords = makeCoords()
      if (order === 'app zoom first')
      {
        renderHook(() => useAppZoomKeys())
        renderHook(() => useTimelineKeyboard({ coords }))
      }
      else
      {
        renderHook(() => useTimelineKeyboard({ coords }))
        renderHook(() => useAppZoomKeys())
      }
      for (const key of ['+', '=', '-', '0'])
      {
        expect(press(key).defaultPrevented).toBe(true)
      }
      expect(coords.zoomIn).not.toHaveBeenCalled()
      expect(coords.fitToView).not.toHaveBeenCalled()
      expect(api.zoomIn).toHaveBeenCalledTimes(2)
      expect(api.zoomOut).toHaveBeenCalledTimes(1)
      expect(api.setZoomFactor).toHaveBeenCalledWith(1.5)
    })
  }
})

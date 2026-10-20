/**
 * Guards the shell's F6 cycle: the rail, the visible view's regions in order
 * (or one work-area stop), then notifications when that region is not empty.
 */
import React, { useRef } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import {
  f6Order, f6ReturnTarget, focusNextRegion, registerF6Regions, registerShellStop, useF6Region, useShellStop
} from '../../../src/renderer/src/hooks/useF6Region'
import type { F6Region, ShellStopOptions } from '../../../src/renderer/src/hooks/useF6Region'

function BatchRegions({ summary = true }: { summary?: boolean }): React.JSX.Element
{
  const header = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLDivElement>(null)
  useF6Region('batch', [
    { name: 'header', ref: header },
    { name: 'toolbar', ref: toolbar },
    { name: 'summary', ref: slot },
    { name: 'table', ref: table }
  ])
  return (
    <div>
      <div ref={header}><button>Pause</button></div>
      <div ref={toolbar}><button disabled>Undo</button><button>Add files</button><button>Add folder</button></div>
      <button>Loose</button>
      {summary ? <div ref={slot}><span>2 need attention</span></div> : null}
      <div ref={table} role="grid">
        <div role="row" tabIndex={-1}>first</div>
        <div role="row" tabIndex={0}>second</div>
      </div>
    </div>
  )
}

function Shell({ toasts = 0, children }: { toasts?: number; children?: React.ReactNode }): React.JSX.Element
{
  return (
    <div>
      <nav aria-label="Sidebar">
        <button>Collapse sidebar</button>
        <button aria-current="page">Batch</button>
        <button>Logs</button>
      </nav>
      <main>
        {children}
        <div role="region" aria-label="Notifications">
          <div role="status" aria-live="polite" />
          <div role="alert" />
          {Array.from({ length: toasts }, (_, index) => (
            <div key={index} tabIndex={-1} data-testid={`toast-${index}`}>
              <button>Dismiss notification</button>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}

function ids(): string[]
{
  return f6Order().map((stop) => stop.id)
}

function focused(): Element | null
{
  return document.activeElement
}

function element(html: string): HTMLElement
{
  const host = document.createElement('div')
  host.innerHTML = html
  const node = host.firstElementChild as HTMLElement
  document.body.append(node)
  return node
}

describe('f6Order', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  afterEach(() =>
  {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lists the rail, then the visible view regions in their registered order', () =>
  {
    render(<Shell><BatchRegions /></Shell>)
    expect(ids()).toEqual(['rail', 'batch:header', 'batch:toolbar', 'batch:summary', 'batch:table'])
    const stop = f6Order()[1]
    expect(stop.kind).toBe('region')
    expect(stop.view).toBe('batch')
    expect(stop.name).toBe('header')
  })

  it('adds notifications only while that region is not empty', () =>
  {
    const { rerender } = render(<Shell><BatchRegions /></Shell>)
    expect(ids()).not.toContain('notifications')
    rerender(<Shell toasts={1}><BatchRegions /></Shell>)
    expect(ids().at(-1)).toBe('notifications')
  })

  it('counts one work-area stop while the registering view is hidden', () =>
  {
    useAppStore.setState({ currentView: 'dashboard' })
    render(<Shell><BatchRegions /></Shell>)
    expect(ids()).toEqual(['rail', 'work'])
  })

  it('skips a registered region that is not mounted', () =>
  {
    render(<Shell><BatchRegions summary={false} /></Shell>)
    expect(ids()).toEqual(['rail', 'batch:header', 'batch:toolbar', 'batch:table'])
  })

  it('drops the regions when the view unmounts', () =>
  {
    const { rerender } = render(<Shell><BatchRegions /></Shell>)
    rerender(<Shell />)
    expect(ids()).toEqual(['rail', 'work'])
  })

  it('skips regions hidden by attribute, inert subtree, or display', () =>
  {
    function Mixed(): React.JSX.Element
    {
      const shown = useRef<HTMLDivElement>(null)
      const hidden = useRef<HTMLDivElement>(null)
      const inert = useRef<HTMLDivElement>(null)
      const collapsed = useRef<HTMLDivElement>(null)
      useF6Region('settings', [
        { name: 'shown', ref: shown },
        { name: 'hidden', ref: hidden },
        { name: 'inert', ref: inert },
        { name: 'collapsed', ref: collapsed }
      ])
      return (
        <div>
          <div ref={shown} />
          <div ref={hidden} hidden />
          <div inert><div ref={inert} /></div>
          <div style={{ display: 'none' }}><div ref={collapsed} /></div>
        </div>
      )
    }
    useAppStore.setState({ currentView: 'settings' })
    render(<Shell><Mixed /></Shell>)
    expect(ids()).toEqual(['rail', 'settings:shown'])
  })

  it('honors an element reporting itself not visible', () =>
  {
    render(<Shell><BatchRegions /></Shell>)
    const header = screen.getByText('Pause').parentElement as HTMLElement
    Object.defineProperty(header, 'checkVisibility', { value: () => false, configurable: true })
    expect(ids()).not.toContain('batch:header')
  })

  it('follows the latest regions a view passes without registering twice', () =>
  {
    function Swapping({ flipped }: { flipped: boolean }): React.JSX.Element
    {
      const a = useRef<HTMLDivElement>(null)
      const b = useRef<HTMLDivElement>(null)
      const regions: F6Region[] = [{ name: 'a', ref: a }, { name: 'b', ref: b }]
      useF6Region('editor', flipped ? [...regions].reverse() : regions)
      return <div><div ref={a} /><div ref={b} /></div>
    }
    useAppStore.setState({ currentView: 'editor' })
    const { rerender } = render(<Shell><Swapping flipped={false} /></Shell>)
    expect(ids()).toEqual(['rail', 'editor:a', 'editor:b'])
    rerender(<Shell><Swapping flipped /></Shell>)
    expect(ids()).toEqual(['rail', 'editor:b', 'editor:a'])
  })

  it('orders separate registrations of one view by document position', () =>
  {
    useAppStore.setState({ currentView: 'player' })
    const first = element('<section></section>')
    const second = element('<section></section>')
    const offSecond = registerF6Regions('player', [{ name: 'second', ref: { current: second } }])
    const offFirst = registerF6Regions('player', () => [{ name: 'first', ref: { current: first } }])
    expect(ids()).toEqual(['player:first', 'player:second'])
    offFirst()
    offSecond()
    expect(ids()).toEqual([])
  })

  it('falls back to the work area while none of the view regions is present', () =>
  {
    render(<Shell />)
    const off = registerF6Regions('batch', [{ name: 'inspector', ref: { current: null } }])
    expect(ids()).toEqual(['rail', 'work'])
    off()
  })

  it('keeps registration order for registrations that start at the same element', () =>
  {
    useAppStore.setState({ currentView: 'player' })
    const shared = element('<section></section>')
    const offA = registerF6Regions('player', [{ name: 'a', ref: { current: shared } }])
    const offB = registerF6Regions('player', [{ name: 'b', ref: { current: shared } }])
    expect(ids()).toEqual(['player:a', 'player:b'])
    offA()
    offB()
  })

  it('is empty, and moves nothing, when no landmark or region exists', () =>
  {
    expect(f6Order()).toEqual([])
    expect(focusNextRegion('next')).toBeNull()
  })
})

describe('focusNextRegion', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  afterEach(() =>
  {
    cleanup()
    document.body.innerHTML = ''
  })

  it('walks forward through every stop and wraps to the rail', () =>
  {
    render(<Shell toasts={2}><BatchRegions /></Shell>)
    expect(focusNextRegion('next')?.id).toBe('rail')
    expect(focused()).toBe(screen.getByText('Batch'))
    expect(focusNextRegion()?.id).toBe('batch:header')
    expect(focused()).toBe(screen.getByText('Pause'))
    expect(focusNextRegion()?.id).toBe('batch:toolbar')
    expect(focused()).toBe(screen.getByText('Add files'))
    expect(focusNextRegion()?.id).toBe('batch:summary')
    const summary = screen.getByText('2 need attention').parentElement as HTMLElement
    expect(focused()).toBe(summary)
    expect(summary.getAttribute('tabindex')).toBe('-1')
    expect(focusNextRegion()?.id).toBe('batch:table')
    expect(focused()).toBe(screen.getByText('second'))
    expect(focusNextRegion()?.id).toBe('notifications')
    expect(focused()).toBe(screen.getByTestId('toast-1'))
    expect(focusNextRegion()?.id).toBe('rail')
  })

  it('walks backward and wraps from the rail to the last stop', () =>
  {
    render(<Shell toasts={1}><BatchRegions /></Shell>)
    expect(focusNextRegion('previous')?.id).toBe('notifications')
    expect(focusNextRegion('previous')?.id).toBe('batch:table')
    screen.getByText('Logs').focus()
    expect(focusNextRegion('previous')?.id).toBe('notifications')
    expect(focused()).toBe(screen.getByTestId('toast-0'))
  })

  it('returns to the element last focused in a stop', () =>
  {
    render(<Shell><BatchRegions /></Shell>)
    screen.getByText('Add folder').focus()
    expect(focusNextRegion('next')?.id).toBe('batch:summary')
    expect(focusNextRegion('previous')?.id).toBe('batch:toolbar')
    expect(focused()).toBe(screen.getByText('Add folder'))
  })

  it('moves by document position when focus sits outside every stop', () =>
  {
    render(<Shell><BatchRegions /></Shell>)
    screen.getByText('Loose').focus()
    expect(focusNextRegion('next')?.id).toBe('batch:summary')
    screen.getByText('Loose').focus()
    expect(focusNextRegion('previous')?.id).toBe('batch:toolbar')
    expect(focused()).toBe(screen.getByText('Add files'))
  })

  it('wraps when focus sits before or after every stop', () =>
  {
    render(<Shell><BatchRegions /></Shell>)
    const before = document.createElement('button')
    document.body.prepend(before)
    const after = document.createElement('button')
    document.body.append(after)
    before.focus()
    expect(focusNextRegion('next')?.id).toBe('rail')
    before.focus()
    expect(focusNextRegion('previous')?.id).toBe('batch:table')
    after.focus()
    expect(focusNextRegion('next')?.id).toBe('rail')
    after.focus()
    expect(focusNextRegion('previous')?.id).toBe('batch:table')
  })

  it('enters a view that registers none at its first visible control', () =>
  {
    useAppStore.setState({ currentView: 'dashboard' })
    render(
      <Shell>
        <div style={{ display: 'none' }}><button>Hidden view</button></div>
        <div><button>Visible view</button></div>
      </Shell>
    )
    expect(focusNextRegion('next')?.id).toBe('rail')
    expect(focusNextRegion('next')?.id).toBe('work')
    expect(focused()).toBe(screen.getByText('Visible view'))
  })

  it('focuses a stop with nothing focusable inside, keeping its own tabindex', () =>
  {
    useAppStore.setState({ currentView: 'logs' })
    const region = element('<section tabindex="0"><p>Quiet</p></section>')
    const off = registerF6Regions('logs', [{ name: 'quiet', ref: { current: region } }])
    expect(focusNextRegion('next')?.id).toBe('logs:quiet')
    expect(focused()).toBe(region)
    expect(region.getAttribute('tabindex')).toBe('0')
    off()
  })

  it('treats focus in a nested region as being in the innermost one', () =>
  {
    useAppStore.setState({ currentView: 'logs' })
    const outer = element('<section><button>Outer</button><div><button>Inner</button></div></section>')
    const inner = outer.querySelector('div') as HTMLElement
    const last = element('<section><button>Last</button></section>')
    const off = registerF6Regions('logs', [
      { name: 'outer', ref: { current: outer } },
      { name: 'inner', ref: { current: inner } },
      { name: 'last', ref: { current: last } }
    ])
    ;(inner.querySelector('button') as HTMLElement).focus()
    expect(focusNextRegion('next')?.id).toBe('logs:last')
    off()
  })
})

describe('shell stops', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  afterEach(() =>
  {
    cleanup()
    document.body.innerHTML = ''
  })

  it('a registered element replaces its landmark and can choose how it is entered', () =>
  {
    render(<Shell />)
    const rail = element('<aside><button>Home</button></aside>')
    const focus = vi.fn()
    const off = registerShellStop('rail', rail, { focus })
    expect(f6Order()[0].element).toBe(rail)
    expect(focusNextRegion('next')?.id).toBe('rail')
    expect(focus).toHaveBeenCalledWith(rail)
    off()
    expect(f6Order()[0].element.tagName).toBe('NAV')
  })

  it('a stale removal leaves a newer registration in place', () =>
  {
    const first = element('<aside></aside>')
    const second = element('<aside></aside>')
    const offFirst = registerShellStop('work', first)
    const offSecond = registerShellStop('work', second)
    offFirst()
    expect(f6Order()[0].element).toBe(second)
    offSecond()
    expect(f6Order()).toEqual([])
  })

  it('skips a hidden registered stop instead of falling back to its landmark', () =>
  {
    render(<Shell />)
    const off = registerShellStop('rail', element('<aside hidden></aside>'))
    expect(ids()).toEqual(['work'])
    off()
  })

  it('lets the notifications stop report its own emptiness', () =>
  {
    const region = element('<div role="region" aria-label="Notices"></div>')
    const off = registerShellStop('notifications', region, () => ({ isEmpty: () => false }))
    expect(ids()).toEqual(['notifications'])
    expect(focusNextRegion('next')?.id).toBe('notifications')
    expect(focused()).toBe(region)
    off()
  })

  it('useShellStop registers from a ref and reads the latest options', () =>
  {
    function Notices({ focus }: { focus: NonNullable<ShellStopOptions['focus']> }): React.JSX.Element
    {
      const ref = useRef<HTMLDivElement>(null)
      useShellStop('notifications', ref, { focus, isEmpty: () => false })
      return <div ref={ref} />
    }
    const early = vi.fn()
    const late = vi.fn()
    const { rerender, unmount } = render(<Notices focus={early} />)
    rerender(<Notices focus={late} />)
    expect(ids()).toEqual(['notifications'])
    focusNextRegion('next')
    expect(early).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledTimes(1)
    unmount()
    expect(ids()).toEqual([])
  })

  it('useShellStop registers nothing while its ref is empty', () =>
  {
    function Absent(): React.JSX.Element
    {
      const ref = useRef<HTMLDivElement>(null)
      useShellStop('rail', ref)
      return <span />
    }
    render(<Absent />)
    expect(f6Order()).toEqual([])
  })
})

describe('f6ReturnTarget', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  afterEach(() =>
  {
    cleanup()
    document.body.innerHTML = ''
  })

  it('remembers where a run of F6 presses began', () =>
  {
    const { unmount } = render(<Shell toasts={1}><BatchRegions /></Shell>)
    focusNextRegion('next')
    expect(f6ReturnTarget()).toBeNull()
    const origin = screen.getByText('Add folder')
    origin.focus()
    focusNextRegion('next')
    focusNextRegion('next')
    expect(focused()).toBe(screen.getByText('second'))
    expect(f6ReturnTarget()).toBe(origin)
    screen.getByText('Pause').focus()
    focusNextRegion('next')
    expect(f6ReturnTarget()).toBe(screen.getByText('Pause'))
    unmount()
    expect(f6ReturnTarget()).toBeNull()
  })
})

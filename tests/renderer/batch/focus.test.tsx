import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canFocus,
  focusChain,
  focusFirst,
  focusIsLost,
  isShown,
  moveFocus,
  nearestRemaining,
  regionOf,
  rescueChain,
  useFocusOnShow,
  useFocusRescue,
  type FocusMoment,
  type FocusTargets
} from '../../../src/renderer/src/components/batch/page/focus'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'

function byId(id: string): () => HTMLElement | null
{
  return () => document.getElementById(id)
}

function targets(over: Partial<FocusTargets> = {}): FocusTargets
{
  return {
    row: (id) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`),
    focusedRow: byId('focused-row'),
    table: byId('grid'),
    actionSlot: byId('slot'),
    runControls: byId('controls'),
    summaryHeading: byId('summary-heading'),
    inspectorField: byId('field'),
    inspectorTabs: byId('tabs'),
    addFiles: byId('add-files'),
    acknowledgment: byId('ack'),
    view: byId('view'),
    ...over
  }
}

/** A Batch view skeleton with every focus destination present. */
function Page({ children }: { children?: React.ReactNode }): React.JSX.Element
{
  return (
    <section id="view" tabIndex={-1}>
      <div data-region="header">
        <button id="slot">Start 21 jobs</button>
        <div id="controls" tabIndex={-1}><button>Pause</button></div>
      </div>
      <div data-region="summary">
        <h2 id="summary-heading" tabIndex={-1}>Review</h2>
        <input id="ack" type="checkbox" aria-label="Confirm" />
      </div>
      <div data-region="table">
        <div id="grid" role="grid" tabIndex={-1}>
          <div role="row" data-row-id="a" tabIndex={-1}>a</div>
          <div role="row" data-row-id="b" id="focused-row" tabIndex={-1}>b</div>
          <div role="row" data-row-id="c" tabIndex={-1}>c</div>
        </div>
      </div>
      <aside data-region="inspector">
        <div id="tabs" role="tablist" tabIndex={-1}>tabs</div>
        <input id="field" aria-label="Target, integrated" />
      </aside>
      <button id="add-files">Add files</button>
      {children}
    </section>
  )
}

afterEach(() =>
{
  cleanup()
  document.body.innerHTML = ''
})

describe('visibility', () =>
{
  it('reads hidden, inert, display none, and detached elements as not shown', () =>
  {
    render(
      <div>
        <div hidden><button id="in-hidden">x</button></div>
        <div inert><button id="in-inert">x</button></div>
        <div style={{ display: 'none' }}><button id="in-none">x</button></div>
        <div style={{ visibility: 'hidden' }}><button id="in-invisible">x</button></div>
        <button id="shown">x</button>
        <button id="off" disabled>x</button>
        <button id="aria-off" aria-disabled="true">x</button>
      </div>
    )
    expect(isShown(document.getElementById('in-hidden'))).toBe(false)
    expect(isShown(document.getElementById('in-inert'))).toBe(false)
    expect(isShown(document.getElementById('in-none'))).toBe(false)
    expect(isShown(document.getElementById('in-invisible'))).toBe(false)
    expect(isShown(document.getElementById('shown'))).toBe(true)
    expect(isShown(null)).toBe(false)
    expect(isShown(undefined)).toBe(false)
    expect(isShown(document.createElement('button'))).toBe(false)
    expect(canFocus(document.getElementById('shown'))).toBe(true)
    expect(canFocus(document.getElementById('off'))).toBe(false)
    expect(canFocus(document.getElementById('aria-off'))).toBe(false)
  })

  it('reads the body and nothing as lost focus', () =>
  {
    render(<button id="b">b</button>)
    document.body.focus()
    expect(focusIsLost()).toBe(true)
    document.getElementById('b')?.focus()
    expect(focusIsLost()).toBe(false)
  })

  it('reads the region from the nearest data-region ancestor', () =>
  {
    render(<Page />)
    expect(regionOf(document.getElementById('slot'))).toBe('header')
    expect(regionOf(document.getElementById('add-files'))).toBeNull()
    expect(regionOf(null)).toBeNull()
  })
})

describe('nearestRemaining', () =>
{
  const order = ['a', 'b', 'c', 'd']

  it('keeps a focused row that stays', () =>
  {
    expect(nearestRemaining(order, ['c'], 'a')).toBe('a')
  })

  it('moves to the next row after the focused one', () =>
  {
    expect(nearestRemaining(order, ['b', 'c'], 'b')).toBe('d')
  })

  it('moves to the previous row at the end', () =>
  {
    expect(nearestRemaining(order, ['c', 'd'], 'd')).toBe('b')
  })

  it('anchors on the first removed row when the focused row is unknown', () =>
  {
    expect(nearestRemaining(order, ['b'], null)).toBe('c')
    expect(nearestRemaining(order, ['b'], 'zz')).toBe('c')
  })

  it('falls back to the first remaining row when nothing anchors', () =>
  {
    expect(nearestRemaining(order, ['zz'], null)).toBe('a')
  })

  it('is null when no row remains', () =>
  {
    expect(nearestRemaining(order, order, 'b')).toBeNull()
    expect(nearestRemaining([], [], null)).toBeNull()
  })
})

describe('focus destinations', () =>
{
  beforeEach(() =>
  {
    render(<Page />)
  })

  const cases: Array<[string, FocusMoment, string]> = [
    ['opening the view lands on the last focused row', { kind: 'open-view', lastRow: 'c', queueEmpty: false }, 'c'],
    ['opening an empty queue lands on Add files', { kind: 'open-view', lastRow: null, queueEmpty: true }, 'add-files'],
    ['an add lands on the first created job', { kind: 'added', firstId: 'a' }, 'a'],
    ['the first rows arriving land on the first row', { kind: 'rows-arrived', firstId: 'a' }, 'a'],
    ['Delete lands on the next row', { kind: 'removed', order: ['a', 'b', 'c'], removed: ['b'], focused: 'b' }, 'c'],
    ['Delete at the end lands on the previous row', { kind: 'removed', order: ['a', 'b', 'c'], removed: ['c'], focused: 'c' }, 'b'],
    ['Enter on a row lands on the inspector field', { kind: 'inspector-field' }, 'field'],
    ['Escape in the inspector lands on its row', { kind: 'row', id: 'a' }, 'a'],
    ['a gated start lands on the acknowledgment', { kind: 'acknowledgment' }, 'ack'],
    ['pause and resume land on the action slot', { kind: 'action-slot' }, 'slot'],
    ['acknowledging in the inspector lands on the next job', { kind: 'acknowledged-inspector', nextId: 'c' }, 'c'],
    ['acknowledging the last job lands on the tab list', { kind: 'acknowledged-inspector', nextId: null }, 'tabs'],
    ['acknowledge all lands on the summary heading', { kind: 'summary-heading' }, 'summary-heading'],
    ['an emptied group with no next group lands on the summary heading', { kind: 'group-emptied', nextButton: null }, 'summary-heading']
  ]

  it.each(cases)('%s', (_name, moment, expected) =>
  {
    const element = moveFocus(moment, targets())
    expect(element).not.toBeNull()
    const active = document.activeElement as HTMLElement
    expect(active.id === expected || active.dataset.rowId === expected).toBe(true)
  })

  it('returns a closed confirmation to its opener, then the action slot, then the row', () =>
  {
    const opener = document.getElementById('add-files')
    moveFocus({ kind: 'confirm-closed', opener }, targets())
    expect(document.activeElement).toBe(opener)
    opener?.remove()
    moveFocus({ kind: 'confirm-closed', opener }, targets())
    expect(document.activeElement?.id).toBe('slot')
    document.getElementById('slot')?.remove()
    moveFocus({ kind: 'confirm-closed', opener }, targets())
    expect(document.activeElement?.id).toBe('controls')
    document.getElementById('controls')?.remove()
    moveFocus({ kind: 'confirm-closed', opener }, targets())
    expect(document.activeElement?.id).toBe('focused-row')
  })

  it('returns a closed popover to its trigger and an emptied group to the next button', () =>
  {
    const trigger = document.getElementById('slot')
    moveFocus({ kind: 'trigger', trigger }, targets())
    expect(document.activeElement).toBe(trigger)
    const next = document.getElementById('add-files')
    moveFocus({ kind: 'group-emptied', nextButton: next }, targets())
    expect(document.activeElement).toBe(next)
  })

  it('keeps focus where it is for a moment that stays', () =>
  {
    document.getElementById('field')?.focus()
    moveFocus({ kind: 'stay' }, targets())
    expect(document.activeElement?.id).toBe('field')
    document.getElementById('field')?.blur()
    moveFocus({ kind: 'stay' }, targets())
    expect(document.activeElement?.id).toBe('focused-row')
  })

  it('falls back to the table and then the view, never the body', () =>
  {
    document.getElementById('focused-row')?.remove()
    moveFocus({ kind: 'row', id: 'missing' }, targets())
    expect(document.activeElement?.id).toBe('grid')
    document.getElementById('grid')?.remove()
    moveFocus({ kind: 'added', firstId: null }, targets())
    expect(document.activeElement?.id).toBe('view')
  })

  it('reaches Add files last when an open view has no rows', () =>
  {
    document.getElementById('grid')?.remove()
    const chain = focusChain({ kind: 'open-view', lastRow: null, queueEmpty: false }, targets({ view: () => null }))
    expect(focusFirst(chain)?.id).toBe('add-files')
  })

  it('returns null when no destination can take focus', () =>
  {
    const none = targets({ focusedRow: () => null, table: () => null, view: () => null })
    expect(moveFocus({ kind: 'row', id: null }, none)).toBeNull()
  })

  it('skips an element that refuses focus', () =>
  {
    const plain = document.createElement('div')
    document.body.append(plain)
    expect(focusFirst([plain, byId('slot')])?.id).toBe('slot')
  })

  it('falls back for an unknown moment', () =>
  {
    const chain = focusChain({ kind: 'unknown' } as unknown as FocusMoment, targets())
    expect(focusFirst(chain)?.id).toBe('focused-row')
  })
})

describe('rescueChain', () =>
{
  it('names a destination per region', () =>
  {
    render(<Page />)
    expect(focusFirst(rescueChain('header', targets()))?.id).toBe('slot')
    expect(focusFirst(rescueChain('summary', targets()))?.id).toBe('summary-heading')
    expect(focusFirst(rescueChain('inspector', targets()))?.id).toBe('tabs')
    expect(focusFirst(rescueChain('table', targets()))?.id).toBe('focused-row')
    expect(focusFirst(rescueChain(null, targets()))?.id).toBe('focused-row')
  })
})

/** A page whose controls remove themselves when pressed. */
function RescuePage({ hidden = false }: { hidden?: boolean }): React.JSX.Element
{
  const rootRef = useRef<HTMLDivElement>(null)
  const [gone, setGone] = useState<string[]>([])
  useFocusRescue(rootRef, targets())
  const remover = (id: string, label: string): React.ReactNode =>
    gone.includes(id) ? null : <button id={id} onClick={() => setGone((list) => [...list, id])}>{label}</button>
  return (
    <div ref={rootRef} style={hidden ? { display: 'none' } : undefined}>
      <Page>
        <div data-region="header">{remover('review', 'Review 21 jobs')}</div>
        <div data-region="summary">{remover('fix', 'Use AAC audio')}</div>
        <div data-region="table">{remover('ack-row', 'Acknowledge')}</div>
        <div data-region="inspector">{remover('keep', 'Keep output')}</div>
      </Page>
    </div>
  )
}

async function pressAndRemove(id: string): Promise<void>
{
  const button = document.getElementById(id) as HTMLElement
  button.focus()
  await act(async () =>
  {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

describe('useFocusRescue', () =>
{
  it('sends focus from a removed header control to the action slot', async () =>
  {
    render(<RescuePage />)
    await pressAndRemove('review')
    expect(document.activeElement?.id).toBe('slot')
  })

  it('sends focus from a removed summary control to the summary heading', async () =>
  {
    render(<RescuePage />)
    await pressAndRemove('fix')
    expect(document.activeElement?.id).toBe('summary-heading')
  })

  it('sends focus from a removed row control to the focused row', async () =>
  {
    render(<RescuePage />)
    await pressAndRemove('ack-row')
    expect(document.activeElement?.id).toBe('focused-row')
  })

  it('sends focus from a removed inspector control to the tab list', async () =>
  {
    render(<RescuePage />)
    await pressAndRemove('keep')
    expect(document.activeElement?.id).toBe('tabs')
  })

  it('rescues a control that is disabled while focused', async () =>
  {
    render(<RescuePage />)
    const slot = document.getElementById('slot') as HTMLButtonElement
    slot.focus()
    await act(async () =>
    {
      slot.blur()
      slot.disabled = true
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.activeElement?.id).toBe('controls')
  })

  it('rescues a control that is hidden while focused', async () =>
  {
    render(<RescuePage />)
    const fix = document.getElementById('fix') as HTMLButtonElement
    fix.focus()
    await act(async () =>
    {
      // A browser drops focus from a control it stops rendering; jsdom ignores blur() on one, so blur first.
      fix.blur()
      fix.hidden = true
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.activeElement?.id).toBe('summary-heading')
  })

  it('leaves a deliberate blur alone', async () =>
  {
    render(<RescuePage />)
    const fix = document.getElementById('fix') as HTMLElement
    fix.focus()
    await act(async () =>
    {
      fix.blur()
      await Promise.resolve()
    })
    expect(focusIsLost()).toBe(true)
    await act(async () =>
    {
      fix.remove()
      await Promise.resolve()
    })
    expect(focusIsLost()).toBe(true)
  })

  it('forgets a control once focus leaves the view', async () =>
  {
    const outside = document.createElement('button')
    document.body.append(outside)
    render(<RescuePage />)
    const fix = document.getElementById('fix') as HTMLElement
    fix.focus()
    outside.focus()
    await act(async () =>
    {
      outside.blur()
      fix.remove()
      await Promise.resolve()
    })
    expect(focusIsLost()).toBe(true)
  })

  it('never moves focus inside a hidden view', async () =>
  {
    render(<RescuePage hidden />)
    await pressAndRemove('review')
    expect(focusIsLost()).toBe(true)
  })

  it('takes a custom chain', async () =>
  {
    function Custom(): React.JSX.Element
    {
      const rootRef = useRef<HTMLDivElement>(null)
      const [shown, setShown] = useState(true)
      useFocusRescue(rootRef, targets(), () => [byId('add-files')])
      return (
        <div ref={rootRef}>
          <Page>{shown && <button id="once" onClick={() => setShown(false)}>Once</button>}</Page>
        </div>
      )
    }
    render(<Custom />)
    await pressAndRemove('once')
    expect(document.activeElement?.id).toBe('add-files')
  })
})

describe('useFocusOnShow', () =>
{
  function Shown({ lastRow }: { lastRow: string | null }): React.JSX.Element
  {
    const rootRef = useRef<HTMLDivElement>(null)
    useFocusOnShow('batch', rootRef, () => ({ kind: 'open-view', lastRow, queueEmpty: false }), targets())
    return <div ref={rootRef}><Page /></div>
  }

  async function show(view: 'batch' | 'dashboard'): Promise<void>
  {
    await act(async () =>
    {
      useAppStore.setState({ currentView: view })
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
  }

  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'dashboard' })
  })

  it('focuses the last focused row when the shell shows the view', async () =>
  {
    render(<Shown lastRow="c" />)
    await show('batch')
    expect((document.activeElement as HTMLElement).dataset.rowId).toBe('c')
  })

  it('leaves focus that already sits inside the view', async () =>
  {
    render(<Shown lastRow="c" />)
    document.getElementById('field')?.focus()
    await show('batch')
    expect(document.activeElement?.id).toBe('field')
  })

  it('ignores other views and repeated updates', async () =>
  {
    render(<Shown lastRow="c" />)
    await show('dashboard')
    expect(focusIsLost()).toBe(true)
    await show('batch')
    screen.getByText('Add files').focus()
    await show('batch')
    expect(document.activeElement?.id).toBe('add-files')
  })
})

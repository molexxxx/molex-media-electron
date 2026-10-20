/**
 * Tabs: a named tablist of native buttons that control one tabpanel labeled by the selected tab. Covers
 * Left and Right with wrap, Home and End, automatic and manual activation, disabled tabs that stay
 * focusable but never activate, counts, and the panel's own Tab stop while it holds nothing focusable.
 */
import React, { useState, type ReactElement, type ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { TabPanel, Tabs, tabId, tabPanelId, type TabItem, type TabsProps } from '../../../src/renderer/src/ui/Tabs'

type Mode = 'queue' | 'review' | 'run' | 'history'

const MODES: ReadonlyArray<TabItem<Mode>> = [
  { value: 'queue', label: 'Queue', count: 38 },
  { value: 'review', label: 'Review' },
  { value: 'run', label: 'Run', disabled: true, disabledReason: 'Start a batch to follow its run.' },
  { value: 'history', label: 'History', icon: 'nav.history' }
]

function Modes(props: Partial<TabsProps<Mode>> & { initial?: Mode, panel?: ReactNode }): ReactElement
{
  const { initial = 'queue', panel = <button type="button">Add files</button>, ...rest } = props
  const [value, setValue] = useState<Mode>(initial)
  return (
    <Tabs
      id="mode"
      label="Batch view"
      value={value}
      tabs={MODES}
      {...rest}
      onChange={(next) =>
      {
        rest.onChange?.(next)
        setValue(next)
      }}
    >
      {panel}
    </Tabs>
  )
}

function tab(name: RegExp | string): HTMLButtonElement
{
  return screen.getByRole('tab', { name }) as HTMLButtonElement
}

describe('Tabs', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('wires the tablist, tabs, and tabpanel to one another', () =>
  {
    render(<Modes />)
    const list = screen.getByRole('tablist', { name: 'Batch view' })
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    const panel = screen.getByRole('tabpanel')
    for (const element of tabs)
    {
      expect(element.parentElement).toBe(list)
      expect(element.tagName).toBe('BUTTON')
      expect(element).toHaveAttribute('type', 'button')
      expect(element).toHaveAttribute('aria-controls', panel.id)
    }
    const queue = tab(/^Queue/)
    expect(queue).toHaveAttribute('aria-selected', 'true')
    expect(tab('Review')).toHaveAttribute('aria-selected', 'false')
    expect(panel).toHaveAttribute('aria-labelledby', queue.id)
    expect(panel).toHaveAccessibleName('Queue, 38')
    expect(panel.id).toBe(tabPanelId('mode'))
    expect(queue.id).toBe(tabId('mode', 'queue'))
  })

  it('gives the selected tab the only Tab stop', () =>
  {
    render(<Modes initial="review" />)
    expect(screen.getAllByRole('tab').filter((element) => element.tabIndex === 0)).toEqual([tab('Review')])
  })

  it('moves with Right and Left, wrapping, and activates on focus by default', () =>
  {
    const onChange = vi.fn()
    render(<Modes initial="review" onChange={onChange} />)
    fireEvent.keyDown(tab('Review'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab(/^Queue/))
    expect(onChange).toHaveBeenLastCalledWith('queue')
    fireEvent.keyDown(tab(/^Queue/), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('History'))
    expect(onChange).toHaveBeenLastCalledWith('history')
    fireEvent.keyDown(tab('History'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab(/^Queue/))
    expect(onChange).toHaveBeenLastCalledWith('queue')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tab(/^Queue/).id)
  })

  it('reaches the ends with Home and End', () =>
  {
    const onChange = vi.fn()
    render(<Modes initial="review" onChange={onChange} />)
    fireEvent.keyDown(tab('Review'), { key: 'End' })
    expect(document.activeElement).toBe(tab('History'))
    expect(onChange).toHaveBeenLastCalledWith('history')
    fireEvent.keyDown(tab('History'), { key: 'Home' })
    expect(document.activeElement).toBe(tab(/^Queue/))
    expect(onChange).toHaveBeenLastCalledWith('queue')
  })

  it('keeps a disabled tab focusable by the arrows but never activates it', () =>
  {
    const onChange = vi.fn()
    render(<Modes initial="review" onChange={onChange} />)
    const run = tab('Run')
    expect(run).toHaveAttribute('aria-disabled', 'true')
    expect(run).not.toBeDisabled()
    fireEvent.keyDown(tab('Review'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(run)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(run)
    fireEvent.keyDown(run, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(tab('Review')).toHaveAttribute('aria-selected', 'true')
    expect(run).toHaveAccessibleDescription('Start a batch to follow its run.')
    expect(run).toHaveClass('text-ink-disabled')
  })

  it('in manual mode moves focus only, and activates with Enter or Space', () =>
  {
    const onChange = vi.fn()
    render(<Modes activation="manual" onChange={onChange} />)
    fireEvent.keyDown(tab(/^Queue/), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('Review'))
    expect(onChange).not.toHaveBeenCalled()
    expect(tab(/^Queue/)).toHaveAttribute('aria-selected', 'true')
    expect(fireEvent.keyDown(tab('Review'), { key: 'Enter' })).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith('review')
    expect(tab('Review')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Review'), { key: 'End' })
    expect(document.activeElement).toBe(tab('History'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(fireEvent.keyDown(tab('History'), { key: ' ' })).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith('history')
  })

  it('activates a tab on click, and not the selected one again', () =>
  {
    const onChange = vi.fn()
    render(<Modes onChange={onChange} />)
    fireEvent.click(tab(/^Queue/))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(tab('History'))
    expect(onChange).toHaveBeenCalledWith('history')
  })

  it('leaves modified and other keys to the page', () =>
  {
    const onChange = vi.fn()
    render(<Modes onChange={onChange} />)
    for (const init of [{ key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', shiftKey: true }, { key: 'ArrowDown' }, { key: 'a' }])
    {
      expect(fireEvent.keyDown(tab(/^Queue/), init)).toBe(true)
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(tab('Review'))
  })

  it('renders a count after the label and an icon before it', () =>
  {
    render(<Modes />)
    const queue = tab('Queue, 38')
    expect(queue.lastElementChild).toHaveTextContent('38')
    expect(queue.lastElementChild).toHaveClass('tabular-nums', 'text-ink-3')
    expect(tab('History').querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws the selected tab with the amber underline and the others in quiet ink', () =>
  {
    render(<Modes />)
    expect(tab(/^Queue/)).toHaveClass('text-ink', 'shadow-[inset_0_-2px_0_var(--color-accent-ink)]', 'h-(--size-control-md)', 'px-3')
    expect(tab('Review')).toHaveClass('text-ink-3', 'hover:bg-wash-hover')
  })

  it('makes the panel a Tab stop only while nothing inside it can take focus', async () =>
  {
    function Switching(): ReactElement
    {
      const [busy, setBusy] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setBusy(false)}>Finish</button>
          <Modes panel={busy ? <p>Scanning the folder</p> : <button type="button">Review 38 jobs</button>} />
        </>
      )
    }
    render(<Switching />)
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('tabindex', '0')
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(panel).not.toHaveAttribute('tabindex'))
  })

  it('updates the panel Tab stop when focusable content changes inside a child', async () =>
  {
    let reveal: (() => void) | undefined
    function Content(): ReactElement
    {
      const [shown, setShown] = useState(false)
      reveal = () => setShown(true)
      return shown ? <a href="#log">Show log</a> : <span>Nothing to show</span>
    }
    render(
      <>
        <Tabs id="inspector" label="Inspector" value="recipe" onChange={() => {}} tabs={[{ value: 'recipe', label: 'Recipe' }]} />
        <TabPanel tabsId="inspector" value="recipe" className="p-3">
          <Content />
        </TabPanel>
      </>
    )
    const panel = screen.getByRole('tabpanel', { name: 'Recipe' })
    expect(panel).toHaveClass('p-3')
    expect(panel).toHaveAttribute('tabindex', '0')
    act(() =>
    {
      reveal?.()
    })
    await waitFor(() => expect(panel).not.toHaveAttribute('tabindex'))
  })

  it('omits the panel without children and falls back to an id of its own', () =>
  {
    render(<Tabs label="Inspector" value="plan" onChange={() => {}} tabs={[{ value: 'plan', label: 'Plan' }, { value: 'result', label: 'Result' }]} className="gap-1" />)
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getByRole('tablist')).toHaveClass('gap-1')
    const plan = tab('Plan')
    expect(plan.id).toMatch(/-tab-plan$/)
    expect(plan.getAttribute('aria-controls')).toMatch(/-panel$/)
  })

  it('keeps the first tab tabbable when the value matches no tab, and makes ids safe', () =>
  {
    render(<Tabs id="t" label="Views" value="none" onChange={() => {}} tabs={[{ value: 'a b', label: 'First' }, { value: 'c', label: 'Second', disabled: true, count: 2 }]} />)
    expect(tab('First').tabIndex).toBe(0)
    expect(tab('First').id).toBe('t-tab-a_b')
    expect(tab('Second, 2').tabIndex).toBe(-1)
    expect(tab('Second, 2').lastElementChild).toHaveClass('text-ink-disabled')
    expect(tab('Second, 2')).not.toHaveAttribute('aria-describedby')
  })
})

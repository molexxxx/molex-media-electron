/**
 * SplitButton: the main part and the chevron as two buttons with one Tab stop each, the chevron's name and
 * menu wiring, the main part's loading and unavailable states as on a Button, and the chevron that never
 * turns primary beside a disabled main part.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SplitButton, type SplitButtonProps } from '../../../src/renderer/src/ui/SplitButton'

function setup(props: Partial<SplitButtonProps> = {}): { main: HTMLElement, chevron: HTMLElement, onSelect: ReturnType<typeof vi.fn> }
{
  const onSelect = vi.fn()
  render(
    <SplitButton
      variant="primary"
      actionName="start"
      items={[{ id: 'selected', label: 'Start only the 8 selected jobs', onSelect }]}
      {...props}
    >
      {props.children ?? 'Start 38 jobs'}
    </SplitButton>
  )
  return {
    main: screen.getByRole('button', { name: /Start 38 jobs|Starting/ }),
    chevron: screen.getByRole('button', { name: 'More start options' }),
    onSelect
  }
}

describe('SplitButton', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('renders two sibling buttons that are one Tab stop each', () =>
  {
    const { main, chevron } = setup()
    expect(screen.getAllByRole('button')).toEqual([main, chevron])
    expect(main.tabIndex).toBe(0)
    expect(chevron.tabIndex).toBe(0)
    expect(main.contains(chevron)).toBe(false)
    expect(main.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(main).toHaveAttribute('data-variant', 'primary')
    expect(main).toHaveAttribute('data-size', 'md')
    expect(chevron).toHaveAttribute('data-size', 'md')
  })

  it('names the chevron after the action and marks it as a menu button', () =>
  {
    const { chevron } = setup()
    expect(chevron).toHaveAccessibleName('More start options')
    expect(chevron).toHaveAttribute('aria-haspopup', 'menu')
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
    expect(chevron).toHaveAttribute('data-variant', 'primary')
    expect(document.getElementById(chevron.getAttribute('aria-controls') as string)).toHaveAttribute('role', 'menu')
  })

  it('opens the related actions from the chevron and runs the chosen one', () =>
  {
    const onMenuOpenChange = vi.fn()
    const { chevron, onSelect } = setup({ onMenuOpenChange })
    fireEvent.click(chevron)
    expect(chevron).toHaveAttribute('aria-expanded', 'true')
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true)
    const menu = screen.getByRole('menu', { hidden: true })
    expect(menu).toHaveAttribute('aria-label', 'More start options')
    const item = screen.getByRole('menuitem', { hidden: true, name: 'Start only the 8 selected jobs' })
    expect(menu.contains(item)).toBe(true)
    expect(document.activeElement).toBe(item)
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false)
    expect(document.activeElement).toBe(chevron)
  })

  it('opens the menu from the keyboard on its first item', () =>
  {
    const { chevron } = setup({
      items: [
        { id: 'selected', label: 'Start only the 8 selected jobs', onSelect: () => undefined },
        { id: 'later', label: 'Start when the drive is free', onSelect: () => undefined }
      ]
    })
    chevron.focus()
    fireEvent.keyDown(chevron, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { hidden: true, name: 'Start only the 8 selected jobs' }))
  })

  it('runs the main action on click without opening the menu', () =>
  {
    const onClick = vi.fn()
    const { main, chevron } = setup({ onClick })
    fireEvent.click(main)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the loading behavior of a Button on the main part', () =>
  {
    const onClick = vi.fn()
    const { main, chevron } = setup({ onClick, loading: true, loadingLabel: 'Starting' })
    expect(main).toHaveAttribute('aria-busy', 'true')
    expect(main).toHaveAccessibleName('Starting')
    fireEvent.click(main)
    expect(onClick).not.toHaveBeenCalled()
    expect(chevron).toHaveAttribute('data-variant', 'primary')
  })

  it('keeps the unavailable behavior of a Button on the main part', () =>
  {
    const onClick = vi.fn()
    const { main, chevron } = setup({ onClick, unavailableReason: 'Add files to the queue first' })
    expect(main).not.toBeDisabled()
    expect(main).toHaveAttribute('aria-disabled', 'true')
    main.focus()
    expect(document.activeElement).toBe(main)
    fireEvent.click(main)
    expect(onClick).not.toHaveBeenCalled()
    expect(main).toHaveAccessibleDescription('Add files to the queue first')
    expect(chevron).toHaveAttribute('data-variant', 'secondary')
    expect(chevron).not.toBeDisabled()
  })

  it('never draws the chevron primary beside a disabled main part', () =>
  {
    const { main, chevron } = setup({ disabled: true })
    expect(main).toBeDisabled()
    expect(chevron).toHaveAttribute('data-variant', 'secondary')
    fireEvent.click(chevron)
    expect(chevron).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps a non-primary variant on the chevron when the main part is disabled', () =>
  {
    const { chevron } = setup({ variant: 'danger', disabled: true })
    expect(chevron).toHaveAttribute('data-variant', 'danger')
  })

  it('defaults both parts to the secondary variant', () =>
  {
    const { main, chevron } = setup({ variant: undefined })
    expect(main).toHaveAttribute('data-variant', 'secondary')
    expect(chevron).toHaveAttribute('data-variant', 'secondary')
  })

  it('disables only the chevron with menuDisabled', () =>
  {
    const { main, chevron } = setup({ menuDisabled: true })
    expect(chevron).toBeDisabled()
    expect(main).not.toBeDisabled()
  })

  it('sizes both parts together and keeps the caller classes on the main part', () =>
  {
    const { main, chevron } = setup({ size: 'sm', className: 'min-w-24' })
    expect(main).toHaveAttribute('data-size', 'sm')
    expect(chevron).toHaveAttribute('data-size', 'sm')
    expect(main).toHaveClass('min-w-24', 'rounded-e-none')
    expect(chevron).toHaveClass('rounded-s-none')
  })
})

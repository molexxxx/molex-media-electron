/**
 * VisuallyHidden and CapsText: text that only assistive technology reads, never selectable so copies do
 * not double, and uppercase captions whose accessible name stays sentence case.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { VisuallyHidden } from '../../../src/renderer/src/ui/VisuallyHidden'
import { CapsText } from '../../../src/renderer/src/ui/CapsText'

function classesOf(element: Element): string[]
{
  return element.className.split(/\s+/).filter(Boolean)
}

describe('VisuallyHidden', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('clips its text to the screen-reader-only box and keeps it out of text selection', () =>
  {
    render(<VisuallyHidden>, not acknowledged</VisuallyHidden>)
    const hidden = screen.getByText(', not acknowledged')
    expect(hidden.tagName).toBe('SPAN')
    expect(classesOf(hidden)).toEqual(expect.arrayContaining(['sr-only', 'select-none']))
  })

  it('still names and describes controls', () =>
  {
    render(
      <>
        <button type="button" aria-describedby="hint">
          <VisuallyHidden>Acknowledge MM-0141</VisuallyHidden>
        </button>
        <VisuallyHidden id="hint">Clears the held warning</VisuallyHidden>
      </>
    )
    const button = screen.getByRole('button', { name: 'Acknowledge MM-0141' })
    expect(button).toHaveAccessibleDescription('Clears the held warning')
  })

  it('passes span attributes, a caller class, and its ref through', () =>
  {
    const ref = React.createRef<HTMLSpanElement>()
    render(<VisuallyHidden ref={ref} id="stage-state" className="whitespace-normal">current step</VisuallyHidden>)
    const hidden = screen.getByText('current step')
    expect(ref.current).toBe(hidden)
    expect(hidden).toHaveAttribute('id', 'stage-state')
    expect(classesOf(hidden)).toEqual(expect.arrayContaining(['sr-only', 'select-none', 'whitespace-normal']))
  })
})

describe('CapsText', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('names its control in sentence case while the visible copy is uppercase', () =>
  {
    render(
      <button type="button">
        <CapsText className="type-caption">Batch size</CapsText>
      </button>
    )
    expect(screen.getByRole('button', { name: 'Batch size' })).toBeInTheDocument()
  })

  it('hides the uppercase copy and keeps the hidden copy unselectable', () =>
  {
    const { container } = render(<CapsText className="type-caption">Integrated target</CapsText>)
    const [visual, hidden] = [...container.children]
    expect(container.children).toHaveLength(2)
    expect(visual).toHaveAttribute('aria-hidden', 'true')
    expect(visual).toHaveTextContent('Integrated target')
    expect(classesOf(visual)).toEqual(expect.arrayContaining(['uppercase', 'type-caption']))
    expect(hidden).not.toHaveAttribute('aria-hidden')
    expect(hidden).toHaveTextContent('Integrated target')
    expect(classesOf(hidden)).toEqual(expect.arrayContaining(['sr-only', 'select-none']))
  })

  it('uppercases on its own when no class is passed', () =>
  {
    const { container } = render(<CapsText>Verified</CapsText>)
    expect(classesOf(container.children[0])).toEqual(['uppercase'])
  })
})

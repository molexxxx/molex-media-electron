/**
 * CatalogNumber: a job's number as a quiet tabular figure without its prefix or leading zeros; assistive
 * technology and copying read the full id; selection lifts the ink one step; the display size reads larger.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CatalogNumber, jobNumber } from '../../../src/renderer/src/ui/CatalogNumber'

function classesOf(element: Element): string[]
{
  return element.className.split(/\s+/).filter(Boolean)
}

function visible(container: HTMLElement): HTMLElement
{
  return container.querySelector('[aria-hidden="true"]') as HTMLElement
}

describe('CatalogNumber', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('shows the digits without the prefix or leading zeros', () =>
  {
    const { container } = render(<CatalogNumber value="MM-0141" />)
    expect(visible(container)).toHaveTextContent(/^141$/)
    expect(screen.getByText('MM-0141')).toBeInTheDocument()
  })

  it('reads as the full id to assistive technology', () =>
  {
    render(
      <div role="gridcell">
        <CatalogNumber value="MM-0141" />
      </div>
    )
    expect(screen.getByRole('gridcell', { name: 'MM-0141' })).toBeInTheDocument()
  })

  it('sets a quiet tabular label and lifts the ink when selected', () =>
  {
    const { container, rerender } = render(<CatalogNumber value="MM-12345" />)
    const number = container.firstElementChild as HTMLElement
    expect(number).toHaveAttribute('data-size', 'sm')
    expect(number).not.toHaveAttribute('data-selected')
    expect(classesOf(number)).toEqual(expect.arrayContaining(['ui-catalog-number', 'text-label', 'tabular-nums', 'text-ink-3']))
    rerender(<CatalogNumber value="MM-12345" selected />)
    expect(number).toHaveAttribute('data-selected', 'true')
    expect(classesOf(number)).toContain('text-ink-2')
  })

  it('keeps a zero and a value without a hyphen', () =>
  {
    expect(jobNumber('MM-0000')).toBe('0')
    expect(jobNumber('R-0031')).toBe('31')
    expect(jobNumber('0142')).toBe('142')
  })

  it('sets the display size as a section heading', () =>
  {
    const { container } = render(<CatalogNumber value="MM-0141" size="display" className="leading-none" />)
    const heading = container.firstElementChild as HTMLElement
    expect(heading).toHaveAttribute('data-size', 'display')
    expect(classesOf(heading)).toEqual(expect.arrayContaining(['text-section', 'leading-none']))
  })

  it('passes a caller class to the number', () =>
  {
    const { container } = render(<CatalogNumber value="MM-0141" className="ms-2" />)
    expect(classesOf(container.firstElementChild!)).toContain('ms-2')
  })
})

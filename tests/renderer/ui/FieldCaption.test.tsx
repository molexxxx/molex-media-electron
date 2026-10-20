/**
 * FieldCaption: the uppercase typed label above a field. The control is found by its sentence-case name
 * through `<label for>` and through `aria-labelledby`, the uppercase copy is hidden from assistive
 * technology, and the hint (with "(required)") carries the id the paired field references.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FieldCaption, hintIdFor, REQUIRED_LABEL } from '../../../src/renderer/src/ui/FieldCaption'

describe('FieldCaption', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('names its control by the sentence-case caption through getByLabelText', () =>
  {
    render(
      <>
        <FieldCaption htmlFor="batch-size">Batch size</FieldCaption>
        <input id="batch-size" type="text" />
      </>
    )
    const control = screen.getByLabelText('Batch size')
    expect(control).toHaveAttribute('id', 'batch-size')
    expect(screen.getByRole('textbox', { name: 'Batch size' })).toBe(control)
  })

  it('hides the uppercase visual copy from assistive technology and keeps the transform off the name', () =>
  {
    const { container } = render(
      <>
        <FieldCaption htmlFor="batch-size">Batch size</FieldCaption>
        <input id="batch-size" type="text" />
      </>
    )
    const label = container.querySelector('label') as HTMLLabelElement
    const visual = label.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(visual).toHaveAttribute('data-caption', 'Batch size')
    expect(visual).toHaveClass('type-caption')
    expect(visual.textContent).toBe('')
    expect(label).not.toHaveClass('type-caption')
    expect(label).not.toHaveClass('uppercase')
    expect(label).toHaveClass('text-ink-2')
    expect(label.textContent).toBe('Batch size')
  })

  it('activates its control when the caption is clicked', () =>
  {
    render(
      <>
        <FieldCaption htmlFor="subfolders">Include subfolders</FieldCaption>
        <input id="subfolders" type="checkbox" />
      </>
    )
    fireEvent.click(screen.getByText('Include subfolders'))
    expect(screen.getByLabelText('Include subfolders')).toBeChecked()
  })

  it('names a group through aria-labelledby when rendered as a span with an id', () =>
  {
    const { container } = render(
      <>
        <FieldCaption id="mode">Compress mode</FieldCaption>
        <div role="radiogroup" aria-labelledby="mode" />
      </>
    )
    expect(container.querySelector('label')).toBeNull()
    const caption = container.querySelector('#mode') as HTMLElement
    expect(caption.tagName).toBe('SPAN')
    expect(screen.getByLabelText('Compress mode')).toHaveAttribute('role', 'radiogroup')
    expect(screen.getByRole('radiogroup', { name: 'Compress mode' })).toBeInTheDocument()
  })

  it('renders the hint with hintId and the paired field describes itself with it', () =>
  {
    render(
      <>
        <FieldCaption htmlFor="peak" hint="From −9 to −1 dBTP" hintId="peak-note">Maximum true peak</FieldCaption>
        <input id="peak" type="text" aria-describedby="peak-note" />
      </>
    )
    const hint = screen.getByText('From −9 to −1 dBTP')
    expect(hint).toHaveAttribute('id', 'peak-note')
    expect(hint).toHaveClass('text-label', 'text-ink-3')
    const field = screen.getByLabelText('Maximum true peak')
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain('peak-note')
    expect(field).toHaveAccessibleDescription('From −9 to −1 dBTP')
    expect(field).toHaveAccessibleName('Maximum true peak')
  })

  it('derives the hint id from htmlFor, then from id', () =>
  {
    const { rerender } = render(<FieldCaption htmlFor="gain" hint="dB">Gain</FieldCaption>)
    expect(screen.getByText('dB')).toHaveAttribute('id', hintIdFor('gain'))
    expect(hintIdFor('gain')).toBe('gain-hint')
    rerender(<FieldCaption id="workers" hint="Mixed">Jobs at once</FieldCaption>)
    expect(screen.getByText('Mixed')).toHaveAttribute('id', 'workers-hint')
  })

  it('gives the hint an id of its own when the caption has neither htmlFor nor id', () =>
  {
    render(<FieldCaption hint="Applies to new jobs">New files get</FieldCaption>)
    const hint = screen.getByText('Applies to new jobs')
    expect(hint.id).toMatch(/-hint$/)
    expect(hint.id.length).toBeGreaterThan('-hint'.length)
  })

  it('renders the word required in hint style, never an asterisk alone', () =>
  {
    const { rerender } = render(
      <>
        <FieldCaption htmlFor="folder" required>Output folder</FieldCaption>
        <input id="folder" type="text" aria-describedby="folder-hint" />
      </>
    )
    const word = screen.getByText(REQUIRED_LABEL)
    expect(REQUIRED_LABEL).toBe('(required)')
    expect(word).toHaveAttribute('id', 'folder-hint')
    expect(word).toHaveClass('text-ink-3')
    expect(document.body.textContent).not.toContain('*')
    expect(screen.getByLabelText('Output folder')).toHaveAccessibleDescription('(required)')
    rerender(
      <>
        <FieldCaption htmlFor="folder" hint="A folder on this computer" required>Output folder</FieldCaption>
        <input id="folder" type="text" aria-describedby="folder-hint" />
      </>
    )
    expect(screen.getByText('A folder on this computer (required)')).toHaveAttribute('id', 'folder-hint')
  })

  it('renders no hint element without a hint or required, and adds the caller class to the row', () =>
  {
    const { container } = render(<FieldCaption htmlFor="crf" className="mt-3">Custom CRF</FieldCaption>)
    const row = container.firstElementChild as HTMLElement
    expect(row).toHaveClass('mt-3', 'pb-1.5')
    expect(row.children).toHaveLength(1)
    expect(container.querySelector('#crf-hint')).toBeNull()
  })
})

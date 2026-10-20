/**
 * StageTrack: an ordered list of the plan's stages where every stage states its state in words, the
 * active stage is the current step, Save follows Verify, and stages the operation skips are absent.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StageTrack, type Stage } from '../../../src/renderer/src/ui/StageTrack'

/** The text a screen reader reaches: every text node outside `aria-hidden` subtrees. */
function accessibleText(element: Element): string
{
  let text = ''
  element.childNodes.forEach((node) =>
  {
    if (node.nodeType === Node.TEXT_NODE)
    {
      text += node.textContent ?? ''
    }
    else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true')
    {
      text += accessibleText(node)
    }
  })
  return text
}

/** What a screen reader says for the whole track, with `aria-current="step"` read as "current step". */
function spoken(): string
{
  return screen.getAllByRole('listitem')
    .map((item) => accessibleText(item) + (item.getAttribute('aria-current') === 'step' ? ', current step' : ''))
    .join('; ')
}

const NORMALIZE_RUNNING: Stage[] = [
  { key: 'probe', label: 'Probe', state: 'done' },
  { key: 'measure', label: 'Measure', state: 'done' },
  { key: 'encode', label: 'Encode', state: 'active', detail: 'pass 1 of 2' },
  { key: 'verify', label: 'Verify', state: 'pending' },
  { key: 'save', label: 'Save', state: 'pending' }
]

describe('StageTrack', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('renders an ordered list named "Stages"', () =>
  {
    render(<StageTrack stages={NORMALIZE_RUNNING} />)
    const list = screen.getByRole('list', { name: 'Stages' })
    expect(list.tagName).toBe('OL')
    expect(list).toHaveClass('text-label')
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('marks only the active stage as the current step', () =>
  {
    render(<StageTrack stages={NORMALIZE_RUNNING} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, null, 'step', null, null])
    expect(items[2].querySelector('.font-semibold')).toHaveTextContent('Encode')
    expect(items[2].querySelector('svg')).toHaveClass('motion-safe:animate-spin')
  })

  it('reads every stage with its state', () =>
  {
    render(<StageTrack stages={NORMALIZE_RUNNING} />)
    expect(spoken()).toBe('Probe, done; Measure, done; Encode, pass 1 of 2, current step; Verify, pending; Save, pending')
  })

  it('shows "failed" and "skipped" and hides "done" and "pending"', () =>
  {
    render(
      <StageTrack
        stages={[
          { key: 'probe', label: 'Probe', state: 'done' },
          { key: 'encode', label: 'Encode', state: 'failed' },
          { key: 'verify', label: 'Verify', state: 'skipped' },
          { key: 'save', label: 'Save', state: 'pending' }
        ]}
      />
    )
    const items = screen.getAllByRole('listitem')
    expect(spoken()).toBe('Probe, done; Encode, failed; Verify, skipped; Save, pending')
    const visibleWord = (item: HTMLElement, word: string): Element | undefined =>
      Array.from(item.querySelectorAll('span')).find((span) => span.textContent === word && !span.classList.contains('sr-only'))
    expect(visibleWord(items[1], 'failed')).toHaveClass('text-error')
    expect(visibleWord(items[2], 'skipped')).toHaveClass('text-ink-3')
    expect(items[0].querySelector('.sr-only')).toHaveTextContent('done')
    expect(items[3].querySelector('.sr-only')).toHaveTextContent('pending')
    expect(items[0]).toHaveAttribute('data-state', 'done')
    expect(items[1]).toHaveAttribute('data-state', 'failed')
  })

  it('draws each state with its registry icon, hidden from assistive technology', () =>
  {
    render(
      <StageTrack
        stages={[
          { key: 'probe', label: 'Probe', state: 'done' },
          { key: 'measure', label: 'Measure', state: 'skipped' },
          { key: 'encode', label: 'Encode', state: 'failed' },
          { key: 'verify', label: 'Verify', state: 'active' },
          { key: 'save', label: 'Save', state: 'pending' }
        ]}
      />
    )
    const icons = screen.getAllByRole('listitem').map((item) => item.querySelector('svg[data-icon]'))
    expect(icons.map((icon) => icon?.getAttribute('data-icon'))).toEqual(['status.done', 'status.skipped', 'status.failed', 'status.active', 'status.pending'])
    expect(icons.map((icon) => icon?.getAttribute('class')?.match(/text-(verified|ink-3|error|running)/)?.[0]))
      .toEqual(['text-verified', 'text-ink-3', 'text-error', 'text-running', 'text-ink-3'])
    for (const icon of icons)
    {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('places Save after Verify and leaves out the stages the operation does not run', () =>
  {
    render(
      <StageTrack
        stages={[
          { key: 'probe', label: 'Probe', state: 'done', detail: '0.4 s' },
          { key: 'encode', label: 'Encode', state: 'done', detail: '1 min 12 s' },
          { key: 'verify', label: 'Verify', state: 'done', detail: '9 s' },
          { key: 'save', label: 'Save', state: 'active' }
        ]}
      />
    )
    const keys = screen.getAllByRole('listitem').map((item) => item.getAttribute('data-stage'))
    expect(keys).toEqual(['probe', 'encode', 'verify', 'save'])
    expect(keys.indexOf('save')).toBe(keys.indexOf('verify') + 1)
    expect(keys).not.toContain('measure')
  })

  it('renders details, including durations and the corrective pass', () =>
  {
    render(
      <StageTrack
        stages={[
          { key: 'measure', label: 'Measure', state: 'done', detail: '1 min 12 s' },
          { key: 'encode', label: 'Encode', state: 'done', detail: 'pass 2 of 2' },
          { key: 'correct', label: 'Re-encode (correction)', state: 'active', detail: 'corrective' }
        ]}
      />
    )
    const details = screen.getAllByRole('listitem').map((item) => item.querySelector('[data-part="detail"]')?.textContent)
    expect(details).toEqual(['1 min 12 s', 'pass 2 of 2', 'corrective'])
    expect(spoken()).toBe('Measure, done, 1 min 12 s; Encode, done, pass 2 of 2; Re-encode (correction), corrective, current step')
  })

  it('joins stages with hidden 12 px connectors', () =>
  {
    const { container } = render(<StageTrack stages={NORMALIZE_RUNNING} className="mt-2" />)
    const connectors = container.querySelectorAll('[data-part="connector"]')
    expect(connectors).toHaveLength(4)
    for (const connector of connectors)
    {
      expect(connector).toHaveAttribute('aria-hidden', 'true')
      expect(connector.firstElementChild).toHaveClass('h-3', 'w-px', 'bg-line')
    }
    expect(screen.getAllByRole('listitem')[0].querySelector('[data-part="connector"]')).toBeNull()
    expect(screen.getByRole('list')).toHaveClass('mt-2')
  })

  it('renders an empty track without stages', () =>
  {
    render(<StageTrack stages={[]} />)
    expect(screen.getByRole('list', { name: 'Stages' })).toBeEmptyDOMElement()
  })
})

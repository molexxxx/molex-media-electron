/**
 * StatusLabel: every registry key and every Batch table status row renders an icon and a word in its
 * ink, held labels carry the frame hook and the hidden ", not acknowledged", the compact word never
 * reaches the accessible text, and spinners turn only for active stages in view.
 */
import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { BadgeCheck, Ban, CircleCheck, CircleDashed, CirclePause, Clock, FileX, LoaderCircle, Lock, OctagonX, SkipForward, TriangleAlert, type LucideIcon } from 'lucide-react'
import { ICONS } from '../../../src/renderer/src/ui/icons'
import {
  NOT_ACKNOWLEDGED,
  STATUS_REGISTRY,
  StatusLabel,
  observeVisibility,
  statusAttribute,
  statusTooltip,
  statusWord,
  type StatusInk,
  type StatusKey
} from '../../../src/renderer/src/ui/StatusLabel'

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

function label(container: HTMLElement): HTMLElement
{
  const element = container.querySelector<HTMLElement>('.ui-status')
  expect(element).not.toBeNull()
  return element as HTMLElement
}

function iconOf(element: Element): Element
{
  const icon = element.querySelector('svg[data-icon]')
  expect(icon).not.toBeNull()
  return icon as Element
}

/** The status-key table: icon component, ink, and default word for every key. */
const KEY_TABLE: Record<StatusKey, { icon: LucideIcon, ink: StatusInk, word: string, spins: boolean }> = {
  pending: { icon: CircleDashed, ink: 'ink-3', word: 'Pending', spins: false },
  ready: { icon: CircleDashed, ink: 'ink-2', word: 'Ready', spins: false },
  probing: { icon: LoaderCircle, ink: 'ink-3', word: 'Probing', spins: true },
  queued: { icon: Clock, ink: 'ink-3', word: 'Queued', spins: false },
  waiting: { icon: Clock, ink: 'ink-2', word: 'Waiting', spins: false },
  analyzing: { icon: LoaderCircle, ink: 'running', word: 'Analyzing', spins: true },
  encoding: { icon: LoaderCircle, ink: 'running', word: 'Encoding', spins: true },
  verifying: { icon: LoaderCircle, ink: 'running', word: 'Verifying', spins: true },
  finalizing: { icon: LoaderCircle, ink: 'running', word: 'Finalizing', spins: true },
  'wait-lock': { icon: Clock, ink: 'warning', word: 'Waiting for file access', spins: false },
  stopping: { icon: LoaderCircle, ink: 'ink-2', word: 'Stopping', spins: true },
  paused: { icon: CirclePause, ink: 'ink-2', word: 'Paused', spins: false },
  decision: { icon: TriangleAlert, ink: 'warning', word: 'Needs a decision', spins: false },
  done: { icon: CircleCheck, ink: 'verified', word: 'Done', spins: false },
  verified: { icon: BadgeCheck, ink: 'verified', word: 'Verified', spins: false },
  warning: { icon: TriangleAlert, ink: 'warning', word: 'Warning', spins: false },
  blocked: { icon: OctagonX, ink: 'error', word: 'Blocked', spins: false },
  failed: { icon: OctagonX, ink: 'error', word: 'Failed', spins: false },
  returned: { icon: OctagonX, ink: 'error', word: 'Returned', spins: false },
  'will-skip': { icon: SkipForward, ink: 'ink-3', word: 'Will skip', spins: false },
  cancelled: { icon: Ban, ink: 'ink-3', word: 'Canceled', spins: false },
  skipped: { icon: SkipForward, ink: 'ink-3', word: 'Skipped', spins: false },
  locked: { icon: Lock, ink: 'ink-3', word: 'Locked', spins: false },
  missing: { icon: FileX, ink: 'error', word: 'Source missing', spins: false }
}

interface TableRow
{
  status: StatusKey
  word: string
  compact?: string
  icon: LucideIcon
  ink: StatusInk
  held: boolean
}

/** Every status row of the Batch table, with its word, compact word, icon, ink, and held flag. */
const TABLE_ROWS: TableRow[] = [
  { status: 'probing', word: 'Probing', icon: LoaderCircle, ink: 'ink-3', held: false },
  { status: 'pending', word: 'Checking', icon: CircleDashed, ink: 'ink-3', held: false },
  { status: 'ready', word: 'Ready', icon: CircleDashed, ink: 'ink-2', held: false },
  { status: 'ready', word: 'Ready, attempt 2', compact: 'Ready', icon: CircleDashed, ink: 'ink-2', held: false },
  { status: 'warning', word: '1 warning', icon: TriangleAlert, ink: 'warning', held: false },
  { status: 'warning', word: '3 warnings', icon: TriangleAlert, ink: 'warning', held: false },
  { status: 'blocked', word: 'Blocked', icon: OctagonX, ink: 'error', held: false },
  { status: 'will-skip', word: 'Will skip', icon: SkipForward, ink: 'ink-3', held: false },
  { status: 'blocked', word: 'Unreadable', icon: OctagonX, ink: 'error', held: false },
  { status: 'blocked', word: 'Not media', icon: OctagonX, ink: 'error', held: false },
  { status: 'missing', word: 'Source missing', compact: 'Missing', icon: FileX, ink: 'error', held: false },
  { status: 'warning', word: 'Plan changed', icon: TriangleAlert, ink: 'warning', held: false },
  { status: 'pending', word: 'Not in this batch', compact: 'Not in batch', icon: CircleDashed, ink: 'ink-3', held: false },
  { status: 'queued', word: 'Queued', icon: Clock, ink: 'ink-3', held: false },
  { status: 'waiting', word: 'Waiting for album', compact: 'Waiting', icon: Clock, ink: 'ink-2', held: false },
  { status: 'waiting', word: 'Waiting for GPU', compact: 'Waiting', icon: Clock, ink: 'ink-2', held: false },
  { status: 'waiting', word: 'Waiting for space', compact: 'Waiting', icon: Clock, ink: 'ink-2', held: false },
  { status: 'waiting', word: 'Waiting for D:', compact: 'Waiting', icon: Clock, ink: 'ink-2', held: false },
  { status: 'analyzing', word: 'Probing', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'analyzing', word: 'Measuring', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'analyzing', word: 'Measuring after dynamics', compact: 'Measuring', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'analyzing', word: 'Measuring album', compact: 'Album', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'encoding', word: 'Encoding', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'encoding', word: 'Encoding, pass 1 of 2', compact: 'Encoding 1/2', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'encoding', word: 'Re-encoding (correction)', compact: 'Re-encoding', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'verifying', word: 'Verifying', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'finalizing', word: 'Saving', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'finalizing', word: 'Moving original to the Recycle Bin', compact: 'To Recycle Bin', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'finalizing', word: 'Moving old file to the Recycle Bin', compact: 'To Recycle Bin', icon: LoaderCircle, ink: 'running', held: false },
  { status: 'wait-lock', word: 'Waiting for file access', compact: 'File in use', icon: Clock, ink: 'warning', held: false },
  { status: 'stopping', word: 'Stopping', icon: LoaderCircle, ink: 'ink-2', held: false },
  { status: 'decision', word: 'Needs a decision', compact: 'Decide', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'decision', word: 'File appeared, needs a decision', compact: 'Decide', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'decision', word: 'File in use, needs a decision', compact: 'Decide', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'decision', word: 'Interrupted while saving', compact: 'Decide', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'verified', word: 'Verified', icon: BadgeCheck, ink: 'verified', held: false },
  { status: 'done', word: 'Done', icon: CircleCheck, ink: 'verified', held: false },
  { status: 'verified', word: 'Verified, reachable level', compact: 'Reachable level', icon: BadgeCheck, ink: 'verified', held: false },
  { status: 'warning', word: 'Below target', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'failed', word: 'Outside tolerance', compact: 'Off target', icon: OctagonX, ink: 'error', held: true },
  { status: 'warning', word: 'Larger than the source', compact: 'Larger', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'warning', word: 'Peak over after encoding', compact: 'Peak over', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'warning', word: 'Original kept', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'warning', word: 'Previous file kept', compact: 'Previous kept', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'warning', word: 'Ran on the CPU', compact: 'Ran on CPU', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'warning', word: 'Source changed', icon: TriangleAlert, ink: 'warning', held: true },
  { status: 'failed', word: 'Failed', icon: OctagonX, ink: 'error', held: true },
  { status: 'cancelled', word: 'Canceled', icon: Ban, ink: 'ink-3', held: false },
  { status: 'skipped', word: 'Skipped', icon: SkipForward, ink: 'ink-3', held: false },
  { status: 'skipped', word: 'Skipped, file exists', compact: 'Skipped', icon: SkipForward, ink: 'ink-3', held: false },
  { status: 'failed', word: 'Interrupted', icon: OctagonX, ink: 'error', held: true }
]

const STYLESHEET = readFileSync(resolve(__dirname, '../../../src/renderer/src/styles/primitives.css'), 'utf8')

/** The ink primitives.css gives each `data-status` value. */
function stylesheetInks(): Map<string, string>
{
  const inks = new Map<string, string>()
  for (const match of STYLESHEET.matchAll(/\.ui-status:is\(([^)]*)\)\s*\{\s*color:\s*var\(--color-([a-z0-9-]+)\)/g))
  {
    for (const value of match[1].matchAll(/data-status='([a-z-]+)'/g))
    {
      inks.set(value[1], match[2])
    }
  }
  return inks
}

describe('StatusLabel', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('gives every key the icon, ink, and default word of the status-key table', () =>
  {
    const keys = Object.keys(KEY_TABLE) as StatusKey[]
    expect(Object.keys(STATUS_REGISTRY).sort()).toEqual([...keys].sort())
    for (const key of keys)
    {
      const entry = STATUS_REGISTRY[key]
      expect(ICONS[entry.icon], key).toBe(KEY_TABLE[key].icon)
      expect(entry.ink, key).toBe(KEY_TABLE[key].ink)
      expect(entry.word, key).toBe(KEY_TABLE[key].word)
      expect(entry.spins, key).toBe(KEY_TABLE[key].spins)
    }
  })

  it('renders an icon and a word for every state, never the icon alone', () =>
  {
    for (const key of Object.keys(STATUS_REGISTRY) as StatusKey[])
    {
      const { container, unmount } = render(<StatusLabel status={key} />)
      const element = label(container)
      const icon = iconOf(element)
      expect(icon).toHaveAttribute('aria-hidden', 'true')
      expect(icon.getAttribute('data-icon')).toBe(STATUS_REGISTRY[key].icon)
      expect(element.querySelector('[data-label="full"]')?.textContent).toBe(STATUS_REGISTRY[key].word)
      expect(accessibleText(element)).toBe(STATUS_REGISTRY[key].word)
      expect(element).toHaveAttribute('data-status', statusAttribute(key))
      unmount()
    }
  })

  it('styles each key in its ink through primitives.css', () =>
  {
    const inks = stylesheetInks()
    for (const key of Object.keys(STATUS_REGISTRY) as StatusKey[])
    {
      expect(inks.get(statusAttribute(key)), key).toBe(STATUS_REGISTRY[key].ink)
    }
  })

  it('renders cancelled as "Canceled" with the canceled hook', () =>
  {
    const { container } = render(<StatusLabel status="cancelled" />)
    const element = label(container)
    expect(element).toHaveAttribute('data-status', 'canceled')
    expect(element).toHaveTextContent('Canceled')
    expect(element.textContent).not.toMatch(/Cancelled/)
    expect(iconOf(element).getAttribute('data-icon')).toBe('status.canceled')
  })

  it('renders the locked and missing words', () =>
  {
    const { container, rerender } = render(<StatusLabel status="locked" label="Recipe locked while running" />)
    expect(accessibleText(label(container))).toBe('Recipe locked while running')
    expect(iconOf(label(container)).getAttribute('data-icon')).toBe('status.locked')
    rerender(<StatusLabel status="locked" />)
    expect(accessibleText(label(container))).toBe('Locked')
    rerender(<StatusLabel status="missing" />)
    const element = label(container)
    expect(accessibleText(element)).toBe('Source missing')
    expect(element.querySelector('[data-label="compact"]')).toHaveTextContent('Missing')
    expect(iconOf(element).getAttribute('data-icon')).toBe('status.missing')
  })

  it('marks a held label and ends its accessible text with ", not acknowledged"', () =>
  {
    const { container } = render(<StatusLabel status="failed" held />)
    const element = label(container)
    expect(element).toHaveAttribute('data-held')
    expect(accessibleText(element)).toBe('Failed, not acknowledged')
    expect(accessibleText(element).endsWith(NOT_ACKNOWLEDGED)).toBe(true)
    const suffix = Array.from(element.querySelectorAll('.sr-only')).find((node) => node.textContent === NOT_ACKNOWLEDGED)
    expect(suffix).toBeDefined()
  })

  it('removes the frame hook and the suffix once acknowledged, keeping icon and word', () =>
  {
    const { container, rerender } = render(<StatusLabel status="warning" label="Original kept" held />)
    expect(label(container)).toHaveAttribute('data-held')
    rerender(<StatusLabel status="warning" label="Original kept" held={false} />)
    const element = label(container)
    expect(element).not.toHaveAttribute('data-held')
    expect(element.textContent).not.toContain('not acknowledged')
    expect(accessibleText(element)).toBe('Original kept')
    expect(iconOf(element).getAttribute('data-icon')).toBe('status.warning')
  })

  it('shows the compact word in a narrow container while the accessible text keeps the full word', () =>
  {
    const { container } = render(<StatusLabel status="encoding" label="Encoding, pass 1 of 2" compactLabel="Encoding 1/2" held={false} />)
    const element = label(container)
    const full = element.querySelector('[data-label="full"]')
    const compact = element.querySelector('[data-label="compact"]')
    expect(full).toHaveTextContent('Encoding, pass 1 of 2')
    expect(full).toHaveAttribute('aria-hidden', 'true')
    expect(compact).toHaveTextContent('Encoding 1/2')
    expect(compact).toHaveAttribute('aria-hidden', 'true')
    expect(accessibleText(element)).toBe('Encoding, pass 1 of 2')
    expect(accessibleText(element)).not.toContain('1/2')
  })

  it('swaps the full and compact words under a 96 px container in primitives.css', () =>
  {
    const block = STYLESHEET.match(/@container \(width < 96px\)\s*\{([\s\S]*?)\n {2}\}/)
    expect(block).not.toBeNull()
    const rules = (block as RegExpMatchArray)[1]
    expect(rules).toMatch(/\.ui-status \[data-label='full'\]\s*\{\s*display: none;/)
    expect(rules).toMatch(/\.ui-status \[data-label='compact'\]\s*\{\s*display: inline;/)
    expect(STYLESHEET).toMatch(/\.ui-status \[data-label='compact'\]\s*\{\s*display: none;/)
  })

  it('keeps the full word when held and compact, and reads the suffix after it', () =>
  {
    const { container } = render(<StatusLabel status="decision" label="File appeared, needs a decision" compactLabel="Decide" held />)
    expect(accessibleText(label(container))).toBe('File appeared, needs a decision, not acknowledged')
  })

  it('renders one word when the compact word equals the full word', () =>
  {
    const { container } = render(<StatusLabel status="queued" compactLabel="Queued" />)
    const element = label(container)
    expect(element.querySelector('[data-label="compact"]')).toBeNull()
    expect(element.querySelector('[data-label="full"]')).not.toHaveAttribute('aria-hidden')
  })

  it('drops the default compact word when the page passes its own label', () =>
  {
    const { container } = render(<StatusLabel status="wait-lock" label="Waiting for file access, retrying" />)
    const element = label(container)
    expect(element.querySelector('[data-label="compact"]')).toBeNull()
    expect(accessibleText(element)).toBe('Waiting for file access, retrying')
  })

  it('uses the default compact word with the default word', () =>
  {
    const { container } = render(<StatusLabel status="wait-lock" />)
    expect(label(container).querySelector('[data-label="compact"]')).toHaveTextContent('File in use')
  })

  it('renders every Batch table status with its icon, ink, word, and compact word', () =>
  {
    for (const row of TABLE_ROWS)
    {
      const { container, unmount } = render(<StatusLabel status={row.status} label={row.word} compactLabel={row.compact} held={row.held} />)
      const element = label(container)
      const entry = STATUS_REGISTRY[row.status]
      expect(ICONS[entry.icon], row.word).toBe(row.icon)
      expect(iconOf(element).getAttribute('data-icon'), row.word).toBe(entry.icon)
      expect(entry.ink, row.word).toBe(row.ink)
      expect(element.getAttribute('data-status'), row.word).toBe(statusAttribute(row.status))
      expect(element.hasAttribute('data-held'), row.word).toBe(row.held)
      expect(accessibleText(element), row.word).toBe(row.held ? `${row.word}${NOT_ACKNOWLEDGED}` : row.word)
      const compact = element.querySelector('[data-label="compact"]')
      if (row.compact === undefined)
      {
        expect(compact, row.word).toBeNull()
      }
      else
      {
        expect(compact?.textContent, row.word).toBe(row.compact)
      }
      unmount()
    }
  })

  it('sizes the type and icon', () =>
  {
    const { container, rerender } = render(<StatusLabel status="queued" />)
    expect(label(container)).toHaveClass('text-label')
    expect(iconOf(label(container))).toHaveAttribute('width', '14')
    rerender(<StatusLabel status="queued" size="md" className="justify-self-start" />)
    expect(label(container)).toHaveClass('text-body', 'justify-self-start')
    expect(iconOf(label(container))).toHaveAttribute('width', '16')
  })

  it('builds the status cell tooltip and the full word', () =>
  {
    expect(statusTooltip('Failed', true)).toBe('Failed. Not acknowledged.')
    expect(statusTooltip('Encoding, pass 1 of 2')).toBe('Encoding, pass 1 of 2')
    expect(statusWord('cancelled')).toBe('Canceled')
    expect(statusWord('waiting', 'Waiting for D:')).toBe('Waiting for D:')
  })

  it('spins an active stage at once when no observer is available', () =>
  {
    const { container } = render(<StatusLabel status="encoding" />)
    expect(iconOf(label(container))).toHaveClass('motion-safe:animate-spin')
  })
})

type FakeEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>

class FakeIntersectionObserver
{
  static instances: FakeIntersectionObserver[] = []
  readonly targets = new Set<Element>()

  constructor(readonly callback: (entries: FakeEntry[]) => void)
  {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void
  {
    this.targets.add(target)
  }

  unobserve(target: Element): void
  {
    this.targets.delete(target)
  }

  disconnect(): void
  {
    this.targets.clear()
  }
}

function report(target: Element, isIntersecting: boolean): void
{
  act(() =>
  {
    for (const observer of FakeIntersectionObserver.instances)
    {
      if (observer.targets.has(target))
      {
        observer.callback([{ target, isIntersecting }])
      }
    }
  })
}

function observed(target: Element): boolean
{
  return FakeIntersectionObserver.instances.some((observer) => observer.targets.has(target))
}

describe('StatusLabel spinner visibility', () =>
{
  const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver

  beforeAll(() =>
  {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
  })

  afterAll(() =>
  {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original
  })

  afterEach(() =>
  {
    cleanup()
  })

  it('rotates an active stage only while it is in view', () =>
  {
    const { container } = render(<StatusLabel status="verifying" />)
    const element = label(container)
    expect(observed(element)).toBe(true)
    expect(iconOf(element)).not.toHaveClass('motion-safe:animate-spin')
    report(element, true)
    expect(iconOf(element)).toHaveClass('motion-safe:animate-spin')
    report(element, false)
    expect(iconOf(element)).not.toHaveClass('motion-safe:animate-spin')
  })

  it('never observes or rotates a settled status', () =>
  {
    const { container } = render(<StatusLabel status="verified" />)
    const element = label(container)
    expect(observed(element)).toBe(false)
    expect(iconOf(element)).not.toHaveClass('motion-safe:animate-spin')
  })

  it('stops observing when the stage settles or the label unmounts', () =>
  {
    const { container, rerender, unmount } = render(<StatusLabel status="encoding" />)
    const element = label(container)
    report(element, true)
    rerender(<StatusLabel status="done" />)
    expect(observed(element)).toBe(false)
    expect(iconOf(element)).not.toHaveClass('motion-safe:animate-spin')
    rerender(<StatusLabel status="finalizing" />)
    expect(observed(element)).toBe(true)
    unmount()
    expect(observed(element)).toBe(false)
  })

  it('shares one observer between listeners and releases the element after the last one', () =>
  {
    const element = document.createElement('span')
    const seen: boolean[] = []
    const stopFirst = observeVisibility(element, (visible) => seen.push(visible))
    const stopSecond = observeVisibility(element, (visible) => seen.push(!visible))
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    report(element, true)
    expect(seen).toEqual([true, false])
    stopFirst()
    expect(observed(element)).toBe(true)
    stopSecond()
    expect(observed(element)).toBe(false)
  })
})

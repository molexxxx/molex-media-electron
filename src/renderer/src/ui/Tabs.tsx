import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName } from './icons'

/** A value a tab can carry. */
export type TabValue = string | number

/** One tab of a {@link Tabs} list. */
export interface TabItem<T extends TabValue>
{
  value: T
  label: string
  icon?: IconName
  /** Keeps the tab focusable with `aria-disabled` but never activates it. */
  disabled?: boolean
  /** Why the tab is unavailable, read through its `aria-describedby`. */
  disabledReason?: string
  /** A count after the label, such as the jobs in the queue. */
  count?: number
}

/** Props for {@link Tabs}. */
export interface TabsProps<T extends TabValue>
{
  value: T
  onChange(value: T): void
  tabs: ReadonlyArray<TabItem<T>>
  /** The tab list's accessible name. */
  label: string
  /** `auto` activates a tab as focus reaches it; `manual` waits for Enter or Space, for expensive panels. */
  activation?: 'auto' | 'manual'
  /** The id the tabs and their panel derive their ids from; pass it to a {@link TabPanel} rendered elsewhere. */
  id?: string
  /** The selected tab's panel, rendered right after the list; omit it and render a {@link TabPanel} where the layout needs it. */
  children?: ReactNode
  /** Classes for the tab list. */
  className?: string
  /** Classes for the panel rendered from `children`. */
  panelClassName?: string
}

/** Props for {@link TabPanel}. */
export interface TabPanelProps<T extends TabValue> extends Omit<ComponentPropsWithoutRef<'div'>, 'id' | 'role' | 'tabIndex'>
{
  /** The `id` given to the {@link Tabs} this panel belongs to. */
  tabsId: string
  /** The selected tab's value. */
  value: T
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** The id of the tab for `value` in the tab list `tabsId`. */
export function tabId(tabsId: string, value: TabValue): string
{
  return `${tabsId}-tab-${String(value).replace(/[^\w-]/g, '_')}`
}

/** The id of the panel of the tab list `tabsId`, which every tab's `aria-controls` names. */
export function tabPanelId(tabsId: string): string
{
  return `${tabsId}-panel`
}

/**
 * The panel of a tab list, labeled by the selected tab. It takes a Tab stop of its own only while nothing
 * inside it can take focus, so keyboard users always reach its content.
 */
export function TabPanel<T extends TabValue>({ tabsId, value, children, ...rest }: TabPanelProps<T>): ReactElement
{
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() =>
  {
    const panel = panelRef.current as HTMLDivElement
    const sync = (): void =>
    {
      const empty = panel.querySelector(FOCUSABLE) === null
      if (empty && panel.getAttribute('tabindex') !== '0')
      {
        panel.tabIndex = 0
      }
      else if (!empty && panel.hasAttribute('tabindex'))
      {
        panel.removeAttribute('tabindex')
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'tabindex', 'href', 'contenteditable'] })
    return () => observer.disconnect()
  }, [])

  return (
    <div {...rest} ref={panelRef} id={tabPanelId(tabsId)} role="tabpanel" aria-labelledby={tabId(tabsId, value)}>
      {children}
    </div>
  )
}

/** Where the lit indicator sits: the selected tab's text, measured within the tab list. */
interface IndicatorBox
{
  left: number
  width: number
}

function textBox(list: HTMLDivElement | null, text: HTMLSpanElement | null): IndicatorBox | null
{
  if (list === null || text === null)
  {
    return null
  }
  const listRect = list.getBoundingClientRect()
  const rect = text.getBoundingClientRect()
  return { left: rect.left - listRect.left + list.scrollLeft, width: rect.width }
}

function sameBox(a: IndicatorBox | null, b: IndicatorBox | null): boolean
{
  return a === b || (a !== null && b !== null && a.left === b.left && a.width === b.width)
}

/**
 * A named tab list on native buttons with one Tab stop on the selected tab. Left and Right move with wrap,
 * Home and End reach the ends, and activation follows focus unless `activation` is `manual`. A disabled tab
 * stays focusable with `aria-disabled` and is never activated. Every tab controls the one panel, which
 * `children` renders after the list or a {@link TabPanel} renders elsewhere. One lit indicator under the
 * selected tab's text slides to the next selection; it is placed without motion on first paint.
 */
export function Tabs<T extends TabValue>({
  value,
  onChange,
  tabs,
  label,
  activation = 'auto',
  id,
  children,
  className,
  panelClassName
}: TabsProps<T>): ReactElement
{
  const fallbackId = useId()
  const tabsId = id ?? fallbackId
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([])
  const listRef = useRef<HTMLDivElement>(null)
  const textsRef = useRef<Array<HTMLSpanElement | null>>([])
  const [indicator, setIndicator] = useState<IndicatorBox | null>(null)
  const [animated, setAnimated] = useState(false)
  const selectedIndex = tabs.findIndex((tab) => tab.value === value)
  const tabIndexAt = selectedIndex === -1 ? 0 : selectedIndex

  useLayoutEffect(() =>
  {
    const list = listRef.current
    const measure = (): void =>
    {
      const next = textBox(list, selectedIndex === -1 ? null : textsRef.current[selectedIndex])
      setIndicator((previous) => (sameBox(previous, next) ? previous : next))
    }
    measure()
    if (list === null || typeof ResizeObserver === 'undefined')
    {
      return undefined
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const text of textsRef.current)
    {
      if (text !== null)
      {
        observer.observe(text)
      }
    }
    return () => observer.disconnect()
  }, [selectedIndex, tabs])

  useEffect(() =>
  {
    if (indicator !== null && !animated)
    {
      setAnimated(true)
    }
  }, [indicator, animated])

  const activate = (index: number): void =>
  {
    const tab = tabs[index]
    if (!tab.disabled && tab.value !== value)
    {
      onChange(tab.value)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void =>
  {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    {
      return
    }
    let target: number
    switch (event.key)
    {
      case 'ArrowRight':
        target = (index + 1) % tabs.length
        break
      case 'ArrowLeft':
        target = (index - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = tabs.length - 1
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        activate(index)
        return
      default:
        return
    }
    event.preventDefault()
    tabsRef.current[target]?.focus()
    if (activation === 'auto')
    {
      activate(target)
    }
  }

  return (
    <>
      <div ref={listRef} role="tablist" aria-label={label} className={cx('relative flex items-stretch', className)}>
        <span
          aria-hidden="true"
          data-part="indicator"
          className={cx(
            'pointer-events-none absolute bottom-0 inset-s-0 h-0.75 rounded-xs bg-accent-ink shadow-[0_0_10px_color-mix(in_oklab,var(--color-accent-ink)_45%,transparent)]',
            animated && 'transition-[transform,width] duration-(--transition-duration-move) ease-out motion-reduce:transition-none',
            (indicator === null || indicator.width === 0) && 'hidden'
          )}
          style={indicator === null ? undefined : { transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
        {tabs.map((tab, index) =>
        {
          const selected = index === selectedIndex
          const reasonId = tab.disabled && tab.disabledReason ? `${tabsId}-reason-${index}` : undefined
          return (
            <button
              key={String(tab.value)}
              ref={(element) =>
              {
                tabsRef.current[index] = element
              }}
              type="button"
              role="tab"
              id={tabId(tabsId, tab.value)}
              aria-label={tab.count === undefined ? undefined : `${tab.label}, ${tab.count}`}
              aria-selected={selected}
              aria-controls={tabPanelId(tabsId)}
              aria-disabled={tab.disabled || undefined}
              aria-describedby={reasonId}
              tabIndex={index === tabIndexAt ? 0 : -1}
              className={cx(
                'inline-flex h-(--size-control-md) items-center gap-1.5 whitespace-nowrap px-3 text-control transition-colors duration-fast ease-out',
                tab.disabled
                  ? 'text-ink-disabled'
                  : selected
                    ? 'text-ink'
                    : 'text-ink-3 hover:bg-wash-hover hover:text-ink'
              )}
              onClick={() => activate(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.icon && <Icon name={tab.icon} size="sm" />}
              <span
                ref={(element) =>
                {
                  textsRef.current[index] = element
                }}
                data-part="text"
                className="inline-flex items-baseline gap-1.5"
              >
                <span
                  data-part="label"
                  data-label={tab.label}
                  className={cx(
                    'flex flex-col after:invisible after:h-0 after:overflow-hidden after:font-semibold after:content-[attr(data-label)]',
                    selected && 'font-semibold'
                  )}
                >
                  {tab.label}
                </span>
                {tab.count !== undefined && (
                  <span
                    data-part="count"
                    className={cx('text-label tabular-nums', tab.disabled ? 'text-ink-disabled' : selected ? 'type-readout' : 'text-ink-3')}
                  >
                    {tab.count}
                  </span>
                )}
              </span>
              {reasonId && <span id={reasonId} hidden>{tab.disabledReason}</span>}
            </button>
          )
        })}
      </div>
      {children !== undefined && (
        <TabPanel tabsId={tabsId} value={value} className={panelClassName}>
          {children}
        </TabPanel>
      )}
    </>
  )
}

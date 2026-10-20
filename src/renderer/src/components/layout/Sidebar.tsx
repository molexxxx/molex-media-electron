/**
 * @module components/layout/Sidebar
 * @description The walnut navigation rail: Dashboard, the tools, and the system views, with the
 * batch's percent and need-attention count on the Batch item and a named collapse toggle.
 */

import React, { useEffect, useRef } from 'react'
import { useAppStore, type View } from '../../stores/appStore'
import { useJobsStore } from '../../stores/jobs'
import { selectAttentionCount, selectRunPercent } from '../../stores/jobsSelectors'
import { useShellStop } from '../../hooks/useF6Region'
import { cx } from '../../ui/cx'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import { OverlayScrollbar } from '../../ui/OverlayScrollbar'
import type { IconName } from '../../ui/icons'
import { Tooltip } from '../../ui/Tooltip'

/** Below this window width the rail collapses for the session without changing the saved choice. */
export const RAIL_AUTO_COLLAPSE_QUERY = '(max-width: 840px)'

/** The run percent as the rail shows it: a whole number from 0 to 100, never rounded up to done. */
export function railPercent(percent: number): number
{
  if (!Number.isFinite(percent))
  {
    return 0
  }
  return Math.min(100, Math.max(0, Math.floor(percent)))
}

/** "2 need attention", or "1 needs attention". */
export function attentionWords(count: number): string
{
  return count === 1 ? '1 needs attention' : `${count} need attention`
}

/** The Batch item's accessible name, for example "Batch, 46 percent, 2 need attention". */
export function batchItemName(percent: number | null, attention: number): string
{
  const parts = ['Batch']
  if (percent !== null)
  {
    parts.push(`${railPercent(percent)} percent`)
  }
  if (attention > 0)
  {
    parts.push(attentionWords(attention))
  }
  return parts.join(', ')
}

/** The Batch item's tooltip in the collapsed rail, for example "Batch, 46%, 2 need attention". */
export function batchItemTip(percent: number | null, attention: number): string
{
  const parts = ['Batch']
  if (percent !== null)
  {
    parts.push(`${railPercent(percent)}%`)
  }
  if (attention > 0)
  {
    parts.push(attentionWords(attention))
  }
  return parts.join(', ')
}

interface NavEntry
{
  id: View
  label: string
  icon: IconName
}

interface NavSection
{
  /** The group's caption and accessible name; the first group has none. */
  label?: string
  items: readonly NavEntry[]
}

/** The rail's groups in order; every glyph is a registry key. */
export const NAV_SECTIONS: readonly NavSection[] = [
  { items: [{ id: 'dashboard', label: 'Dashboard', icon: 'nav.dashboard' }] },
  {
    label: 'Tools',
    items: [
      { id: 'batch', label: 'Batch', icon: 'nav.batch' },
      { id: 'editor', label: 'Editor', icon: 'nav.editor' },
      { id: 'player', label: 'Player', icon: 'nav.player' }
    ]
  },
  {
    label: 'System',
    items: [
      { id: 'settings', label: 'Settings', icon: 'nav.settings' },
      { id: 'logs', label: 'Logs', icon: 'nav.logs' }
    ]
  }
]

interface NavItemProps
{
  entry: NavEntry
  active: boolean
  collapsed: boolean
  name: string
  tip: string
  onSelect: (view: View) => void
  /** Text and glyphs after the label in the expanded rail. */
  trailing?: React.ReactNode
  /** Corner marks over the glyph in the collapsed rail. */
  marks?: React.ReactNode
}

/** One rail item: a native button named by `name`, marked as the current page when active. */
function NavItem({ entry, active, collapsed, name, tip, onSelect, trailing, marks }: NavItemProps): React.JSX.Element
{
  const button = (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      aria-current={active ? 'page' : undefined}
      aria-label={name}
      data-nav={entry.id}
      data-focus="inset"
      className={cx(
        'relative flex h-9 w-full items-center gap-3 rounded-sm border text-body',
        collapsed ? 'justify-center px-0' : 'ps-2 pe-2',
        active
          ? 'border-brass bg-wash-selected text-ink'
          : 'border-transparent text-ink-2 hover:bg-wash-hover hover:text-ink active:bg-wash-pressed'
      )}
    >
      <Icon name={entry.icon} size="md" className={active ? 'text-brass' : undefined} />
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>}
      {!collapsed && trailing}
      {collapsed && marks}
    </button>
  )
  return collapsed ? <Tooltip content={tip} mode="label" placement="end">{button}</Tooltip> : button
}

/** The run percent and the need-attention count after the Batch label; nothing while idle and clear. */
function BatchStatus({ percent, attention }: { percent: number | null, attention: number }): React.JSX.Element | null
{
  if (percent === null && attention === 0)
  {
    return null
  }
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-2 text-label tabular-nums">
      {percent !== null && <span data-part="percent" className="text-ink-2">{railPercent(percent)}%</span>}
      {attention > 0 && (
        <span data-part="attention" className="flex items-center gap-1 text-error">
          <Icon name="status.failed" size="sm" />
          {attention > 99 ? '99+' : attention}
        </span>
      )}
    </span>
  )
}

/** The collapsed rail's marks: a thin meter along the item's foot while a run is open, and the octagon. */
function BatchMarks({ percent, attention }: { percent: number | null, attention: number }): React.JSX.Element
{
  return (
    <>
      {percent !== null && (
        <span aria-hidden="true" data-part="meter" className="absolute inset-x-1.5 bottom-1 h-0.5 rounded-xs bg-line-strong">
          <span className="block h-full rounded-xs bg-running" style={{ width: `${railPercent(percent)}%` }} />
        </span>
      )}
      {attention > 0 && (
        <span aria-hidden="true" data-part="attention" className="absolute inset-e-0.5 top-0.5 rounded-full bg-rail text-error">
          <Icon name="status.failed" size="sm" />
        </span>
      )}
    </>
  )
}

/** The update mark on Settings: a still glyph whose words reach assistive technology through the item's name. */
function UpdateBadge({ collapsed }: { collapsed: boolean }): React.JSX.Element
{
  return (
    <span
      aria-hidden="true"
      data-part="update"
      className={collapsed ? 'absolute inset-e-0.5 top-0.5 rounded-full bg-rail text-ink' : 'flex shrink-0 items-center text-ink'}
    >
      <Icon name="update.available" size="sm" />
    </span>
  )
}

/** The unseen-error count on Logs, unchanged in look until the Logs view moves it to the engine. */
function LogsBadge({ count, collapsed }: { count: number, collapsed: boolean }): React.JSX.Element
{
  return collapsed ? (
    <span aria-hidden="true" data-part="errors" className="absolute inset-e-0.5 top-0.5 size-2 rounded-full bg-red-500" />
  ) : (
    <span aria-hidden="true" data-part="errors" className="min-w-5 rounded-full bg-red-500/20 px-1.5 py-0.5 text-center text-2xs font-bold text-red-200">
      {count > 99 ? '99+' : count}
    </span>
  )
}

/** The main navigation rail; its landmark is the first stop of the F6 cycle. */
export default function Sidebar(): React.JSX.Element
{
  const currentView = useAppStore((s) => s.currentView)
  const setView = useAppStore((s) => s.setView)
  const logs = useAppStore((s) => s.logs)
  const lastSeenErrorCount = useAppStore((s) => s.lastSeenErrorCount)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const percent = useJobsStore(selectRunPercent)
  const attention = useJobsStore(selectAttentionCount(null))
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useShellStop('rail', navRef)

  const unseenErrors = Math.max(0, logs.filter((l) => l.level === 'error').length - lastSeenErrorCount)
  const hasUpdate = updateStatus === 'available' || updateStatus === 'downloaded'

  useEffect(() =>
  {
    const mq = window.matchMedia(RAIL_AUTO_COLLAPSE_QUERY)
    const apply = (narrow: boolean): void =>
    {
      if (narrow)
      {
        useAppStore.setState({ sidebarCollapsed: true })
      }
      else
      {
        useAppStore.setState({ sidebarCollapsed: useAppStore.getState().config?.sidebarCollapsed ?? false })
      }
    }
    if (mq.matches)
    {
      apply(true)
    }
    const onChange = (e: MediaQueryListEvent): void => apply(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const describe = (entry: NavEntry): { name: string, tip: string, trailing?: React.ReactNode, marks?: React.ReactNode } =>
  {
    if (entry.id === 'batch')
    {
      return {
        name: batchItemName(percent, attention),
        tip: batchItemTip(percent, attention),
        trailing: <BatchStatus percent={percent} attention={attention} />,
        marks: <BatchMarks percent={percent} attention={attention} />
      }
    }
    if (entry.id === 'settings' && hasUpdate)
    {
      return {
        name: 'Settings, update available',
        tip: 'Settings, update available',
        trailing: <UpdateBadge collapsed={false} />,
        marks: <UpdateBadge collapsed />
      }
    }
    if (entry.id === 'logs' && unseenErrors > 0)
    {
      const words = unseenErrors === 1 ? '1 new error' : `${unseenErrors} new errors`
      return {
        name: `Logs, ${words}`,
        tip: `Logs, ${words}`,
        trailing: <LogsBadge count={unseenErrors} collapsed={false} />,
        marks: <LogsBadge count={unseenErrors} collapsed />
      }
    }
    return { name: entry.label, tip: entry.label }
  }

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      data-collapsed={collapsed ? '' : undefined}
      className={cx('relative flex h-full shrink-0 flex-col border-r border-rail-edge bg-rail', collapsed ? 'w-13' : 'w-52')}
    >
      <div className={cx('drag-region flex h-(--size-titlebar) shrink-0 items-center px-2', collapsed && 'justify-center')}>
        <IconButton
          className={cx('no-drag', !collapsed && 'ms-px')}
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          icon={collapsed ? 'rail.expand' : 'rail.collapse'}
          aria-expanded={!collapsed}
          onClick={toggleSidebar}
        />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-3 [&::-webkit-scrollbar]:w-0">
          {NAV_SECTIONS.map((section, index) => (
            <div key={section.label ?? index} role={section.label ? 'group' : undefined} aria-label={section.label}>
              {!collapsed && section.label && (
                <div aria-hidden="true" className="type-caption px-2.5 pb-1 text-ink-3">{section.label}</div>
              )}
              <div className="flex flex-col gap-0.5">
                {section.items.map((entry) =>
                {
                  const { name, tip, trailing, marks } = describe(entry)
                  return (
                    <NavItem
                      key={entry.id}
                      entry={entry}
                      active={currentView === entry.id}
                      collapsed={collapsed}
                      name={name}
                      tip={tip}
                      onSelect={setView}
                      trailing={trailing}
                      marks={marks}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <OverlayScrollbar target={listRef} />
      </div>
    </nav>
  )
}

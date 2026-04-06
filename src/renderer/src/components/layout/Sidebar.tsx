/**
 * @module components/layout/Sidebar
 * @description Main navigation sidebar with section-grouped nav items.
 *
 * Provides the primary navigation (Dashboard, Batch, Editor, Player,
 * Settings, Logs) grouped by category, a collapsible processing panel
 * with real-time task progress, and pause / cancel / clear controls.
 */

import React, { useEffect } from 'react'
import { useAppStore, View } from '../../stores/appStore'
import { ProcessingPanel } from './components/ProcessingPanel'

interface NavItem {
  id: View
  label: string
  icon: React.JSX.Element
  badge?: number
}

const icons = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  batch: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14,2 14,8 20,8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  ),
  processing: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  ),
  player: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  editor: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12L12 12" />
      <path d="M20 4L8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8L20 20" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  ),
  logs: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  )
}

export default function Sidebar(): React.JSX.Element {
  const { currentView, setView, files, logs, sidebarCollapsed, setSidebarCollapsed, toggleSidebar } = useAppStore()

  const errorCount = logs.filter((l) => l.level === 'error').length

  // Auto-collapse on narrow windows
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 840px)')
    const onChange = (e: MediaQueryListEvent | MediaQueryList): void => {
      setSidebarCollapsed(e.matches)
    }
    onChange(mq)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setSidebarCollapsed])

  const collapsed = sidebarCollapsed

  const sections: { label?: string; items: NavItem[] }[] = [
    {
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: icons.dashboard }
      ]
    },
    {
      label: 'Workflow',
      items: [
        { id: 'batch', label: 'Batch', icon: icons.batch, badge: files.length || undefined }
      ]
    },
    {
      label: 'Tools',
      items: [
        { id: 'editor', label: 'Editor', icon: icons.editor },
        { id: 'player', label: 'Player', icon: icons.player }
      ]
    },
    {
      label: 'System',
      items: [
        { id: 'settings', label: 'Settings', icon: icons.settings },
        { id: 'logs', label: 'Logs', icon: icons.logs, badge: errorCount || undefined }
      ]
    }
  ]

  return (
    <nav className={`${collapsed ? 'w-13 overflow-visible' : 'w-50'} shrink-0 h-full bg-surface-900/50 border-r border-white/5 flex flex-col pt-0 pb-3 px-2 transition-all duration-200 relative`}>
      {/* Drag region + collapse toggle */}
      <div className="drag-region h-10 shrink-0 relative">
        <button
          onClick={toggleSidebar}
          className="no-drag absolute top-2.5 right-0 w-5 h-5 rounded flex items-center justify-center text-surface-600 hover:text-surface-300 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
              <polyline points="14 9 17 12 14 15" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
              <polyline points="16 9 13 12 16 15" />
            </svg>
          )}
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto scrollbar-thin">
        {sections.map((section, si) => (
          <div key={si}>
            {section.label && !collapsed && (
              <div className="px-3 mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-surface-600">{section.label}</span>
              </div>
            )}
            {section.label && collapsed && (
              <div className="mx-auto mb-1 w-5 border-t border-surface-700/60" />
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = currentView === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => setView(item.id)}
                    className={`w-full flex items-center ${collapsed ? 'justify-center' : ''} gap-2.5 ${collapsed ? 'px-0 py-2' : 'px-3 py-2'} rounded-lg text-sm font-medium transition-all duration-150 group relative
                      ${active
                        ? 'bg-accent-500/15 text-accent-300 shadow-inner-glow'
                        : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/40'
                      }`}
                  >
                    <span className={`transition-colors shrink-0 ${active ? 'text-accent-400' : 'text-surface-500 group-hover:text-surface-300'}`}>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
                    {collapsed && (
                      <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-surface-800 border border-surface-700 text-xs text-surface-200 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-50 shadow-lg">
                        {item.label}
                      </span>
                    )}
                    {!collapsed && item.badge !== undefined && item.badge > 0 && (
                      <span className={`text-2xs font-bold px-1.5 py-0.5 rounded-full min-w-5 text-center
                        ${item.id === 'logs'
                          ? 'bg-red-500/20 text-red-400'
                          : active
                            ? 'bg-accent-500/30 text-accent-300'
                            : 'bg-surface-600 text-surface-300'
                        }`}
                      >
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                    {collapsed && item.badge !== undefined && item.badge > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-500" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <ProcessingPanel collapsed={collapsed} />
    </nav>
  )
}

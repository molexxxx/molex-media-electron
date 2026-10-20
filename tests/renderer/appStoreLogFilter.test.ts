/**
 * Guards the Logs filter that a job or run opens the Logs view with, and the
 * renderer type of the announce-progress setting.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import type { AppConfig, LogEntry } from '../../src/renderer/src/stores/appStore'

function errorLog(message: string): LogEntry
{
  return { timestamp: '2026-10-16T10:00:00.000Z', level: 'error', message }
}

describe('appStore log filter', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState(useAppStore.getInitialState())
  })

  it('starts unfiltered', () =>
  {
    expect(useAppStore.getState().logFilter).toBeNull()
  })

  it('showLog sets a job filter and switches to Logs', () =>
  {
    useAppStore.getState().setView('batch')
    useAppStore.getState().showLog({ jobId: 'job-7' })
    const state = useAppStore.getState()
    expect(state.logFilter).toEqual({ jobId: 'job-7' })
    expect(state.currentView).toBe('logs')
    expect(state.viewHistory).toEqual(['dashboard', 'batch'])
  })

  it('showLog accepts a run filter and replaces an earlier one', () =>
  {
    useAppStore.getState().showLog({ jobId: 'job-7' })
    useAppStore.getState().showLog({ runId: 'run-31' })
    const state = useAppStore.getState()
    expect(state.logFilter).toEqual({ runId: 'run-31' })
    expect(state.viewHistory).toEqual(['dashboard'])
  })

  it('showLog(null) opens Logs unfiltered', () =>
  {
    useAppStore.getState().showLog({ runId: 'run-31' })
    useAppStore.getState().showLog(null)
    expect(useAppStore.getState().logFilter).toBeNull()
    expect(useAppStore.getState().currentView).toBe('logs')
  })

  it('showLog marks the current errors seen, as opening Logs does', () =>
  {
    useAppStore.getState().addLog(errorLog('one'))
    useAppStore.getState().addLog(errorLog('two'))
    useAppStore.getState().showLog({ jobId: 'job-1' })
    expect(useAppStore.getState().lastSeenErrorCount).toBe(2)
  })

  it('clearLogFilter removes the filter and stays on Logs', () =>
  {
    useAppStore.getState().showLog({ jobId: 'job-7' })
    useAppStore.getState().clearLogFilter()
    expect(useAppStore.getState().logFilter).toBeNull()
    expect(useAppStore.getState().currentView).toBe('logs')
  })

  it('leaves the filter alone on ordinary navigation and log clearing', () =>
  {
    useAppStore.getState().showLog({ runId: 'run-2' })
    useAppStore.getState().setView('batch')
    useAppStore.getState().clearLogs()
    useAppStore.getState().goBack()
    expect(useAppStore.getState().logFilter).toEqual({ runId: 'run-2' })
    expect(useAppStore.getState().currentView).toBe('logs')
  })

  it('keeps setView behavior: history, duplicates, and seen errors', () =>
  {
    useAppStore.getState().addLog(errorLog('one'))
    useAppStore.getState().setView('batch')
    useAppStore.getState().setView('batch')
    expect(useAppStore.getState().viewHistory).toEqual(['dashboard'])
    expect(useAppStore.getState().lastSeenErrorCount).toBe(0)
    useAppStore.getState().setView('logs')
    expect(useAppStore.getState().lastSeenErrorCount).toBe(1)
    expect(useAppStore.getState().logFilter).toBeNull()
  })
})

describe('AppConfig.announceProgress', () =>
{
  it('reads as false when a stored config predates it', () =>
  {
    const stored = { sidebarCollapsed: false } as AppConfig
    useAppStore.getState().setConfig(stored)
    expect(useAppStore.getState().config?.announceProgress ?? false).toBe(false)
  })

  it('carries an explicit value through setConfig', () =>
  {
    const stored = { sidebarCollapsed: false, announceProgress: true } as AppConfig
    useAppStore.getState().setConfig(stored)
    expect(useAppStore.getState().config?.announceProgress).toBe(true)
  })
})

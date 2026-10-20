/**
 * The Batch view's actions as React context. The page's provider binds createBatchActions to the window's stores,
 * toasts, and live region; every region reads the actions through useBatchActions(). TestBatchActionsProvider binds
 * them to fresh stores and an engine surface that answers only the commands a test supplies, so a region can be
 * rendered on its own.
 */
import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { StoreApi } from 'zustand'
import { JOB_COMMAND_NAMES, type CommandResult, type JobsApi } from '../../../../shared/jobs/contract'
import
{
  createBatchActions,
  type BatchActions,
  type BatchActionsDeps,
  type BatchToast,
  type Politeness
} from '../../stores/batchActions'
import { createBatchViewStore, type BatchViewState } from '../../stores/batchView'
import { createJobsStore, type JobsState } from '../../stores/jobs'

/** The Batch view's actions; null outside a provider. */
export const BatchActionsContext = createContext<BatchActions | null>(null)

/** The Batch view's actions from the nearest provider. */
export function useBatchActions(): BatchActions
{
  const actions = useContext(BatchActionsContext)
  if (actions === null)
  {
    throw new Error('useBatchActions needs a provider of BatchActionsContext.')
  }
  return actions
}

/** What an engine command the test did not supply answers. */
export const INERT_COMMAND_MESSAGE = 'This command is not available here.'

/** An engine surface whose commands are refused unless supplied, and whose events never arrive. */
export function inertJobsApi(commands: Partial<JobsApi> = {}): JobsApi
{
  const refuse = async (): Promise<CommandResult<never>> =>
    ({ ok: false, error: { code: 'internal', message: INERT_COMMAND_MESSAGE, issues: [], details: null } })
  const inert = Object.fromEntries(JOB_COMMAND_NAMES.map((name) => [name, refuse]))
  return { ...inert, onEvents: () => () => undefined, ...commands } as JobsApi
}

/** What a test supplies; everything has an inert default. */
export interface TestBatchActionsOptions
{
  /** The engine commands the test answers; the rest are refused. */
  api?: Partial<JobsApi>
  jobs?: StoreApi<JobsState>
  view?: StoreApi<BatchViewState>
  notify?: (toast: BatchToast) => void
  announce?: (message: string, politeness?: Politeness) => void
  drafts?: BatchActionsDeps['drafts']
  schedule?: BatchActionsDeps['schedule']
  revealPath?: BatchActionsDeps['revealPath']
  /** Single actions replaced outright, such as a spy for Start. */
  overrides?: Partial<BatchActions>
}

/** Real actions over fresh stores and an inert engine surface, with the test's commands and overrides. */
export function createTestBatchActions(options: TestBatchActionsOptions = {}): BatchActions
{
  const actions = createBatchActions({
    api: inertJobsApi(options.api),
    jobs: options.jobs ?? createJobsStore(),
    view: options.view ?? createBatchViewStore({ storage: null }),
    notify: options.notify ?? (() => undefined),
    announce: options.announce ?? (() => undefined),
    drafts: options.drafts,
    schedule: options.schedule,
    revealPath: options.revealPath
  })
  return { ...actions, ...options.overrides }
}

/** Props of the test provider: given actions as they are, or test actions built once from the options. */
export interface TestBatchActionsProviderProps extends TestBatchActionsOptions
{
  actions?: BatchActions
  children?: ReactNode
}

/** Provides actions for a region under test; actions it built are disposed when it unmounts. */
export function TestBatchActionsProvider({ actions, children, ...options }: TestBatchActionsProviderProps): React.JSX.Element
{
  const [owned] = useState(() => (actions === undefined ? createTestBatchActions(options) : null))
  useEffect(() => () => owned?.dispose(), [owned])
  return <BatchActionsContext.Provider value={actions ?? owned}>{children}</BatchActionsContext.Provider>
}
